#!/usr/bin/env node
// T5.1 test 4 — Crash recovery (live testnet, real spend): kill the process
// between add() and flush() -> next open() restores with exactly <=1 turn
// missing.
//
// Spawns scripts/worker-crash-child.mjs as a real child process. The child
// adds+flushes two turns (awaiting each flush to confirm it landed), then
// adds a THIRD turn and prints READY_TO_KILL without ever calling flush()
// for it. The parent SIGKILLs the child the instant it sees that line —
// this is a genuine hard process kill, not a simulated one. A fresh
// DmemoSession.open() in the parent must then show turn1+turn2 present and
// turn3 absent (i.e. <=1 turn missing).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { DmemoSession } from '@dmemo/core';
import {
  makeReporter,
  fundEphemeralWallet,
  getBalance,
  fmtEther,
  recordSpend,
  recordLatencySample,
} from '../lib/common.mjs';
import { TURN1, TURN2, TURN3 } from '../lib/crash-fixtures.mjs';

// NOTE: common.mjs's exported __dirname resolves to lib/ (its own file
// location), not scripts/ — do not reuse it here for a scripts/-relative
// path. worker-crash-child.mjs lives alongside this file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_NAME = 'crash-recovery';
const r = makeReporter(TEST_NAME);
const SCOPE = 't5.1-crash-recovery';

function runChildUntilReady(env) {
  return new Promise((resolve, reject) => {
    const childPath = path.join(__dirname, 'worker-crash-child.mjs');
    const child = spawn(process.execPath, [childPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let killed = false;
    let stderr = '';
    const timeout = setTimeout(() => {
      if (!killed) {
        child.kill('SIGKILL');
        reject(new Error('worker-crash-child did not print READY_TO_KILL within 60s'));
      }
    }, 60_000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (!killed && text.includes('READY_TO_KILL')) {
        killed = true;
        clearTimeout(timeout);
        // Kill the instant we see the signal — strictly between the child's
        // final add() and any flush() for that turn.
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('exit', (code, signal) => {
      resolve({ killed, code, signal, stderr });
    });
    child.on('error', reject);
  });
}

async function main() {
  r.section('SETUP: fund ephemeral wallet');
  const FUND_ETHER = '0.03';
  const { privateKey, address, provider } = await fundEphemeralWallet(FUND_ETHER, { reporter: r });
  const pointerCachePath = `/tmp/dmemo-it-${Date.now()}-${Math.random().toString(36).slice(2)}-crash-pointer-cache.json`;

  r.section('STEP 1: spawn worker, let it flush turn1+turn2, add turn3 (no flush), SIGKILL on signal');
  const childEnv = {
    ...process.env,
    DMEMO_TEST_PRIVATE_KEY: privateKey, // never logged
    DMEMO_TEST_SCOPE: SCOPE,
    DMEMO_TEST_POINTER_CACHE: pointerCachePath,
  };
  const t0 = performance.now();
  const result = await runChildUntilReady(childEnv);
  const childLifetimeMs = performance.now() - t0;

  if (!result.killed) {
    r.fail(`worker never reached READY_TO_KILL (exit code ${result.code}, signal ${result.signal}). stderr: ${result.stderr.slice(0, 2000)}`);
    return r.summary();
  }
  if (result.signal !== 'SIGKILL') {
    r.fail(`expected the child to die by SIGKILL, got signal=${result.signal} code=${result.code}`);
  } else {
    r.pass(`worker SIGKILLed after ${childLifetimeMs.toFixed(0)}ms, strictly between turn3's add() and its (never-issued) flush()`);
  }

  r.section('STEP 2: reopen in the parent — restore should show turn1+turn2, NOT turn3');
  const t1 = performance.now();
  const session = await DmemoSession.open({ privateKey, scope: SCOPE, network: 'testnet', pointerCachePath });
  const openMs = performance.now() - t1;
  recordLatencySample({ kind: 'open-restore', ms: openMs, test: TEST_NAME });

  if (!session.restoreStats.restored) {
    r.fail('expected restoreStats.restored=true after two confirmed flushes from the worker');
  } else {
    r.pass(`restored in ${openMs.toFixed(0)}ms (chainLength ${session.restoreStats.chainLength}, restoreStats=${JSON.stringify(session.restoreStats)})`);
  }

  const all = await session.memory.getAll({ filters: { user_id: SCOPE }, topK: 50 });
  const texts = all.results.map((m) => m.memory);
  const hasTurn1 = texts.some((t) => t.includes('verifyJwt.ts'));
  const hasTurn2 = texts.some((t) => t.includes('idleTimeoutMillis'));
  const hasTurn3 = texts.some((t) => t.includes('express-rate-limit'));

  if (hasTurn1) r.pass('turn1 (flushed) is present after restore');
  else r.fail('turn1 (flushed) is MISSING after restore — should have survived');

  if (hasTurn2) r.pass('turn2 (flushed) is present after restore');
  else r.fail('turn2 (flushed) is MISSING after restore — should have survived');

  const missingCount = (hasTurn1 ? 0 : 1) + (hasTurn2 ? 0 : 1) + (hasTurn3 ? 0 : 1);
  if (hasTurn3) {
    r.fail('turn3 (never flushed, killed before flush()) is PRESENT after restore — crash-recovery contract violated (should have been lost, not silently persisted)');
  } else {
    r.pass('turn3 (never flushed) is correctly ABSENT after restore');
  }

  if (missingCount <= 1) {
    r.pass(`restore missing count = ${missingCount} turn(s) out of 3 (<=1 missing, as required)`);
  } else {
    r.fail(`restore missing count = ${missingCount} turn(s) out of 3 (> 1 missing — crash recovery contract violated)`);
  }

  await session.close();

  r.section('SUMMARY');
  const remaining = await getBalance(provider, address);
  const fundedWei = ethers.parseEther(FUND_ETHER);
  const entry = recordSpend({ test: TEST_NAME, address, fundedWei, remainingWei: remaining });
  console.log(`ephemeral wallet ${address}: funded ${entry.fundedEther} 0G, remaining ${entry.remainingEther} 0G, spent ${entry.spentEther} 0G`);

  return r.summary();
}

main().catch((err) => {
  r.fail(`uncaught error: ${err && err.stack ? err.stack : err}`);
  r.summary();
});
