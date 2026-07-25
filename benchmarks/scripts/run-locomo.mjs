#!/usr/bin/env node
// T5.2 orchestrator: LoCoMo ingest -> predict-only -> flush to 0G testnet ->
// wipe local state -> restore -> predict-only again -> invariance diff.
//
// Run from the monorepo root (after `pnpm -r build`):
//   node benchmarks/scripts/run-locomo.mjs
//
// Requires (not committed to the repo, per TASKS.md T5.2/gotcha 18):
//   - spike/.env with PRIVATE_KEY/ADDRESS/RPC/INDEXER (funds an ephemeral
//     throwaway wallet for this run only — the funding key is never logged).
//   - a local clone of mem0ai/memory-benchmarks (Apache-2.0) with its Python
//     venv set up (see benchmarks/README.md) and the LoCoMo-10 dataset
//     (CC BY-NC 4.0 — never committed) downloaded into it.
// Configure both paths via env: DMEMO_BENCH_HARNESS_DIR, DMEMO_BENCH_PYTHON.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { DmemoSession } from '../../packages/core/dist/index.js';
import { startServer } from '../shim/server.mjs';

const HARNESS_DIR = process.env.DMEMO_BENCH_HARNESS_DIR;
const PYTHON = process.env.DMEMO_BENCH_PYTHON;
if (!HARNESS_DIR || !PYTHON) {
  console.error('[run] set DMEMO_BENCH_HARNESS_DIR and DMEMO_BENCH_PYTHON (see benchmarks/README.md)');
  process.exitCode = 1;
  throw new Error('missing harness config');
}

const RESULTS_DIR = process.env.DMEMO_BENCH_OUTPUT_DIR ?? path.join(HARNESS_DIR, 'results');
const PROJECT_NAME = 'dmemo-t52';
const RUN_ID = 'dmemot52fixed'; // pinned across both predict-only passes (see README "why a fixed run-id")
const TOP_K = 20;
const CATEGORIES = '1,2,3,4';
const PORT = Number(process.env.PORT ?? 8899);
const POINTER_CACHE_PATH = path.join(os.tmpdir(), `dmemo-t52-pointer-cache-${Date.now()}.json`);

