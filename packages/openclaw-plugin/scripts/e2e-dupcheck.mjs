#!/usr/bin/env node
// E2E follow-up (local only): quantify how many DISTINCT memories the
// OpenClaw run actually stored vs how many rows the checkpoint carries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StorageClient, decodeBlob, resolveNetworkConfig } from '@dmemo/core';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: e2e-dupcheck.mjs <checkpoint-root-hash>');

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(os.homedir(), '.dmemo', 'e2e-openclaw.env'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(/=(.*)/s).slice(0, 2))
);

const client = new StorageClient({
  privateKey: env.DMEMO_PRIVATE_KEY,
  network: resolveNetworkConfig('testnet'),
  pointerCachePath: path.join(os.tmpdir(), `dmemo-dupcheck-${Date.now()}.json`),
});

const { plaintext } = await client.downloadAndVerify(ROOT);
const blob = decodeBlob(plaintext);

console.log('blob keys:', Object.keys(blob));
console.log('meta:', JSON.stringify(blob.meta));
for (const k of Object.keys(blob)) {
  if (Array.isArray(blob[k])) {
    console.log(`  ${k}: ${blob[k].length} entries, row keys=`, Object.keys(blob[k][0] ?? {}));
  }
}

const rows = blob.vectors ?? [];
const texts = rows
  .map((r) => r.payload?.data ?? r.payload?.memory ?? r.metadata?.data ?? r.data ?? null)
  .filter((t) => typeof t === 'string');

console.log(`\nvector rows: ${rows.length}, rows with recoverable text: ${texts.length}`);
if (texts.length === 0 && rows.length > 0) {
  console.log(
    'sample row:',
    JSON.stringify(rows[0], (k, v) => (k === 'vector' || k === 'embedding' ? '<f32[]>' : v)).slice(0, 900)
  );
}

const norm = (t) => t.replace(/\s+/g, ' ').trim();
const counts = new Map();
for (const t of texts) {
  const k = norm(t).slice(0, 80);
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
console.log(`distinct memories: ${counts.size}`);
console.log('\ncopies | first 80 chars');
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), '|', k);

const nested = texts.filter((t) => /Relevant memories from prior sessions/.test(t)).length;
console.log(`\nrows that themselves contain an injected recall block: ${nested}/${texts.length}`);
