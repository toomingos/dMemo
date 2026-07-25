#!/usr/bin/env node
// Phase 1 live smoke test for @dmemo/core against the 0G testnet (Galileo).
//
// SECURITY: never prints, echoes, or logs the funding private key (from
// spike/.env) anywhere. A fresh throwaway wallet is generated in-process for
// the actual session under test (see "why a fresh wallet" below); that
// wallet's key is also never printed, only its public address/balance.
//
// Flow (per TASKS.md T1.1-T1.7 verification requirements):
//   open fresh session -> add ~10 memories (infer:false) -> search ->
//   flush (delta) -> add a few more -> flush again (forces K=2 checkpoint)
//   -> close -> reopen from chain -> identical search results.
//
// Run from the monorepo root (after `pnpm -r build`):
//   node packages/core/scripts/smoke-testnet.mjs

import fs from 'node:fs';
import { ethers } from 'ethers';
import { DmemoSession } from '../dist/index.js';

let failures = 0;
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function fail(msg) {
  failures++;
  console.error(`FAIL: ${msg}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// 1. Load spike/.env (funding wallet credentials). Never log PRIVATE_KEY.
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const envPath = new URL('../../../spike/.env', import.meta.url);
const env = loadEnv(envPath);
for (const key of ['PRIVATE_KEY', 'ADDRESS', 'RPC', 'INDEXER']) {
  if (!env[key]) {
    console.error(`FAIL: missing ${key} in spike/.env`);
    process.exitCode = 1;
    throw new Error(`missing ${key}`);
  }
}
pass(`spike/.env loaded (RPC=${env.RPC}, INDEXER=${env.INDEXER}) — PRIVATE_KEY never logged`);

// ---------------------------------------------------------------------------
// 2. WHY A FRESH WALLET: the spike wallet (spike/.env) already has Phase 0
//    blobs on-chain in the ad-hoc spike envelope format (specVersion
//    'dmemo-spike-v0', random-AES-key encryption, raw SQLite-file payload —
//    see spike/c3-mem0-loop.mjs). @dmemo/core's resolveLatest() finds a
//    wallet's single latest pointer regardless of which app wrote it, and
//    T1.2's decoder correctly REJECTS that legacy blob (wrong specVersion,
//    not ECIES-encrypted to begin with) rather than silently guessing at
//    a format — which is the correct, safe behavior, but means the spike
//    wallet isn't a clean slate for an unambiguous from-genesis restore
//    proof. So: generate a fresh in-process wallet, fund it from the spike
//    wallet with a small amount, and run the entire smoke test against it.
//    This is genuine testnet spend on a real wallet/chain — nothing about
//    the 0G Storage / eth_getLogs / Merkle-verify path is mocked.
// ---------------------------------------------------------------------------
section('SETUP: funding a fresh throwaway wallet from spike/.env');

const provider = new ethers.JsonRpcProvider(env.RPC);
const fundingWallet = new ethers.Wallet(env.PRIVATE_KEY, provider);
if (fundingWallet.address.toLowerCase() !== env.ADDRESS.toLowerCase()) {
  console.warn(`WARNING: derived address ${fundingWallet.address} != ADDRESS in .env (${env.ADDRESS})`);
}

const network = await provider.getNetwork();
if (network.chainId !== 16602n) {
  fail(`connected chain ${network.chainId} is NOT testnet Galileo (16602) — refusing to spend. Aborting.`);
  process.exitCode = 1;
  throw new Error('wrong network — never call mainnet endpoints');
}
pass(`connected to chain ${network.chainId} (testnet Galileo) via ${env.RPC}`);

const fundingBalanceBefore = await provider.getBalance(fundingWallet.address);
console.log(`[setup] spike wallet (${fundingWallet.address}) balance BEFORE: ${ethers.formatEther(fundingBalanceBefore)} 0G`);
if (fundingBalanceBefore === 0n) {
  fail(`spike wallet has 0 balance — fund it at https://faucet.0g.ai before running this smoke test`);
  process.exitCode = 1;
  throw new Error('funding wallet has 0 balance');
}

const sessionWallet = ethers.Wallet.createRandom();
const FUNDING_AMOUNT = ethers.parseEther('0.03'); // ample for ~25 flushes at spike's measured ~0.0012 0G/flush
const fundTx = await fundingWallet.sendTransaction({ to: sessionWallet.address, value: FUNDING_AMOUNT });
await fundTx.wait();
pass(`funded fresh session wallet ${sessionWallet.address} with ${ethers.formatEther(FUNDING_AMOUNT)} 0G (tx ${fundTx.hash})`);

const sessionBalanceAfterFunding = await provider.getBalance(sessionWallet.address);
console.log(`[setup] session wallet balance after funding: ${ethers.formatEther(sessionBalanceAfterFunding)} 0G`);

// ---------------------------------------------------------------------------
// content: 10 short standalone memories, then 3 more before the 2nd flush
// ---------------------------------------------------------------------------
const SCOPE = 'dmemo-t1-smoke-user';

const BATCH_A = [
  'The auth middleware lives in middleware/verifyJwt.ts and runs before every /api route.',
  'Postgres pool max is set to 20 with idleTimeoutMillis 30000.',
  'Vitest is the test framework; vitest.config.ts configures jsdom for component tests.',
  'ESLint no-unused-vars caught a leftover oldToken variable from the JWT refactor.',
  'The rate limiter is express-rate-limit at 100 requests per 15 minutes per IP, backed by Redis.',
  'Deployment target is a small Kubernetes cluster via a Helm chart in deploy/helm/api.',
  'TypeScript strict mode is on, plus noUncheckedIndexedAccess for array/object index safety.',
  'Logging uses Pino with pino-pretty in dev and structured JSON in production.',
  'CI runs the Node matrix on 18 and 20; production deploys on Node 20 LTS.',
  'The users.email column has an index that dropped /api/users latency from 800ms to 40ms.',
];
const BATCH_B = [
  'Added a composite index on (org_id, email) for the multi-tenant lookup path.',
  'Health check endpoint GET /healthz returns { status: "ok", uptime: process.uptime() }.',
  'On-call rotation is weekly via PagerDuty, handoff every Monday 10am.',
];

const SEARCH_QUERIES = [
  'how is JWT authentication verified',
  'database connection pool and index tuning',
  'rate limiting and redis configuration',
  'typescript strict noUncheckedIndexedAccess',
  'kubernetes deployment and health checks',
];

async function addAll(session, texts) {
  const ids = [];
  for (const text of texts) {
    const r = await session.memory.add(text, { userId: SCOPE, infer: false });
    ids.push(...r.results.map((m) => m.id));
  }
  return ids;
}

async function runSearches(session) {
  const out = [];
  for (const q of SEARCH_QUERIES) {
    const r = await session.memory.search(q, { filters: { user_id: SCOPE }, topK: 5 });
    out.push(r.results.map((m) => ({ id: m.id, score: m.score, memory: m.memory })));
  }
  return out;
}

function compareSearchResults(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j].id !== b[i][j].id) return false;
      if (a[i][j].score !== b[i][j].score) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 3. open fresh session (empty chain — fresh wallet)
