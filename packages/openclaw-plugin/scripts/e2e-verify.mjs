#!/usr/bin/env node
// E2E verification (local only): independently proves the OpenClaw test's
// memories really live on 0G Storage, using a fresh process, a cold pointer
// cache, and NOTHING from the OpenClaw host.
//
//  1. Walks the on-chain pointer chain for the test wallet.
//  2. For each blob: downloads raw ciphertext, self-verifies the Merkle root
//     against the on-chain value (gotcha 1 — the SDK's `proof` flag is a
//     no-op), decrypts with the wallet key, decodes the blob envelope.
//  3. Greps the decoded plaintext for the test's key facts.
//  4. Confirms a WRONG key cannot read the content (D19: AES-CTR does not
//     throw on a bad key — `decodeBlob` is the authoritative signal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { StorageClient, decodeBlob, resolveNetworkConfig } from '@dmemo/core';

const HOME = process.env.HOME ?? os.homedir();
const envFile = path.join(HOME, '.dmemo', 'e2e-openclaw.env');
const env = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2))
);
const PRIVATE_KEY = env.DMEMO_PRIVATE_KEY;
const ADDRESS = env.DMEMO_ADDRESS;

const FACTS = [
  ['lab name', /Nimbus Rack/i],
  ['node names', /thistle.*bramble.*quince/is],
  ['zfs pool', /deepwell/i],
  ['raidz2', /raidz2/i],
  ['UPS model', /APC SMT1500/i],
  ['UPS runtime', /22 minutes/i],
  ['maintenance window', /Sundays? at 04:30 UTC/i],
  ['orchestrator', /Nomad and Consul/i],
  ['rationale', /32GB of RAM/i],
];

let failures = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  ✘ ${m}`);
};

async function main() {
  console.log(`\n=== 0G on-chain verification for ${ADDRESS} (fresh process, cold cache) ===\n`);

  // Explicitly no pointer cache: force a real on-chain log scan.
  const client = new StorageClient({
    privateKey: PRIVATE_KEY,
    network: resolveNetworkConfig('testnet'),
    pointerCachePath: path.join(os.tmpdir(), `dmemo-e2e-verify-${Date.now()}.json`),
  });

  console.log('STEP 1: resolve pointer chain from chain logs (no local cache)');
  const t0 = Date.now();
  const pointers = await client.resolveCandidates();
  console.log(`  resolved ${pointers.length} pointer(s) in ${Date.now() - t0}ms`);
  for (const p of pointers) console.log(`    txSeq=${p.txSeq} root=${p.rootHash}`);
  if (pointers.length === 0) bad('no on-chain pointers found for the test wallet');

  console.log('\nSTEP 2: download + Merkle self-verify + decrypt + decode each blob');
  const plaintexts = [];
  const chain = [];
  // Follow the chain from the newest pointer backwards via prevRootHash.
  let cursor = pointers[0]?.rootHash;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const { plaintext, downloadMs, verifyMs, decryptMs } = await client.downloadAndVerify(cursor);
    const blob = decodeBlob(plaintext);
    chain.push({ root: cursor, kind: blob.kind, seq: blob.meta.seq, bytes: plaintext.length });
    plaintexts.push(plaintext.toString('utf8'));
    ok(
      `${cursor.slice(0, 12)}… kind=${blob.kind} seq=${blob.meta.seq} ${plaintext.length}B ` +
        `(download ${Math.round(downloadMs)}ms, merkle-verify ${verifyMs.toFixed(1)}ms, decrypt ${decryptMs.toFixed(1)}ms)`
    );
    cursor = blob.meta?.prevRootHash ?? undefined;
  }
  console.log(`  chain length: ${chain.length} blob(s)`);

  console.log('\nSTEP 3: key facts present in the decrypted 0G bytes');
  const all = plaintexts.join('\n');
  for (const [label, re] of FACTS) {
    if (re.test(all)) ok(`${label}: found`);
    else bad(`${label}: NOT found in any decrypted blob`);
  }

  console.log('\nSTEP 4: a wrong key cannot read the content (gotcha 19)');
  const wrongKey = ethers.Wallet.createRandom().privateKey;
  const wrongClient = new StorageClient({
    privateKey: wrongKey,
    network: resolveNetworkConfig('testnet'),
    pointerCachePath: path.join(os.tmpdir(), `dmemo-e2e-wrong-${Date.now()}.json`),
  });
  try {
    const { plaintext } = await wrongClient.downloadAndVerify(chain[0].root);
    try {
      decodeBlob(plaintext);
      bad('wrong key DECODED the blob — confidentiality broken');
    } catch (err) {
      ok(`wrong key yields undecodable garbage (decodeBlob rejected: ${String(err).slice(0, 80)}…)`);
    }
  } catch (err) {
    ok(`wrong key rejected at download/verify: ${String(err).slice(0, 80)}…`);
  }

  console.log('\nSTEP 5: spend');
  const provider = new ethers.JsonRpcProvider('https://evmrpc-testnet.0g.ai');
  const bal = await provider.getBalance(ADDRESS);
  console.log(`  funded 0.05 0G, remaining ${ethers.formatEther(bal)} 0G ` +
    `(spent ${ethers.formatEther(ethers.parseEther('0.05') - bal)} 0G over ${chain.length} blobs)`);

  console.log(`\n=== ${failures === 0 ? 'PASS' : `FAIL (${failures} check(s))`} ===\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('verification ERROR:', err);
  process.exitCode = 1;
});
