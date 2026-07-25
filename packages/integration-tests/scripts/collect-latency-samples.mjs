#!/usr/bin/env node
// T5.3 support script (not a correctness test): repeatedly flush + close +
// reopen a single ephemeral-wallet session to accumulate >=10 timed samples
// each of session-open restore and flush duration/cost, for the P50/P95
// latency table in docs/benchmarks.md. One iteration's reopen is forced
// "cold" (pointer cache file deleted first) to get at least one genuine
// full-eth_getLogs-scan sample alongside the warm-cache ones.
//
// Run: node scripts/collect-latency-samples.mjs

import fs from 'node:fs';
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

const TEST_NAME = 'latency-collector';
const r = makeReporter(TEST_NAME);
const SCOPE = 't5.3-latency-collector';
const ITERATIONS = 10;
const FORCE_COLD_AT_ITERATION = Math.floor(ITERATIONS / 2);

async function main() {
  r.section('SETUP: fund ephemeral wallet');
  const FUND_ETHER = '0.05';
  const { privateKey, address, provider } = await fundEphemeralWallet(FUND_ETHER, { reporter: r });
  const pointerCachePath = `/tmp/dmemo-it-${Date.now()}-${Math.random().toString(36).slice(2)}-latency-pointer-cache.json`;

  const openOpts = { privateKey, scope: SCOPE, network: 'testnet', pointerCachePath };

  const t0 = performance.now();
  let session = await DmemoSession.open(openOpts);
  const openFreshMs = performance.now() - t0;
  recordLatencySample({ kind: 'open-fresh', ms: openFreshMs, test: TEST_NAME });
  r.pass(`iteration 0: fresh open in ${openFreshMs.toFixed(0)}ms (restored=${session.restoreStats.restored})`);

  for (let i = 0; i < ITERATIONS; i++) {
    await session.memory.add(
      `Latency-collector fixture turn ${i}: sample fact #${i} for restore/flush timing (not a correctness assertion).`,
      { userId: SCOPE, infer: false }
    );
    session.flush();
    await session.waitForPendingFlush();
    const flush = session.flushLog.at(-1);
    if (!flush) {
      r.fail(`iteration ${i}: no flush recorded`);
      continue;
    }
    recordLatencySample({ kind: `flush-${flush.kind}`, ms: flush.uploadMs, costWei: flush.costWei, bytes: flush.bytes, test: TEST_NAME });
    r.pass(`iteration ${i}: flush -> ${flush.kind}, ${flush.uploadMs.toFixed(0)}ms, ${fmtEther(flush.costWei)} 0G`);

    await session.close();

    let coldTag = 'warm';
    if (i === FORCE_COLD_AT_ITERATION) {
      try {
        fs.unlinkSync(pointerCachePath);
        coldTag = 'cold';
      } catch (e) {
        r.fail(`could not delete pointer cache to force a cold sample: ${e.message}`);
      }
    }

    const tOpen = performance.now();
    session = await DmemoSession.open(openOpts);
    const openMs = performance.now() - tOpen;
    if (!session.restoreStats.restored) {
      r.fail(`iteration ${i}: reopen did not restore (expected restored=true after a real flush)`);
    }
    recordLatencySample({ kind: `open-restore-${coldTag}`, ms: openMs, test: TEST_NAME });
    r.pass(`iteration ${i}: reopen (${coldTag}) in ${openMs.toFixed(0)}ms, chainLength=${session.restoreStats.chainLength}`);
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