// ---------------------------------------------------------------------------
section('STEP 1: open fresh session');

const openOpts = {
  privateKey: sessionWallet.privateKey,
  scope: SCOPE,
  network: 'testnet',
  networkOverrides: { rpcUrl: env.RPC, indexerUrl: env.INDEXER },
};

const t0Open = performance.now();
const session1 = await DmemoSession.open(openOpts);
const open1Ms = performance.now() - t0Open;
if (session1.restoreStats.restored) {
  fail(`expected a fresh (unrestored) session for a brand-new wallet, got restored=true`);
} else {
  pass(`fresh session opened in ${open1Ms.toFixed(0)}ms (restored=false, as expected for a new wallet)`);
}
console.log(`[step1] embedder in use: (see mem0 config on session) — resolveEmbedderConfig ran during open()`);

const addedIdsA = await addAll(session1, BATCH_A);
if (addedIdsA.length < 10) fail(`expected >= 10 memory ids from batch A, got ${addedIdsA.length}`);
else pass(`added ${addedIdsA.length} memories (batch A)`);

const searchesBeforeFlush = await runSearches(session1);
console.log(
  '[step1] pre-flush search result IDs:',
  searchesBeforeFlush.map((r) => r.map((x) => x.id.slice(0, 8)))
);

// ---------------------------------------------------------------------------
// 4. flush (delta) — fire-and-forget, but we await completion here to
//    measure timing/cost for the report (waitForPendingFlush is an
//    observability hook, not required for normal host-adapter usage).
// ---------------------------------------------------------------------------
section('STEP 2: flush #1 (expected: delta, K=2 not yet reached)');

session1.flush();
await session1.waitForPendingFlush();
const flush1 = session1.flushLog.at(-1);
if (!flush1) {
  fail('no flush was recorded after flush #1');
} else {
  pass(
    `flush #1 -> ${flush1.kind} (expected "delta") — root ${flush1.rootHash}, ` +
      `${flush1.uploadMs.toFixed(0)}ms, ${flush1.bytes}B, cost ${ethers.formatEther(flush1.costWei)} 0G`
  );
  if (flush1.kind !== 'delta') fail(`expected flush #1 kind "delta", got "${flush1.kind}"`);
}

// ---------------------------------------------------------------------------
// 5. add a few more, flush again -> forces K=2 checkpoint
// ---------------------------------------------------------------------------
section('STEP 3: batch B + flush #2 (expected: checkpoint, K=2 reached)');

const addedIdsB = await addAll(session1, BATCH_B);
pass(`added ${addedIdsB.length} memories (batch B)`);

const searchesBeforeFlush2 = await runSearches(session1);

