#!/usr/bin/env node
// T5.1 test 5 — Checkpoint consolidation (live testnet, real spend): force
// K=2 flushes -> verify the next open() downloads 1 checkpoint + 0 deltas.
// Asserted via restoreStats.chainLength (must be exactly 1) and flushLog
// (flush #1 must be "delta", flush #2 must be "checkpoint" — the K=2
// consolidation reset).

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

const TEST_NAME = 'checkpoint-consolidation';
const r = makeReporter(TEST_NAME);
const SCOPE = 't5.1-checkpoint-consolidation';

async function main() {
  r.section('SETUP: fund ephemeral wallet');
  const FUND_ETHER = '0.03';
  const { privateKey, address, provider } = await fundEphemeralWallet(FUND_ETHER, { reporter: r });
  const pointerCachePath = `/tmp/dmemo-it-${Date.now()}-${Math.random().toString(36).slice(2)}-ckpt-pointer-cache.json`;

  r.section('STEP 1: open fresh session with checkpointEveryNFlushes=2 (force K=2)');
  const openOpts = { privateKey, scope: SCOPE, network: 'testnet', pointerCachePath, checkpointEveryNFlushes: 2 };
  const t0 = performance.now();
  const session1 = await DmemoSession.open(openOpts);
  const openMs = performance.now() - t0;
  recordLatencySample({ kind: 'open-fresh', ms: openMs, test: TEST_NAME });
  if (session1.restoreStats.restored) {
    r.fail('expected a fresh (unrestored) session for a brand-new wallet');
  } else {
    r.pass(`fresh session opened in ${openMs.toFixed(0)}ms (restored=false, as expected)`);
  }

  r.section('STEP 2: flush #1 (delta, K=2 not yet reached)');
  await session1.memory.add('Checkpoint-consolidation test turn 1: onboarding doc lives in docs/onboarding.md.', {
    userId: SCOPE,
    infer: false,
  });
  session1.flush();
  await session1.waitForPendingFlush();
  const flush1 = session1.flushLog.at(-1);
  if (!flush1) {
    r.fail('no flush recorded after flush #1');
  } else {
    r.pass(`flush #1 -> ${flush1.kind} (${flush1.uploadMs.toFixed(0)}ms, ${flush1.bytes}B, ${fmtEther(flush1.costWei)} 0G)`);
    if (flush1.kind !== 'delta') r.fail(`expected flush #1 kind "delta", got "${flush1.kind}"`);
    recordLatencySample({ kind: 'flush-delta', ms: flush1.uploadMs, costWei: flush1.costWei, bytes: flush1.bytes, test: TEST_NAME });
  }

  r.section('STEP 3: flush #2 (forces K=2 checkpoint consolidation)');
  await session1.memory.add('Checkpoint-consolidation test turn 2: staging env uses a scaled-down replica set.', {
    userId: SCOPE,
    infer: false,
  });
  session1.flush();
  await session1.waitForPendingFlush();
  const flush2 = session1.flushLog.at(-1);
  if (!flush2) {
    r.fail('no flush recorded after flush #2');
  } else {
    r.pass(`flush #2 -> ${flush2.kind} (${flush2.uploadMs.toFixed(0)}ms, ${flush2.bytes}B, ${fmtEther(flush2.costWei)} 0G)`);
    if (flush2.kind !== 'checkpoint') r.fail(`expected flush #2 kind "checkpoint" (K=2 reached), got "${flush2.kind}"`);
    recordLatencySample({ kind: 'flush-checkpoint', ms: flush2.uploadMs, costWei: flush2.costWei, bytes: flush2.bytes, test: TEST_NAME });
  }

  await session1.close();

  r.section('STEP 4: reopen — must download exactly 1 checkpoint + 0 deltas');
  const t1 = performance.now();
  const session2 = await DmemoSession.open(openOpts);
  const reopenMs = performance.now() - t1;
  recordLatencySample({ kind: 'open-restore', ms: reopenMs, test: TEST_NAME });

  if (!session2.restoreStats.restored) {
    r.fail('expected session2 to restore from the chain written by session1');
  } else if (session2.restoreStats.chainLength !== 1) {
    r.fail(
      `expected restoreStats.chainLength=1 (a single checkpoint, 0 deltas), got ${session2.restoreStats.chainLength} — checkpoint consolidation did not reset the delta chain`
    );
  } else {
    r.pass(
      `reopen in ${reopenMs.toFixed(0)}ms downloaded exactly 1 blob (chainLength=1) — confirmed the walk terminated at a single checkpoint with 0 trailing deltas`
    );
  }

  const all = await session2.memory.getAll({ filters: { user_id: SCOPE }, topK: 10 });
  const texts = all.results.map((m) => m.memory);
  if (texts.some((t) => t.includes('onboarding.md')) && texts.some((t) => t.includes('replica set'))) {
    r.pass('both pre-checkpoint turns are present after restoring from the consolidated checkpoint');
  } else {
    r.fail(`expected both turns present after checkpoint restore, got: ${JSON.stringify(texts)}`);
  }

  await session2.close();

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
