#!/usr/bin/env node
// c2-blob.mjs — encrypted-memory round-trip smoke test for dMemo.
// Validates decisions D2 (0G log-layer storage of encrypted blobs),
// D8 (eth_getLogs pointer resolution by sender, no local record),
// D9 (self-verify Merkle root on download — the SDK's with_proof is a no-op).
//
// Steps 1-3 + local merkle check run unfunded. Steps 4-6 (upload / chain
// pointer resolution / download) are gated behind a non-zero balance check.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import {
  Indexer,
  MemData,
  FixedPriceFlow__factory,
} from '@0gfoundation/0g-ts-sdk';

// Testnet (Galileo, chain 16602) FixedPriceFlow contract address.
// Live-verified in research/followup-pointer-strategy.md (fetched via a
// storage node's zgs_getStatus -> networkIdentity.flowAddress). Not exposed
// anywhere in the installed SDK's public API, so it must be hardcoded here.
const FLOW_ADDRESS = '0x22e03a6a89b950f1c82ec5e74f8eca321a105296';
// Public RPC eth_getLogs block-range cap, per the same doc (binary-searched
// live: ~4.78M blocks). Stay comfortably under it.
const BLOCK_RANGE_CAP = 4_700_000;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Load .env manually (no dotenv dependency).
// ---------------------------------------------------------------------------
function loadEnv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const envPath = new URL('./.env', import.meta.url);
const env = loadEnv(envPath);
const { PRIVATE_KEY, ADDRESS, RPC, INDEXER } = env;
for (const key of ['PRIVATE_KEY', 'ADDRESS', 'RPC', 'INDEXER']) {
  if (!env[key]) fail(`missing ${key} in .env`);
}
console.log(`[1/6] PASS .env loaded (RPC=${RPC}, INDEXER=${INDEXER})`);

// ---------------------------------------------------------------------------
// 2. Build a dummy ~2KB memory blob and encrypt with AES-256-CTR.
// ---------------------------------------------------------------------------
function buildDummyMemoryBlob() {
  const entries = [];
  let i = 0;
  // keep growing until the serialized JSON is comfortably >= ~2KB
  while (JSON.stringify({ version: 1, agent: 'dmemo-spike', entries }).length < 2000) {
    entries.push({
      id: `mem-${i}`,
      ts: 1753400000000 + i * 1000,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Fake memory entry #${i} — the quick brown fox jumps over the lazy dog for padding.`,
      tags: ['dmemo', 'spike', 'c2-blob'],
    });
    i++;
  }
  return { version: 1, agent: 'dmemo-spike', entries };
}

const originalObj = buildDummyMemoryBlob();
const plaintext = Buffer.from(JSON.stringify(originalObj), 'utf8');

const aesKey = crypto.randomBytes(32); // AES-256, random per run, kept in memory only
const iv = crypto.randomBytes(16); // CTR nonce, kept in memory only
const cipher = crypto.createCipheriv('aes-256-ctr', aesKey, iv);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

console.log(
  `[2/6] PASS built dummy blob (${plaintext.length} bytes, ${originalObj.entries.length} entries) ` +
    `and encrypted with AES-256-CTR -> ${ciphertext.length} bytes`
);

// ---------------------------------------------------------------------------
// 3. Connect provider + wallet, print balance.
// ---------------------------------------------------------------------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

if (wallet.address.toLowerCase() !== ADDRESS.toLowerCase()) {
  console.warn(
    `[3/6] WARNING: derived address ${wallet.address} != ADDRESS in .env (${ADDRESS})`
  );
}

const network = await provider.getNetwork();
console.log(`[3/6] PASS connected to chain ${network.chainId} via ${RPC}`);

const balance = await provider.getBalance(wallet.address);
console.log(`[3/6] balance: ${ethers.formatEther(balance)} 0G (${wallet.address})`);

// ---------------------------------------------------------------------------
// Unfunded sanity check: local merkle root of the encrypted blob, using the
// same MemData + merkleTree() path the real upload will use.
// ---------------------------------------------------------------------------
const localProbeFile = new MemData(ciphertext);
const [localTree, localTreeErr] = await localProbeFile.merkleTree();
if (localTreeErr) fail(`local merkleTree() error: ${localTreeErr}`);
console.log(`[unfunded] PASS local merkle root of encrypted blob: ${localTree.rootHash()}`);

if (balance === 0n) {
  console.log(`\nFUND ME: ${wallet.address} via https://faucet.0g.ai`);
  console.log('Wallet has 0 balance — stopping before any funded (upload/gas) step.');
  console.log('Everything above (env, encryption, provider connect, local merkle root) ran unfunded and passed.');
  process.exit(0);
}

// ===========================================================================
// FUNDED PATH — everything below spends gas / storage fee.
// ===========================================================================
console.log('\n[4/6] wallet funded — uploading encrypted blob...');

const indexer = new Indexer(INDEXER);
const uploadFile = new MemData(ciphertext);

const [uploadResult, uploadErr] = await indexer.upload(uploadFile, RPC, wallet);
if (uploadErr) fail(`upload error: ${uploadErr}`);

const { txHash, rootHash } = uploadResult;
console.log(`[4/6] PASS upload — tx hash: ${txHash}`);
console.log(`[4/6] PASS upload — root hash: ${rootHash}`);

