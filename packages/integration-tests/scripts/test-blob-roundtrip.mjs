#!/usr/bin/env node
// T5.1 test 1 — Blob round-trip (live testnet, real spend):
//   encode -> encrypt+upload -> resolve -> download -> verify -> decrypt ->
//   decode == original.
//
// Exercises the exact primitives @dmemo/core's DmemoSession uses internally
// (StorageClient.upload / resolveLatest / downloadAndVerify, blob-spec's
// encodeBlob/decodeBlob) directly, at the blob-spec level, independent of
// mem0 — this is the most literal reading of T5.1 item 1.
//
// Run: node scripts/test-blob-roundtrip.mjs

import assert from 'node:assert/strict';
import { StorageClient } from '@dmemo/core';
import { SPEC_VERSION, encodeBlob, decodeBlob, packVector } from '@dmemo/blob-spec';
import { ethers } from 'ethers';
import {
  makeReporter,
  fundEphemeralWallet,
  getBalance,
  fmtEther,
  recordSpend,
  recordLatencySample,
  TESTNET_NETWORK_CONFIG,
} from '../lib/common.mjs';

const TEST_NAME = 'blob-roundtrip';
const r = makeReporter(TEST_NAME);

async function main() {
  r.section('SETUP: fund ephemeral wallet');
  const FUND_ETHER = '0.02';
  const { privateKey, address, provider } = await fundEphemeralWallet(FUND_ETHER, { reporter: r });

  const storage = new StorageClient({
    network: TESTNET_NETWORK_CONFIG,
    privateKey,
    // Isolated pointer cache so this test never touches ~/.dmemo's shared cache.
    pointerCachePath: `/tmp/dmemo-it-${Date.now()}-${Math.random().toString(36).slice(2)}-pointer-cache.json`,
  });

  r.section('STEP 1: construct + encode an original blob');
  const vector = packVector(Array.from({ length: 8 }, (_, i) => Math.sin(i) * 0.5));
  const originalBlob = {
    kind: 'delta',
    meta: {
      specVersion: SPEC_VERSION,
      walletAddress: storage.address,
      agentScope: 't5.1-blob-roundtrip',
      seq: 0,
      prevRootHash: null,
      embedder: { provider: 'fastembed', model: 'test-fixture', dim: 8 },
      engine: { name: 'mem0-oss', version: 'test-fixture' },
      createdAt: new Date().toISOString(),
    },
    vectorOps: [
      {
        op: 'insert',
        ids: ['mem-1', 'mem-2'],
        vectors: [vector, vector],
        payloads: [
          { memory: 'The auth middleware lives in middleware/verifyJwt.ts.', user_id: 't5.1-user' },
          { memory: 'Postgres pool max is 20 with idleTimeoutMillis 30000.', user_id: 't5.1-user' },
        ],
      },
    ],
    historyEntries: [
      [
        'hist-1',
        {
          id: 'hist-1',
          memory_id: 'mem-1',
          previous_value: null,
          new_value: 'The auth middleware lives in middleware/verifyJwt.ts.',
          action: 'ADD',
          created_at: new Date().toISOString(),
          updated_at: null,
          is_deleted: 0,
        },
      ],
    ],
  };

  const originalPlaintext = encodeBlob(originalBlob);
  r.pass(`encoded original blob (${originalPlaintext.length} bytes)`);

  r.section('STEP 2: encrypt + upload to 0G testnet');
  const t0 = performance.now();
  const uploadResult = await storage.upload(originalPlaintext);
  const uploadMs = performance.now() - t0;
  r.pass(
    `uploaded -> rootHash ${uploadResult.rootHash}, txSeq ${uploadResult.txSeq}, ${uploadMs.toFixed(0)}ms, cost ${fmtEther(uploadResult.costWei)} 0G`
  );
  recordLatencySample({ kind: 'flush-delta', ms: uploadMs, costWei: uploadResult.costWei, bytes: originalPlaintext.length, test: TEST_NAME });

  r.section('STEP 3: resolve latest pointer');
  const t1 = performance.now();
  const pointer = await storage.resolveLatest();
  const resolveMs = performance.now() - t1;
  if (!pointer) {
    r.fail('resolveLatest() returned null right after a successful upload');
  } else if (pointer.rootHash.toLowerCase() !== uploadResult.rootHash.toLowerCase()) {
    r.fail(`resolved rootHash ${pointer.rootHash} != uploaded rootHash ${uploadResult.rootHash}`);
  } else {
    r.pass(`resolved latest pointer -> ${pointer.rootHash} in ${resolveMs.toFixed(0)}ms`);
  }

  r.section('STEP 4: download -> Merkle self-verify -> decrypt');
  const dl = await storage.downloadAndVerify(uploadResult.rootHash);
  r.pass(
    `downloadAndVerify succeeded (download ${dl.downloadMs.toFixed(0)}ms, verify ${dl.verifyMs.toFixed(1)}ms, decrypt ${dl.decryptMs.toFixed(1)}ms) — Merkle root matched on-chain root, decrypt succeeded`
  );

  r.section('STEP 5: decode -> compare to original');
  const decoded = decodeBlob(dl.plaintext);
  try {
    assert.deepStrictEqual(decoded, originalBlob);
    r.pass('decoded blob deep-equals the original blob (encode->encrypt->upload->resolve->download->verify->decrypt->decode round-trip == original)');
  } catch (e) {
    r.fail(`decoded blob differs from original: ${e.message}`);
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
