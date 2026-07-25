#!/usr/bin/env node
// T5.1 test 3 — Pointer resolution (live testnet, real spend):
//   1. cold resolve with NO cache (forces the paginated eth_getLogs path)
//   2. warm resolve WITH cache (same wallet, cache populated by an upload)
//   3. resolve again after a fresh write (must return the NEW rootHash, not stale)

import { ethers } from 'ethers';
import { StorageClient } from '@dmemo/core';
import { encodeBlob, SPEC_VERSION } from '@dmemo/blob-spec';
import {
  makeReporter,
  fundEphemeralWallet,
  getBalance,
  fmtEther,
  recordSpend,
  recordLatencySample,
  TESTNET_NETWORK_CONFIG,
} from '../lib/common.mjs';

const TEST_NAME = 'pointer';
const r = makeReporter(TEST_NAME);

function tmpCachePath(tag) {
  return `/tmp/dmemo-it-${Date.now()}-${Math.random().toString(36).slice(2)}-${tag}-pointer-cache.json`;
}

function makeBlob(walletAddress, seq, prevRootHash) {
  return {
    kind: 'delta',
    meta: {
      specVersion: SPEC_VERSION,
      walletAddress,
      agentScope: 't5.1-pointer',
      seq,
      prevRootHash,
      embedder: { provider: 'fastembed', model: 'test-fixture', dim: 4 },
      engine: { name: 'mem0-oss', version: 'test-fixture' },
      createdAt: new Date().toISOString(),
    },
    vectorOps: [],
    historyEntries: [],
  };
}

async function main() {
  r.section('SETUP: fund ephemeral wallet');
  const FUND_ETHER = '0.03';
  const { privateKey, address, provider } = await fundEphemeralWallet(FUND_ETHER, { reporter: r });

  const cachePathA = tmpCachePath('warm');
  const storageA = new StorageClient({ network: TESTNET_NETWORK_CONFIG, privateKey, pointerCachePath: cachePathA });

  r.section('STEP 1: first write (populates chain + storageA cache)');
  const blob1 = makeBlob(storageA.address, 0, null);
  const up1 = await storageA.upload(encodeBlob(blob1));
  r.pass(`wrote blob1 -> rootHash ${up1.rootHash} (${up1.uploadMs.toFixed(0)}ms, ${fmtEther(up1.costWei)} 0G)`);
  recordLatencySample({ kind: 'flush-delta', ms: up1.uploadMs, costWei: up1.costWei, test: TEST_NAME });

  r.section('STEP 2: cold resolve — a SECOND StorageClient instance, same wallet, brand-new (nonexistent) pointer cache file');
  const cachePathB = tmpCachePath('cold');
  const storageB = new StorageClient({ network: TESTNET_NETWORK_CONFIG, privateKey, pointerCachePath: cachePathB });
  const t0 = performance.now();
  const coldPointer = await storageB.resolveLatest();
  const coldMs = performance.now() - t0;
  if (!coldPointer) {
    r.fail('cold resolveLatest() (no cache) returned null — expected to find blob1 via full eth_getLogs scan');
  } else if (coldPointer.rootHash.toLowerCase() !== up1.rootHash.toLowerCase()) {
    r.fail(`cold resolve returned ${coldPointer.rootHash}, expected ${up1.rootHash}`);
  } else {
    r.pass(`cold resolve (no cache, paginated eth_getLogs) found blob1's rootHash in ${coldMs.toFixed(0)}ms`);
  }

  r.section('STEP 3: warm resolve — storageA, cache already populated by its own upload() call');
  const t1 = performance.now();
  const warmPointer = await storageA.resolveLatest();
  const warmMs = performance.now() - t1;
  if (!warmPointer) {
    r.fail('warm resolveLatest() (cache present) returned null');
  } else if (warmPointer.rootHash.toLowerCase() !== up1.rootHash.toLowerCase()) {
    r.fail(`warm resolve returned ${warmPointer.rootHash}, expected ${up1.rootHash}`);
  } else {
    r.pass(`warm resolve (cache present) found blob1's rootHash in ${warmMs.toFixed(0)}ms (cold was ${coldMs.toFixed(0)}ms)`);
  }

  r.section('STEP 4: fresh write, then resolve again — must return the NEW rootHash');
  const blob2 = makeBlob(storageA.address, 1, up1.rootHash);
  const up2 = await storageA.upload(encodeBlob(blob2));
  r.pass(`wrote blob2 -> rootHash ${up2.rootHash} (${up2.uploadMs.toFixed(0)}ms, ${fmtEther(up2.costWei)} 0G)`);
  recordLatencySample({ kind: 'flush-delta', ms: up2.uploadMs, costWei: up2.costWei, test: TEST_NAME });

  const freshPointer = await storageA.resolveLatest();
  if (!freshPointer) {
    r.fail('resolveLatest() after fresh write returned null');
  } else if (freshPointer.rootHash.toLowerCase() === up1.rootHash.toLowerCase()) {
    r.fail('resolveLatest() after fresh write returned the STALE (blob1) rootHash — pointer resolution did not pick up the new write');
  } else if (freshPointer.rootHash.toLowerCase() !== up2.rootHash.toLowerCase()) {
    r.fail(`resolveLatest() after fresh write returned an unexpected rootHash ${freshPointer.rootHash}`);
  } else {
    r.pass(`resolveLatest() after fresh write correctly returned blob2's NEW rootHash ${freshPointer.rootHash}`);
  }

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