// Cost = gas fee (submit tx) + storage fee (pricePerSector * sectors, paid as msg.value).
try {
  const receipt = await provider.getTransactionReceipt(txHash);
  const tx = await provider.getTransaction(txHash);
  const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice;
  const gasCostWei = receipt.gasUsed * effectiveGasPrice;
  const storageFeeWei = tx.value; // storage fee is paid as msg.value on submit

  const totalWei = gasCostWei + storageFeeWei;
  console.log(
    `[4/6] cost — gas: ${ethers.formatEther(gasCostWei)} 0G, ` +
      `storage fee: ${ethers.formatEther(storageFeeWei)} 0G, ` +
      `total: ${ethers.formatEther(totalWei)} 0G`
  );
} catch (e) {
  console.warn(`[4/6] WARNING: could not compute cost breakdown: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 5. Pointer resolution WITHOUT any local record: eth_getLogs on the Flow
//    contract, filtered by our sender address, decode the Submit event.
// ---------------------------------------------------------------------------
console.log('\n[5/6] resolving latest root hash via eth_getLogs (no local record used)...');

const flowIface = new ethers.Interface(FixedPriceFlow__factory.abi);
const submitTopic = flowIface.getEvent('Submit').topicHash;
const senderTopic = ethers.zeroPadValue(wallet.address, 32);

const latestBlock = await provider.getBlockNumber();

async function getLogsPaginated() {
  let toBlock = latestBlock;
  let fromBlock = Math.max(0, latestBlock - BLOCK_RANGE_CAP);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await provider.getLogs({
        address: FLOW_ADDRESS,
        topics: [submitTopic, senderTopic],
        fromBlock,
        toBlock,
      });
    } catch (e) {
      // Range too wide for this RPC — shrink and retry.
      const span = toBlock - fromBlock;
      fromBlock = toBlock - Math.floor(span / 2);
      if (fromBlock >= toBlock) throw e;
    }
  }
  throw new Error('exhausted eth_getLogs range retries');
}

const logs = await getLogsPaginated();
if (logs.length === 0) fail('no Submit logs found for sender in the scanned block range');

logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
const latestLog = logs[logs.length - 1];
const decoded = flowIface.parseLog(latestLog);
// A submission can carry multiple merkle subtree nodes (any payload whose
// chunk count isn't a power of two), so nodes[0].root is NOT the file root.
// The canonical file root comes from the storage node, keyed by the
// submissionIndex (== storage-layer txSeq) that the event carries.
const txSeq = Number(decoded.args.submissionIndex);
const [selectedNodes, selectErr] = await indexer.selectNodes(1);
if (selectErr) fail(`selectNodes error: ${selectErr}`);
const fileInfo = await selectedNodes[0].getFileInfoByTxSeq(txSeq);
if (!fileInfo) fail(`storage node has no file info for txSeq ${txSeq}`);
const resolvedRootHash = fileInfo.tx.dataMerkleRoot;

console.log(`[5/6] found ${logs.length} Submit log(s) for sender; latest is block ${latestLog.blockNumber}`);
console.log(`[5/6] resolved root hash from chain: ${resolvedRootHash}`);

const rootFromUploadMatches = resolvedRootHash.toLowerCase() === rootHash.toLowerCase();
console.log(
  `[5/6] ${rootFromUploadMatches ? 'PASS' : 'FAIL'} — chain-resolved root hash matches indexer.upload()'s returned root hash`
);
if (!rootFromUploadMatches) fail('root hash mismatch between upload result and eth_getLogs resolution');

// ---------------------------------------------------------------------------
// 6. Download via indexer, recompute Merkle root locally (do NOT trust
//    with_proof — it's a documented no-op in this SDK), decrypt, deep-compare.
// ---------------------------------------------------------------------------
console.log('\n[6/6] downloading via indexer...');

const tmpPath = path.join(os.tmpdir(), `c2-blob-${Date.now()}.bin`);
// third arg `proof` is threaded through but unimplemented in this SDK
// (verified in research/followup-pointer-strategy.md, section c) — passing
// false explicitly to document that we are not relying on it.
const downloadErr = await indexer.download(resolvedRootHash, tmpPath, false);
if (downloadErr) fail(`download error: ${downloadErr}`);

const downloadedCiphertext = fs.readFileSync(tmpPath);
console.log(`[6/6] PASS downloaded ${downloadedCiphertext.length} bytes`);

const downloadedFile = new MemData(downloadedCiphertext);
const [dlTree, dlTreeErr] = await downloadedFile.merkleTree();
if (dlTreeErr) fail(`merkleTree() on downloaded bytes error: ${dlTreeErr}`);

const recomputedRoot = dlTree.rootHash();
const rootMatch = recomputedRoot.toLowerCase() === resolvedRootHash.toLowerCase();
console.log(
  `[6/6] ${rootMatch ? 'PASS' : 'FAIL'} — recomputed merkle root (${recomputedRoot}) ` +
    `matches on-chain root (${resolvedRootHash})`
);

let decryptedObj = null;
let deepEqual = false;
if (rootMatch) {
  const decipher = crypto.createDecipheriv('aes-256-ctr', aesKey, iv);
  const decrypted = Buffer.concat([decipher.update(downloadedCiphertext), decipher.final()]);
  try {
    decryptedObj = JSON.parse(decrypted.toString('utf8'));
    deepEqual = JSON.stringify(decryptedObj) === JSON.stringify(originalObj);
  } catch (e) {
    console.error(`FAIL: decrypted bytes are not valid JSON: ${e.message}`);
  }
  console.log(`[6/6] ${deepEqual ? 'PASS' : 'FAIL'} — decrypted blob deep-equals original JSON`);
} else {
  console.log('[6/6] FAIL — skipping decrypt/compare since merkle root did not match');
}

fs.unlinkSync(tmpPath);

const allPassed = rootFromUploadMatches && rootMatch && deepEqual;
console.log(allPassed ? '\n=== ALL CHECKS PASSED ===' : '\n=== SOME CHECKS FAILED ===');
process.exit(allPassed ? 0 : 1);