const REPORT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'results');
fs.mkdirSync(REPORT_DIR, { recursive: true });

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// T5.2 live finding (this run): 0G's indexer can legitimately report zero
// file locations for a just-uploaded root hash for a short window after the
// upload's log entry is confirmed — the SDK's own `getFileLocations()` doc
// comment acknowledges "a root hash that has no known locations yet" as a
// normal transient state, worse for larger multi-segment files (observed on
// a 10.8MB checkpoint; earlier small ~36KB smoke-test checkpoints never hit
// this). This is exactly the class of bounded-retry situation gotcha 15
// already establishes the pattern for (never rely on unbounded native
// retries, but a short bounded backoff at the call site is correct) — since
// packages/core is off-limits for this task, the retry lives here instead of
// inside DmemoSession.open() itself.
async function withRetry(label, fn, { attempts = 6, baseDelayMs = 15000, maxDelayMs = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const delay = Math.min(baseDelayMs * 2 ** i, maxDelayMs);
      console.warn(`[retry] ${label}: attempt ${i + 1}/${attempts} failed (${e && e.message ? e.message : e}) — retrying in ${(delay / 1000).toFixed(0)}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

// Everything below is wrapped in one async main() (rather than left as
// top-level procedural code) so that ANY failure — a thrown assertion, a
// rejected promise, a harness subprocess exit code — is caught here instead
// of becoming an uncaught exception. That distinction matters a lot after
// fastembed has been loaded (gotcha 12): Node's default uncaught-exception
// path calls process.exit() internally, which SIGABRTs on onnxruntime
// native teardown. Catching everything and setting process.exitCode
// ourselves is the only way to fail without crashing.
async function main() {
// ---------------------------------------------------------------------------
// 1. Fund an ephemeral throwaway wallet from spike/.env (gotcha 18: one
//    wallet = one flush chain; never reuse the spike wallet's own chain).
// ---------------------------------------------------------------------------
section('SETUP: funding ephemeral wallet');

function loadEnv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

const envPath = new URL('../../spike/.env', import.meta.url);
const env = loadEnv(envPath);
const provider = new ethers.JsonRpcProvider(env.RPC);
const fundingWallet = new ethers.Wallet(env.PRIVATE_KEY, provider);

const network = await provider.getNetwork();
if (network.chainId !== 16602n) {
  throw new Error(`connected chain ${network.chainId} is NOT testnet Galileo — refusing to spend`);
}
console.log(`connected to chain ${network.chainId} (testnet Galileo)`);

const fundingBefore = await provider.getBalance(fundingWallet.address);
console.log(`funding wallet ${fundingWallet.address} balance: ${ethers.formatEther(fundingBefore)} 0G`);

const sessionWallet = ethers.Wallet.createRandom();
const FUNDING_AMOUNT = ethers.parseEther('0.2'); // ample for ~150 flushes at ~0.0012 0G gas each

// Crash-recovery net (T5.2 live finding): this is a throwaway ephemeral
// wallet, not the spike wallet — persisting IT is fine (see
// benchmarks/scripts/fund-wallet.mjs precedent) and means a mid-run crash
// doesn't strand already-paid-for on-chain data behind an unrecoverable
// in-memory-only key. Deleted on any successful completion path; left in
// place (path only, never the key, printed) if main() throws.
const KEY_RECOVERY_PATH = path.join(os.tmpdir(), `dmemo-t52-ephemeral-key-${Date.now()}.key`);
fs.writeFileSync(KEY_RECOVERY_PATH, sessionWallet.privateKey, { mode: 0o600 });
console.log(`crash-recovery key (0600, throwaway wallet only) written to ${KEY_RECOVERY_PATH}`);

const fundTx = await fundingWallet.sendTransaction({ to: sessionWallet.address, value: FUNDING_AMOUNT });
await fundTx.wait();
console.log(`funded ephemeral session wallet ${sessionWallet.address} with ${ethers.formatEther(FUNDING_AMOUNT)} 0G (tx ${fundTx.hash})`);

const openOpts = {
  privateKey: sessionWallet.privateKey,
  scope: 'dmemo-locomo-benchmark',
  network: 'testnet',
  networkOverrides: { rpcUrl: env.RPC, indexerUrl: env.INDEXER },
  embedder: { provider: 'fastembed', model: 'fast-bge-small-en-v1.5' }, // pinned, deterministic (D6)
  pointerCachePath: POINTER_CACHE_PATH,
};

// ---------------------------------------------------------------------------
// 2. Open a fresh session, start the shim, run harness pass 1 (ingest+search).
// ---------------------------------------------------------------------------
section('PASS 1: open fresh session + shim + ingest+predict-only');

const state = { session: await DmemoSession.open(openOpts) };
if (state.session.restoreStats.restored) {
  console.warn('WARNING: expected a fresh (unrestored) session for a brand-new wallet');
}
const server = await startServer(state, PORT);
console.log(`shim listening on http://127.0.0.1:${PORT}`);

// Periodic flush during ingestion (T5.2 budget rule: batch adds between
// flushes, never flush per-memory). ~5882 LoCoMo-10 turns will be added
// across 10 concurrently-ingested conversations; flushing every 4s bounds
// each delta/checkpoint upload to a manageable batch instead of one giant
// end-of-run blob or (worse) one flush per add() call.
let flushTimer = setInterval(() => state.session.flush(), 4000);

const t0Pass1 = performance.now();
await runHarness({ predictOnly: true });
clearInterval(flushTimer);
state.session.flush();
await state.session.waitForPendingFlush();
const pass1Ms = performance.now() - t0Pass1;
console.log(`pass 1 (ingest + predict-only) done in ${(pass1Ms / 1000).toFixed(1)}s`);
console.log(`flush log so far: ${state.session.flushLog.length} flushes`);
for (const f of state.session.flushLog) {
  console.log(`  seq=${f.seq} kind=${f.kind} bytes=${f.bytes} cost=${ethers.formatEther(f.costWei)} 0G upload=${f.uploadMs.toFixed(0)}ms`);
}
// Captured now — `state.session` is replaced by a fresh restored instance
// below (its own flushLog starts empty; pass 2 does no adds/flushes).
const pass1FlushLog = state.session.flushLog.map((f) => ({ ...f, costWei: f.costWei.toString() }));
const pass1FlushCostWei = state.session.flushLog.reduce((s, f) => s + f.costWei, 0n);

const outputDir = path.join(RESULTS_DIR, `predicted_${PROJECT_NAME}`);
const checkpointsPre = path.join(REPORT_DIR, 'checkpoints_pre');
copyQuestionResults(outputDir, checkpointsPre);
const preFiles = fs.readdirSync(checkpointsPre).filter((f) => f.endsWith('.json'));
console.log(`saved ${preFiles.length} pre-flush per-question result files -> ${checkpointsPre}`);

const memCountsBefore = await countMemoriesPerUser(state.session, 10, RUN_ID);
console.log(`memory counts per conversation (pre-restore): ${JSON.stringify(memCountsBefore)}`);
const totalBefore = Object.values(memCountsBefore).reduce((a, b) => a + b, 0);
console.log(`total memories ingested: ${totalBefore}`);

// ---------------------------------------------------------------------------
// 3. Wipe: close (final flush, wipes temp sqlite file) + drop pointer cache.
// ---------------------------------------------------------------------------
section('WIPE: close session, delete pointer cache, drop in-process references');

await state.session.close();
try {
  fs.unlinkSync(POINTER_CACHE_PATH);
} catch {
  /* fine if it never got written (nothing forced a cache write this run) */
}
state.session = null; // drop the only JS reference before reopening
if (global.gc) global.gc();
console.log('local state wiped: temp sqlite file deleted, pointer cache deleted, in-process handle dropped');

// ---------------------------------------------------------------------------
// 4. Restore into a brand-new DmemoSession behind the SAME running shim.
// ---------------------------------------------------------------------------
section('RESTORE: fresh DmemoSession.open() from the 0G chain');

const t0Restore = performance.now();
// Retried: see the withRetry() doc comment above — the indexer can report
// zero locations for a just-uploaded (especially large) checkpoint for a
// short window after its log entry is confirmed.
state.session = await withRetry('restore DmemoSession.open()', () => DmemoSession.open(openOpts));
const restoreMs = performance.now() - t0Restore;
const rs = state.session.restoreStats;
console.log(
  `restore ${rs.restored ? 'OK' : 'FAILED'} in ${restoreMs.toFixed(0)}ms total ` +
    `(pointerResolve ${rs.pointerResolveMs.toFixed(0)}ms, download ${rs.downloadMs.toFixed(0)}ms, ` +
    `verify ${rs.verifyMs.toFixed(1)}ms, decrypt ${rs.decryptMs.toFixed(1)}ms, replay ${rs.replayMs.toFixed(1)}ms, ` +
    `chainLength ${rs.chainLength})`
);
if (!rs.restored) throw new Error('restore FAILED — chain walk found nothing for this wallet');

const memCountsAfter = await countMemoriesPerUser(state.session, 10, RUN_ID);
const totalAfter = Object.values(memCountsAfter).reduce((a, b) => a + b, 0);
console.log(`memory counts per conversation (post-restore): ${JSON.stringify(memCountsAfter)}`);
console.log(`total memories restored: ${totalAfter} (pre-flush total was ${totalBefore})`);

// ---------------------------------------------------------------------------
// 5. Pass 2: identical predict-only run against the restored session. The
//    harness's own IngestionCheckpoint (benchmarks/common/utils.py) will see
//    each conversation already marked complete in `outputDir` and skip
//    re-ingesting (same pinned RUN_ID / output dir as pass 1) — so this run
//    only exercises search against the restored store.
// ---------------------------------------------------------------------------
section('PASS 2: predict-only against restored session (ingestion skipped)');

const t0Pass2 = performance.now();
await runHarness({ predictOnly: true });
const pass2Ms = performance.now() - t0Pass2;
console.log(`pass 2 (search-only) done in ${(pass2Ms / 1000).toFixed(1)}s`);

const checkpointsPost = path.join(REPORT_DIR, 'checkpoints_post');
copyQuestionResults(outputDir, checkpointsPost);
const postFiles = fs.readdirSync(checkpointsPost).filter((f) => f.endsWith('.json'));
console.log(`saved ${postFiles.length} post-restore per-question result files -> ${checkpointsPost}`);

// ---------------------------------------------------------------------------
// 6. Invariance diff (deterministic, zero-LLM-cost).
// ---------------------------------------------------------------------------
section('INVARIANCE DIFF');

const diff = diffCheckpoints(checkpointsPre, checkpointsPost);
console.log(
  `questions compared: ${diff.compared}, identical: ${diff.identical}, mismatched: ${diff.mismatched.length}, ` +
    `only-in-pre: ${diff.onlyInPre.length}, only-in-post: ${diff.onlyInPost.length}`
);
if (diff.mismatched.length > 0) {
  console.log('sample mismatches:', JSON.stringify(diff.mismatched.slice(0, 5), null, 2));
}

// ---------------------------------------------------------------------------
// 7. Summary + cost accounting.
// ---------------------------------------------------------------------------
section('SUMMARY');

const fundingAfter = await provider.getBalance(fundingWallet.address);
const sessionBalanceAfter = await provider.getBalance(sessionWallet.address);
const spentBySessionWallet = FUNDING_AMOUNT - sessionBalanceAfter;

const summary = {
  totalMemoriesIngested: totalBefore,
  totalMemoriesRestored: totalAfter,
  memoryCountsMatch: totalBefore === totalAfter,
  perConversationCounts: { before: memCountsBefore, after: memCountsAfter },
  flushLog: pass1FlushLog,
  flushCostTotal0G: ethers.formatEther(pass1FlushCostWei),
  restoreStats: rs,
  pass1Ms,
  pass2Ms,
  restoreMs,
  invariance: diff,
  sessionWallet: sessionWallet.address,
  fundedAmount0G: ethers.formatEther(FUNDING_AMOUNT),
  spentBySessionWallet0G: ethers.formatEther(spentBySessionWallet),
  fundingWalletSpent0G: ethers.formatEther(fundingBefore - fundingAfter),
};

fs.writeFileSync(path.join(REPORT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nsession wallet spent (gas of all flushes + 1 restore, no restore cost): ${summary.spentBySessionWallet0G} 0G`);
console.log(`funding wallet spent (1 transfer tx): ${summary.fundingWalletSpent0G} 0G`);
console.log('summary written to', path.join(REPORT_DIR, 'summary.json'));

await state.session.close();
server.close();
console.log(failuresOrDone(diff, summary));
process.exitCode = diff.mismatched.length === 0 && diff.onlyInPre.length === 0 && diff.onlyInPost.length === 0 && summary.memoryCountsMatch ? 0 : 1;

// Run completed (success or a reported/diffed failure, not a crash) — the
// ephemeral wallet's key is no longer needed for recovery.
try {
  fs.unlinkSync(KEY_RECOVERY_PATH);
} catch {
  /* already gone, fine */
}
} // end main()

main().catch((err) => {
  console.error('\n[run] FATAL (caught, not a crash):', (err && err.stack) || err);
  console.error('[run] if an ephemeral session wallet was already funded above, its recovery key');
  console.error('[run] (NOT the spike key) was written to a 0600 file under the OS tmp dir, path logged');
  console.error('[run] above at "Crash-recovery net" time — use it to retry restore without re-ingesting.');
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function runHarness({ predictOnly }) {
  const args = [
    '-m', 'benchmarks.locomo.run',
    '--project-name', PROJECT_NAME,
    '--backend', 'oss',
    '--mem0-host', `http://127.0.0.1:${PORT}`,
    '--top-k', String(TOP_K),
    '--categories', CATEGORIES,
    '--run-id', RUN_ID,
    '--output-dir', RESULTS_DIR,
    '--provider', 'openai',
    '--answerer-model', 'gpt-5-mini',
    '--judge-model', 'gpt-5-mini',
    '--max-workers', '6',
  ];
  if (predictOnly) args.push('--predict-only');

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      cwd: HARNESS_DIR,
      env: {
        ...process.env,
        // LLMClient is constructed unconditionally even under --predict-only
        // (it's just never called); a dummy key satisfies openai.AsyncOpenAI's
        // eager construction-time check without touching any real credential.
        OPENAI_API_KEY: 'sk-dummy-unused-predict-only',
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`harness exited ${code}`))));
    child.on('error', reject);
  });
}