session1.flush();
await session1.waitForPendingFlush();
const flush2 = session1.flushLog.at(-1);
if (!flush2) {
  fail('no flush was recorded after flush #2');
} else {
  pass(
    `flush #2 -> ${flush2.kind} (expected "checkpoint") — root ${flush2.rootHash}, ` +
      `${flush2.uploadMs.toFixed(0)}ms, ${flush2.bytes}B, cost ${ethers.formatEther(flush2.costWei)} 0G`
  );
  if (flush2.kind !== 'checkpoint') fail(`expected flush #2 kind "checkpoint", got "${flush2.kind}"`);
}

// ---------------------------------------------------------------------------
// 6. close (final awaited flush -> wipe temp file + RAM)
// ---------------------------------------------------------------------------
section('STEP 4: close session 1');
const t0Close = performance.now();
await session1.close();
const close1Ms = performance.now() - t0Close;
pass(`session 1 closed in ${close1Ms.toFixed(1)}ms`);

// ---------------------------------------------------------------------------
// 7. reopen from chain, assert search parity
// ---------------------------------------------------------------------------
section('STEP 5: reopen session from chain (checkpoint-only chain, K=2 just reset it)');

const t0Reopen = performance.now();
const session2 = await DmemoSession.open(openOpts);
const reopenMs = performance.now() - t0Reopen;

if (!session2.restoreStats.restored) {
  fail('expected session 2 to restore from the chain written by session 1');
} else {
  const rs = session2.restoreStats;
  pass(
    `session 2 restored in ${reopenMs.toFixed(0)}ms total ` +
      `(pointerResolve ${rs.pointerResolveMs.toFixed(0)}ms, download ${rs.downloadMs.toFixed(0)}ms, ` +
      `verify ${rs.verifyMs.toFixed(1)}ms, decrypt ${rs.decryptMs.toFixed(1)}ms, replay ${rs.replayMs.toFixed(1)}ms, ` +
      `chainLength ${rs.chainLength})`
  );
  if (rs.chainLength !== 1) {
    fail(`expected chainLength 1 (a single checkpoint, since flush #2 reset the delta chain), got ${rs.chainLength}`);
  } else {
    pass('chain walk correctly terminated at a single checkpoint blob (K=2 chain-reset confirmed)');
  }
}

const searchesAfterRestore = await runSearches(session2);
console.log(
  '[step5] post-restore search result IDs:',
  searchesAfterRestore.map((r) => r.map((x) => x.id.slice(0, 8)))
);

const parity = compareSearchResults(searchesBeforeFlush2, searchesAfterRestore);
if (parity) pass('search parity: identical IDs and scores before flush #2 vs after full restore');
else fail('search parity FAILED: restored search results differ from pre-flush results');

await session2.close();
pass('session 2 closed');

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
section('SUMMARY');

const fundingBalanceAfter = await provider.getBalance(fundingWallet.address);
const sessionBalanceAfter = await provider.getBalance(sessionWallet.address);
const totalFlushCostWei = [...session1.flushLog].reduce((sum, f) => sum + f.costWei, 0n);
const totalSpendWei = FUNDING_AMOUNT - sessionBalanceAfter; // gas of both uploads, from session wallet's perspective

console.log(`spike wallet (${fundingWallet.address}):`);
console.log(`  before: ${ethers.formatEther(fundingBalanceBefore)} 0G`);
console.log(`  after:  ${ethers.formatEther(fundingBalanceAfter)} 0G`);
console.log(`  spent (funding tx gas + transfer): ${ethers.formatEther(fundingBalanceBefore - fundingBalanceAfter)} 0G`);
console.log(`session wallet (${sessionWallet.address}, fresh/throwaway):`);
console.log(`  funded:        ${ethers.formatEther(FUNDING_AMOUNT)} 0G`);
console.log(`  after 2 flushes + 1 funding-recv: ${ethers.formatEther(sessionBalanceAfter)} 0G`);
console.log(`  spent on flushes (2 uploads):     ${ethers.formatEther(totalSpendWei)} 0G`);
console.log(`  (sum of per-flush cost estimates: ${ethers.formatEther(totalFlushCostWei)} 0G)`);
console.log(`open (fresh):   ${open1Ms.toFixed(0)}ms`);
console.log(`close (final):  ${close1Ms.toFixed(1)}ms`);
console.log(`reopen (restore from 1-checkpoint chain): ${reopenMs.toFixed(0)}ms`);

console.log(failures === 0 ? '\n=== ALL CHECKS PASSED ===' : `\n=== ${failures} CHECK(S) FAILED ===`);
process.exitCode = failures === 0 ? 0 : 1;
// Do NOT call process.exit() — fastembed/onnxruntime-node native teardown
// aborts with a libc++abi mutex error if the process is force-exited
// (gotcha 12, proven live in spike/c3-mem0-loop.mjs). Let the event loop
// drain naturally.
