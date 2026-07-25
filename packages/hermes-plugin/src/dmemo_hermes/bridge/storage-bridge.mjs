#!/usr/bin/env node
/**
 * Storage bridge for the Python dMemo provider (v1.1 / Hermes).
 *
 * The dMemo memory engine on Python is genuinely native — mem0 OSS runs
 * in-process, the journaling vector store, the blob codec and the session
 * orchestration are all Python (D16: dual-native SDKs, the blob spec is the
 * cross-language contract). The one leg that is NOT native is the 0G
 * transport, because there is no 0G Python SDK: doing it natively would mean
 * reimplementing the 0G Merkle chunk scheme, FixedPriceFlow submission,
 * segment upload, ECIES and Submit-log pointer resolution from scratch — the
 * exact code path that has to be byte-perfect or the memory is unreadable.
 *
 * So the transport is a seam (``StorageTransport`` in transport.py) and this
 * process is its first implementation: a long-lived Node child speaking
 * line-delimited JSON, delegating to the same `@dmemo/core` `StorageClient`
 * the TypeScript hosts use in production. Replacing it with a pure-Python
 * transport later changes nothing above the seam.
 *
 * Protocol — one JSON object per line, both directions:
 *   ->  {"id":1,"op":"upload","plaintextB64":"..."}
 *   <-  {"id":1,"ok":true,"result":{...}}
 *   <-  {"id":1,"ok":false,"error":{"name":"...","message":"...","reason":"..."}}
 *
 * Errors keep their class name and `reason` so the Python side can preserve
 * the transient / unretrievable / corrupt distinction that restore's
 * refuse-don't-degrade rule depends on (F6).
 */

import readline from 'node:readline';
import {
  StorageClient,
  resolveNetworkConfig,
  BlobUnretrievableError,
} from '@dmemo/core';

let client = null;

function serializeError(e) {
  const out = { name: e?.name ?? 'Error', message: e?.message ?? String(e) };
  if (e instanceof BlobUnretrievableError) out.reason = e.reason;
  return out;
}

const ops = {
  init(req) {
    const network = resolveNetworkConfig(req.network ?? 'testnet', req.networkOverrides ?? {});
    client = new StorageClient({
      network,
      privateKey: req.privateKey,
      pointerCachePath: req.pointerCachePath,
      uploadTimeoutMs: req.uploadTimeoutMs,
      downloadTimeoutMs: req.downloadTimeoutMs,
    });
    return { address: client.address, network: network.network, rpcUrl: network.rpcUrl, indexerUrl: network.indexerUrl };
  },

  async balance() {
    return { wei: (await client.getBalanceWei()).toString() };
  },

  async upload(req) {
    const plaintext = Buffer.from(req.plaintextB64, 'base64');
    const r = await client.upload(plaintext);
    return {
      txHash: r.txHash,
      rootHash: r.rootHash,
      txSeq: r.txSeq,
      uploadMs: r.uploadMs,
      costWei: r.costWei.toString(),
      bytes: plaintext.length,
    };
  },

  async download(req) {
    const r = await client.downloadAndVerify(req.rootHash);
    return {
      plaintextB64: Buffer.from(r.plaintext).toString('base64'),
      downloadMs: r.downloadMs,
      verifyMs: r.verifyMs,
      decryptMs: r.decryptMs,
    };
  },

  async candidates(req) {
    const list = await client.resolveCandidates(req.max ?? undefined);
    return { candidates: list };
  },

  savePointer(req) {
    client.savePointer({ rootHash: req.rootHash, txSeq: req.txSeq, blockNumber: req.blockNumber });
    return { saved: true };
  },
};

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: serializeError(e) }) + '\n');
    return;
  }
  const handler = ops[req.op];
  if (!handler) {
    process.stdout.write(
      JSON.stringify({ id: req.id, ok: false, error: { name: 'UnknownOp', message: `unknown op: ${req.op}` } }) + '\n'
    );
    return;
  }
  try {
    if (req.op !== 'init' && !client) throw new Error('bridge not initialized (send op:init first)');
    const result = await handler(req);
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: serializeError(e) }) + '\n');
  }
});

rl.on('close', () => process.exit(0));

// The SDK's own progress chatter would corrupt the line protocol if it ever
// reached stdout; keep stdout exclusively for protocol frames.
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.info = console.log;

process.stderr.write('[dmemo-bridge] ready\n');