function copyQuestionResults(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue; // skip ingestion-checkpoint bookkeeping files
    fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
  }
}

async function countMemoriesPerUser(session, nConversations, runId) {
  const counts = {};
  for (let i = 0; i < nConversations; i++) {
    const userId = `locomo_${i}_${runId}`;
    const r = await session.memory.getAll({ filters: { user_id: userId }, topK: 100000 });
    counts[i] = r.results.length;
  }
  return counts;
}

function diffCheckpoints(preDir, postDir) {
  const preFiles = new Set(fs.readdirSync(preDir).filter((f) => f.endsWith('.json')));
  const postFiles = new Set(fs.readdirSync(postDir).filter((f) => f.endsWith('.json')));
  const onlyInPre = [...preFiles].filter((f) => !postFiles.has(f));
  const onlyInPost = [...postFiles].filter((f) => !preFiles.has(f));
  const common = [...preFiles].filter((f) => postFiles.has(f));

  let identical = 0;
  const mismatched = [];
  for (const f of common) {
    const pre = JSON.parse(fs.readFileSync(path.join(preDir, f), 'utf8'));
    const post = JSON.parse(fs.readFileSync(path.join(postDir, f), 'utf8'));
    const preResults = normalizeSearchResults(pre);
    const postResults = normalizeSearchResults(post);
    if (JSON.stringify(preResults) === JSON.stringify(postResults)) {
      identical++;
    } else {
      mismatched.push({ question: f, pre: preResults, post: postResults });
    }
  }
  return { compared: common.length, identical, mismatched, onlyInPre, onlyInPost };
}

function normalizeSearchResults(resultDoc) {
  // The per-question result JSON's exact key for retrieved memories varies
  // by harness version; be defensive across `search_results` /
  // `retrieval.search_results` / `retrieved_memories` shapes.
  const list =
    resultDoc.search_results ??
    resultDoc.retrieval?.search_results ??
    resultDoc.retrieved_memories ??
    [];
  // Strip non-deterministic/irrelevant fields (wall-clock latency) — compare
  // only exact memory-ID sets + scores + text, sorted for order-independence.
  return list
    .map((r) => ({ id: r.id, score: r.score, memory: r.memory }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function failuresOrDone(diff, summary) {
  const ok = diff.mismatched.length === 0 && diff.onlyInPre.length === 0 && diff.onlyInPost.length === 0 && summary.memoryCountsMatch;
  return ok ? '\n=== INVARIANT HOLDS: identical retrieval before/after flush+wipe+restore ===' : '\n=== INVARIANCE FAILED — see mismatches above ===';
}
