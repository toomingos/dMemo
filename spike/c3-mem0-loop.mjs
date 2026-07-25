#!/usr/bin/env node
// c3-mem0-loop.mjs — end-to-end mem0-oss <-> 0G Storage memory loop for dMemo.
// Validates D3 (flush cadence), D4 (session lifecycle), D6 (local embedder),
// D7 (journaling VectorStore wrapper), D17 (infer=false default).
//
// Step 1: snapshot mode — whole SQLite file + history Map flushed as one
//         checkpoint blob; restore = download + rewrite file + new Memory.
// Step 2: journal mode — a thin proxy wraps the native VectorStore, records
//         insert/update/delete as JSON deltas; flush = deltas only; restore =
//         replay deltas (chained via prevRootHash) into a fresh native store.
//
// IMPORTANT (found live, see RESULTS.md): calling process.exit() in this
// process aborts with `libc++abi: mutex lock failed` during fastembed's
// onnxruntime-node native teardown. Fix: never call process.exit(); set
// process.exitCode and let the event loop drain naturally.
//
// Run with cwd = spike/ (fastembed's default cacheDir "local_cache" is
// resolved relative to process.cwd(), and mem0's FastEmbedEmbedder does not
// expose a cacheDir override).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { Indexer, MemData, FixedPriceFlow__factory } from '@0gfoundation/0g-ts-sdk';

// mem0ai/oss reads process.env.MEM0_TELEMETRY at module-eval time (posthog
// fetch calls in _captureEvent/_initializeTelemetry). Disable it for a
// hermetic, network-independent spike run with clean timing measurements.
// Must be set BEFORE the module is evaluated, so this has to be a dynamic
// import — a static `import ... from 'mem0ai/oss'` would be hoisted above
// this assignment regardless of source order.
process.env.MEM0_TELEMETRY = 'false';
const { Memory } = await import('mem0ai/oss');

const FLOW_ADDRESS = '0x22e03a6a89b950f1c82ec5e74f8eca321a105296';
const BLOCK_RANGE_CAP = 4_700_000;
const SCOPE = 'dmemo-c3-user';

let failures = 0;
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function failSoft(msg) {
  failures++;
  console.error(`FAIL: ${msg}`);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(`assertion failed: ${msg}`);
  else pass(msg);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// env / wallet / indexer setup (pattern verbatim from c2-blob.mjs)
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

const env = loadEnv(new URL('./.env', import.meta.url));
const { PRIVATE_KEY, ADDRESS, RPC, INDEXER } = env;
for (const key of ['PRIVATE_KEY', 'ADDRESS', 'RPC', 'INDEXER']) {
  if (!env[key]) fail(`missing ${key} in .env`);
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const indexer = new Indexer(INDEXER);

const network = await provider.getNetwork();
console.log(`[env] chain ${network.chainId} via ${RPC}, indexer ${INDEXER}`);

const balanceBefore = await provider.getBalance(wallet.address);
console.log(`[env] balance BEFORE: ${ethers.formatEther(balanceBefore)} 0G (${wallet.address})`);

if (balanceBefore === 0n) {
  console.log(`FUND ME: ${wallet.address} via https://faucet.0g.ai`);
  fail('wallet has 0 balance — cannot run funded storage flow');
}

let totalCostWei = 0n;
const flushLog = [];

// ---------------------------------------------------------------------------
// storage helpers: resolve latest pointer / upload / download+verify
// ---------------------------------------------------------------------------
const flowIface = new ethers.Interface(FixedPriceFlow__factory.abi);
const submitTopic = flowIface.getEvent('Submit').topicHash;
const senderTopic = ethers.zeroPadValue(wallet.address, 32);

async function getLogsPaginated() {
  const latestBlock = await provider.getBlockNumber();
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
      const span = toBlock - fromBlock;
      fromBlock = toBlock - Math.floor(span / 2);
      if (fromBlock >= toBlock) throw e;
    }
  }
  throw new Error('exhausted eth_getLogs range retries');
}

// Resolve the latest rootHash written by this wallet via eth_getLogs (D8) —
// no local pointer cache used, matching c2-blob.mjs steps 5-6 verbatim.
async function resolveLatestRootHash() {
  const t0 = performance.now();
  const logs = await getLogsPaginated();
  if (logs.length === 0) throw new Error('no Submit logs found for sender');
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  const latestLog = logs[logs.length - 1];
  const decoded = flowIface.parseLog(latestLog);
  const txSeq = Number(decoded.args.submissionIndex);
  const [selectedNodes, selectErr] = await indexer.selectNodes(1);
  if (selectErr) throw new Error(`selectNodes error: ${selectErr}`);
  const fileInfo = await selectedNodes[0].getFileInfoByTxSeq(txSeq);
  if (!fileInfo) throw new Error(`storage node has no file info for txSeq ${txSeq}`);
  const rootHash = fileInfo.tx.dataMerkleRoot;
  const elapsedMs = performance.now() - t0;
  return { rootHash, txSeq, blockNumber: latestLog.blockNumber, elapsedMs };
}

// Download by known rootHash (content-addressed — no pointer resolution
// needed once you already know the hash, e.g. via a prevRootHash chain link)
// and self-verify the Merkle root (gotcha 1: with_proof is a no-op).
async function downloadAndVerify(rootHash) {
  const tDownloadStart = performance.now();
  const tmpPath = path.join(os.tmpdir(), `c3-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  const downloadErr = await indexer.download(rootHash, tmpPath, false);
  if (downloadErr) throw new Error(`download error: ${downloadErr}`);
  const bytes = fs.readFileSync(tmpPath);
  fs.unlinkSync(tmpPath);
  const downloadMs = performance.now() - tDownloadStart;

  const tVerifyStart = performance.now();
  const file = new MemData(bytes);
  const [tree, treeErr] = await file.merkleTree();
  if (treeErr) throw new Error(`merkleTree error: ${treeErr}`);
  const recomputedRoot = tree.rootHash();
  const verifyMs = performance.now() - tVerifyStart;
  if (recomputedRoot.toLowerCase() !== rootHash.toLowerCase()) {
    throw new Error(`merkle self-verify FAILED: recomputed ${recomputedRoot} != expected ${rootHash}`);
  }
  return { bytes, downloadMs, verifyMs };
}

async function uploadBlob(ciphertext, label) {
  const t0 = performance.now();
  const file = new MemData(ciphertext);
  const [result, err] = await indexer.upload(file, RPC, wallet);
  if (err) throw new Error(`upload error: ${err}`);
  const uploadMs = performance.now() - t0;

  let costWei = 0n;
  try {
    const receipt = await provider.getTransactionReceipt(result.txHash);
    const tx = await provider.getTransaction(result.txHash);
    const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice;
    const gasCostWei = receipt.gasUsed * effectiveGasPrice;
    const storageFeeWei = tx.value;
    costWei = gasCostWei + storageFeeWei;
    totalCostWei += costWei;
  } catch (e) {
    console.warn(`[flush:${label}] WARNING: could not compute cost breakdown: ${e.message}`);
  }
  flushLog.push({
    label,
    rootHash: result.rootHash,
    txHash: result.txHash,
    uploadMs,
    costWei: costWei.toString(),
    bytes: ciphertext.length,
  });
  return { ...result, uploadMs, costWei };
}

// AES-256-CTR, key kept in-memory only (gotcha 6: no auth tag — integrity
// comes from Merkle self-verify, never from decryption "succeeding"). In
// production this key derives from the wallet (T1.7); the spike keeps a
// process-local random key to isolate storage/pointer mechanics from key
// management, which is explicitly out of scope for Phase 0.
const aesKey = crypto.randomBytes(32);
function encryptJson(obj) {
  const t0 = performance.now();
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', aesKey, iv);
  const ciphertext = Buffer.concat([iv, cipher.update(plaintext), cipher.final()]);
  const encryptMs = performance.now() - t0;
  return { ciphertext, plaintextBytes: plaintext.length, encryptMs };
}
function decryptJson(ciphertext) {
  const t0 = performance.now();
  const iv = ciphertext.subarray(0, 16);
  const body = ciphertext.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-ctr', aesKey, iv);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  const obj = JSON.parse(plaintext.toString('utf8'));
  const decryptMs = performance.now() - t0;
  return { obj, decryptMs };
}

// ---------------------------------------------------------------------------
// realistic coding-session content (24 turns / 48 messages)
// ---------------------------------------------------------------------------
const TURNS = [
  ["I'm getting TypeError: Cannot read properties of undefined (reading 'id') in auth.js around line 42, any idea?",
   "That's because req.user is undefined when the JWT middleware hasn't run yet. Add a guard: if (!req.user) return res.status(401).json({ error: 'unauthorized' }); right before you access req.user.id."],
  ["Where should I put JWT verification middleware?",
   "Register it before your route handlers in app.js, e.g. app.use('/api', verifyJwt, apiRouter), so req.user is populated for every route under /api."],
  ["What testing framework does this repo use?",
   "It's Vitest, configured in vitest.config.ts with the jsdom environment for component tests and node environment for server tests."],
  ["How do I mock the database in a Vitest test?",
   "Use vi.mock('../db/pool') at the top of the test file and return a fake pg Pool with a query mock function that resolves canned rows."],
  ["The Postgres pool is running out of connections under load, what's the fix?",
   "Increase max in the pg.Pool config to 20 and make sure every client.query call path releases the client in a finally block — a missing client.release() on the error path is the usual culprit."],
  ["Can you review my connection pooling change?",
   "Looks good — you added client.release() in the finally block and bumped max to 20. One nit: also set idleTimeoutMillis to 30000 so idle clients get recycled."],
  ["How do I resolve a git rebase conflict in package-lock.json?",
   "Delete package-lock.json, take the incoming version of package.json, run npm install to regenerate the lockfile, then git add package-lock.json and continue the rebase."],
  ["Should I squash my commits before merging this PR?",
   "Yes, squash the 6 WIP commits into one with git rebase -i HEAD~6, keeping a single descriptive commit message summarizing the auth-middleware fix."],
  ["The API response for /api/users is slow, about 800ms. How do I profile it?",
   "Wrap the handler with console.time/console.timeEnd, or better, run EXPLAIN ANALYZE on the underlying query — most likely a missing index on users.email used in the WHERE clause."],
  ["I added an index on users.email, latency dropped to 40ms. Anything else to check?",
   "Nice improvement. Also add a composite index on (org_id, email) if you filter by both — that helps the multi-tenant lookup path too."],
  ["What's the recommended way to handle pagination for this endpoint?",
   "Use keyset pagination with created_at plus id as the cursor instead of OFFSET, since offset pagination gets slower as the table grows."],
  ["How should error responses be shaped across the API?",
   "Standardize on { error: { code, message, details? } } and centralize it in an Express error-handling middleware registered last with app.use(errorHandler)."],
  ["Can we add a global error handler?",
   "Yes — add app.use((err, req, res, next) => { ... }) as the very last middleware; it must have all four arguments or Express won't treat it as an error handler."],
  ["What logging library are we using?",
   "Pino, configured with pino-pretty in development and structured JSON output in production, shipped to stdout for the container log collector."],
  ["How do I add a correlation ID to every log line?",
   "Generate a UUID per request in middleware, store it on req.id, and pass a child logger logger.child({ requestId: req.id }) down through the request context."],
  ["The CI pipeline is failing on the lint step, what changed?",
   "ESLint's no-unused-vars rule caught the oldToken variable left over from the JWT refactor — remove it or prefix with an underscore if intentionally unused."],
  ["Do we have pre-commit hooks configured?",
   "Yes, via Husky — .husky/pre-commit runs lint-staged, which runs eslint --fix and prettier --write on staged files."],
  ["How is the rate limiter configured for the public API?",
   "express-rate-limit with a 100-requests-per-15-minutes window per IP, backed by a Redis store so limits are shared across the two running instances."],
  ["Redis connection keeps dropping in production, why?",
   "Likely the idle connection timeout on the managed Redis provider — enable retryStrategy in ioredis with exponential backoff and set enableReadyCheck to true."],
  ["What's our deployment target?",
   "Docker images built in CI, pushed to the registry, deployed to a small Kubernetes cluster via a Helm chart in deploy/helm/api."],
  ["How do I roll back a bad deploy?",
   "helm rollback api <previous-revision> — check helm history api first to find the revision number of the last known-good release."],
  ["Any TypeScript strictness settings I should know about?",
   "strict is true in tsconfig.json, plus noUncheckedIndexedAccess — that's why array and object index access returns T | undefined everywhere."],
  ["Why is noUncheckedIndexedAccess giving me errors on arr[0].foo?",
   "Because arr[0] is typed as T | undefined under that flag — add a guard or optional chaining, e.g. arr[0]?.foo, or check arr.length first."],
  ["Summarize what we fixed this session.",
   "Fixed the undefined req.user crash with a JWT guard, fixed a Postgres pool leak and added indexes cutting /api/users latency from 800ms to 40ms, cleaned up the rebase conflict, and standardized API error responses."],
];

const EXTRA_TURNS = [
  ["Can you add a health check endpoint?",
   "Add GET /healthz returning 200 with { status: 'ok', uptime: process.uptime() }; wire it into the Kubernetes readiness and liveness probes."],
  ["Should the health check hit the database?",
   "Only the readiness probe should — do a lightweight SELECT 1 with a short timeout; the liveness probe should stay process-local so a slow DB doesn't trigger a restart loop."],
  ["What's our Node version target?",
   "Node 20 LTS in production, pinned via .nvmrc and the engines field in package.json; CI runs the matrix on 18 and 20."],
  ["Do we support Node 18 for this package?",
   "Yes, keep the minimum at 18 for consumers, but the app repo itself deploys on 20 — don't introduce Node 20-only APIs into the shared package."],
  ["Any open TODOs from this session I should track?",
   "Track: add composite index rollout, Redis retryStrategy tuning, and removing the leftover oldToken variable — file all three as follow-up tickets."],
  ["One more thing — what's the on-call rotation for this service?",
   "Weekly rotation via PagerDuty, handoff every Monday 10am; the runbook for the connection-pool alert is linked from the service's README."],
];

const SEARCH_QUERIES = [
  'how was the undefined req.user error fixed',
  'database connection pool tuning and leaks',
  'git rebase conflict resolution',
  'rate limiting and redis configuration',
  'typescript strict noUncheckedIndexedAccess settings',
];

function makeMemoryConfig(dbPath) {
  return {
    embedder: { provider: 'fastembed', config: { model: 'fast-bge-small-en-v1.5' } },
    vectorStore: { provider: 'memory', config: { dbPath, collectionName: 'memories' } },
    // Never called (infer:false everywhere) — a real API key is not needed,
    // but the field is required by MemoryConfig and Memory's constructor
    // eagerly instantiates the OpenAI client (no network call at construction).
    llm: { provider: 'openai', config: { apiKey: 'unused-in-spike-infer-false', model: 'gpt-5-mini' } },
    historyStore: { provider: 'memory', config: {} },
  };
}

async function addAllTurns(memory, turns) {
  const ids = [];
  for (const [q, a] of turns) {
    const r = await memory.add(
      [
        { role: 'user', content: q },
        { role: 'assistant', content: a },
      ],
      { userId: SCOPE, infer: false }
    );
    ids.push(...r.results.map((m) => m.id));
  }
  return ids;
}

async function runSearches(memory) {
  const out = [];
  for (const q of SEARCH_QUERIES) {
    const r = await memory.search(q, { filters: { user_id: SCOPE }, topK: 5 });
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

const results = {
  balanceBefore: ethers.formatEther(balanceBefore),
  snapshot: {},
  journal: {},
};

// ===========================================================================
// STEP 1 — snapshot mode
// ===========================================================================
section('STEP 1: snapshot mode');

const snapDbPath = path.join(os.tmpdir(), `dmemo-c3-snap-${Date.now()}.db`);
const memory1 = new Memory(makeMemoryConfig(snapDbPath));
await memory1._initPromise;
if (memory1._initError) fail(`memory1 init failed: ${memory1._initError.message}`);
pass('Memory (snapshot mode) constructed and initialized');

const addedIds1 = await addAllTurns(memory1, TURNS);
assert(addedIds1.length >= 20, `added ${addedIds1.length} memories (>= 20 required)`);
console.log(`[step1] added ${addedIds1.length} memories from ${TURNS.length} turns`);

const searchesBeforeFlush1 = await runSearches(memory1);
console.log('[step1] pre-flush search result IDs:', searchesBeforeFlush1.map((r) => r.map((x) => x.id.slice(0, 8))));

// --- infer=false quality spot-check: paste 3 example stored memories -------
const spotCheck = [];
for (const q of SEARCH_QUERIES.slice(0, 3)) {
  const r = await memory1.search(q, { filters: { user_id: SCOPE }, topK: 1 });
  if (r.results[0]) spotCheck.push({ query: q, memory: r.results[0].memory });
}
results.snapshot.spotCheck = spotCheck;
console.log('[step1] infer=false spot-check samples:', JSON.stringify(spotCheck, null, 2));

// --- flush: read db file bytes + serialize history map into one envelope ---
const dimProbeVector = await memory1.embedder.embed('dimension probe');
const embeddingDim = dimProbeVector.length;

const dbBytes1 = fs.readFileSync(snapDbPath);
const historyEntries1 = [...memory1.db.memoryStore.entries()];

const checkpointEnvelope = {
  specVersion: 'dmemo-spike-v0',
  mode: 'checkpoint',
  seq: 0,
  prevRootHash: null,
  createdAt: new Date().toISOString(),
  embedder: { provider: 'fastembed', model: 'fast-bge-small-en-v1.5', dim: embeddingDim },
  dbFileBase64: dbBytes1.toString('base64'),
  history: historyEntries1,
};

const { ciphertext: cipher1, plaintextBytes: plainBytes1, encryptMs: encryptMs1 } = encryptJson(checkpointEnvelope);
console.log(`[step1] envelope plaintext ${plainBytes1} bytes -> ciphertext ${cipher1.length} bytes (encrypt ${encryptMs1.toFixed(1)}ms)`);

const upload1 = await uploadBlob(cipher1, 'step1-checkpoint');
console.log(`[step1] PASS uploaded checkpoint — tx ${upload1.txHash}, root ${upload1.rootHash}, ${upload1.uploadMs.toFixed(0)}ms, cost ${ethers.formatEther(upload1.costWei)} 0G`);

const flushTimeStep1 = encryptMs1 + upload1.uploadMs;

// --- wipe local state --------------------------------------------------
fs.unlinkSync(snapDbPath);
// (memory1 kept referenced only for the "before" comparison already captured above)
pass('wiped local snapshot state (deleted temp db file)');

// --- restore -------------------------------------------------------------
const restoreResolve1 = await resolveLatestRootHash();
assert(restoreResolve1.rootHash.toLowerCase() === upload1.rootHash.toLowerCase(), 'eth_getLogs-resolved root hash matches upload result (step1)');

const dl1 = await downloadAndVerify(restoreResolve1.rootHash);
pass(`downloaded + Merkle self-verified checkpoint blob (${dl1.bytes.length} bytes, download ${dl1.downloadMs.toFixed(0)}ms, verify ${dl1.verifyMs.toFixed(1)}ms)`);

const { obj: restoredEnvelope1, decryptMs: decryptMs1 } = decryptJson(dl1.bytes);
assert(restoredEnvelope1.mode === 'checkpoint', 'restored envelope mode == checkpoint');

const tReplay1Start = performance.now();
const restoreDbPath1 = path.join(os.tmpdir(), `dmemo-c3-snap-restored-${Date.now()}.db`);
fs.writeFileSync(restoreDbPath1, Buffer.from(restoredEnvelope1.dbFileBase64, 'base64'));

const memory1b = new Memory(makeMemoryConfig(restoreDbPath1));
await memory1b._initPromise;
if (memory1b._initError) fail(`memory1b init failed: ${memory1b._initError.message}`);
memory1b.db.memoryStore = new Map(restoredEnvelope1.history);
const replayMs1 = performance.now() - tReplay1Start;

pass(`restored Memory instance from checkpoint (replay ${replayMs1.toFixed(1)}ms)`);

const searchesAfterRestore1 = await runSearches(memory1b);
console.log('[step1] post-restore search result IDs:', searchesAfterRestore1.map((r) => r.map((x) => x.id.slice(0, 8))));

const parity1 = compareSearchResults(searchesBeforeFlush1, searchesAfterRestore1);
assert(parity1, 'STEP 1 search parity: identical IDs and scores before flush vs after restore');

fs.unlinkSync(restoreDbPath1);

results.snapshot = {
  ...results.snapshot,
  memoriesAdded: addedIds1.length,
  embeddingDim,
  plaintextBytes: plainBytes1,
  ciphertextBytes: cipher1.length,
  encryptMs: encryptMs1,
  uploadMs: upload1.uploadMs,
  flushMs: flushTimeStep1,
  costWei: upload1.costWei.toString(),
  restore: {
    pointerResolveMs: restoreResolve1.elapsedMs,
    downloadMs: dl1.downloadMs,
    merkleVerifyMs: dl1.verifyMs,
    decryptMs: decryptMs1,
    replayMs: replayMs1,
    totalMs: restoreResolve1.elapsedMs + dl1.downloadMs + dl1.verifyMs + decryptMs1 + replayMs1,
  },
  parityPassed: parity1,
};

// ===========================================================================
// STEP 2 — journal mode
// ===========================================================================
section('STEP 2: journal mode');

// Pack/unpack embedding vectors as base64-encoded Float32Array bytes rather
// than raw JSON number arrays. FOUND LIVE (see RESULTS.md): a naive
// JSON-array delta encoding renders each float as ~15-18 ASCII characters,
// which made a 48-memory delta (~530KB) larger than the equivalent full
// snapshot checkpoint (~181KB, where MemoryVectorStore stores vectors as
// packed binary BLOBs) — the opposite of what a "delta" flush is supposed to
// buy you. Packing to base64 Float32Array bytes mirrors MemoryVectorStore's
// own on-disk encoding (Buffer.from(new Float32Array(v).buffer)) and cuts
// per-float storage from ~17 bytes of JSON text to ~5.3 bytes of base64.
function packVector(vec) {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}
function unpackVector(b64) {
  const buf = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

class JournalingVectorStore {
  constructor(native) {
    this.native = native;
    this.journal = [];
  }
  async initialize() {
    return this.native.initialize();
  }
  async insert(vectors, ids, payloads) {
    await this.native.insert(vectors, ids, payloads);
    this.journal.push({ op: 'insert', vectors: vectors.map(packVector), ids, payloads });
  }
  async update(vectorId, vector, payload) {
    await this.native.update(vectorId, vector, payload);
    this.journal.push({ op: 'update', vectorId, vector: packVector(vector), payload });
  }
  async delete(vectorId) {
    await this.native.delete(vectorId);
    this.journal.push({ op: 'delete', vectorId });
  }
  async deleteCol() {
    await this.native.deleteCol();
    this.journal.push({ op: 'deleteCol' });
  }
  // reads/search delegate untouched, never journaled
  search(...a) { return this.native.search(...a); }
  keywordSearch(...a) { return this.native.keywordSearch ? this.native.keywordSearch(...a) : Promise.resolve(null); }
  get(...a) { return this.native.get(...a); }
  list(...a) { return this.native.list(...a); }
  getUserId() { return this.native.getUserId(); }
  setUserId(u) { return this.native.setUserId(u); }
  drainJournal() {
    const j = this.journal;
    this.journal = [];
    return j;
  }
}

const journalDbPath = path.join(os.tmpdir(), `dmemo-c3-journal-${Date.now()}.db`);
const memory2 = new Memory(makeMemoryConfig(journalDbPath));
await memory2._initPromise;
if (memory2._initError) fail(`memory2 init failed: ${memory2._initError.message}`);

// Swap in the journaling proxy. `vectorStore` is a TS-`private` field, but TS
// privacy is erased at runtime (plain class, no `#` private fields) — this is
// a property substitution with an interface-conformant wrapper, not a patch
// to mem0's source or prototypes. See RESULTS.md for why this was necessary:
// mem0ai 3.1.1's VectorStoreFactory only accepts string providers from a
// hardcoded switch — there is no documented instance/custom-provider
// injection point in the published package.
const nativeStore2 = memory2.vectorStore;
const journalStore = new JournalingVectorStore(nativeStore2);
memory2.vectorStore = journalStore;
pass('journaling VectorStore proxy installed over native store (post-init property swap)');

let historyFlushedCount = 0;
function drainNewHistory(memory) {
  const all = [...memory.db.memoryStore.entries()];
  const fresh = all.slice(historyFlushedCount);
  historyFlushedCount = all.length;
  return fresh;
}

// --- batch A: add() -> flush delta A ---------------------------------------
const idsA = await addAllTurns(memory2, TURNS);
console.log(`[step2] batch A: added ${idsA.length} memories`);

const vectorOpsA = journalStore.drainJournal();
const historyA = drainNewHistory(memory2);

const deltaAEnvelope = {
  specVersion: 'dmemo-spike-v0',
  mode: 'delta',
  seq: 0,
  prevRootHash: null,
  createdAt: new Date().toISOString(),
  vectorOps: vectorOpsA,
  historyEntries: historyA,
};
const { ciphertext: cipherA, plaintextBytes: plainBytesA, encryptMs: encryptMsA } = encryptJson(deltaAEnvelope);
const uploadA = await uploadBlob(cipherA, 'step2-deltaA');
console.log(`[step2] PASS uploaded delta A — tx ${uploadA.txHash}, root ${uploadA.rootHash}, ${plainBytesA}B plaintext / ${cipherA.length}B cipher, ${uploadA.uploadMs.toFixed(0)}ms, cost ${ethers.formatEther(uploadA.costWei)} 0G`);

// --- batch B: a few more turns -> flush delta B (small, chained via prevRootHash) ---
const idsB = await addAllTurns(memory2, EXTRA_TURNS);
console.log(`[step2] batch B: added ${idsB.length} memories`);

const searchesBeforeFlush2 = await runSearches(memory2);
console.log('[step2] pre-flush search result IDs:', searchesBeforeFlush2.map((r) => r.map((x) => x.id.slice(0, 8))));

const vectorOpsB = journalStore.drainJournal();
const historyB = drainNewHistory(memory2);

const deltaBEnvelope = {
  specVersion: 'dmemo-spike-v0',
  mode: 'delta',
  seq: 1,
  prevRootHash: uploadA.rootHash,
  createdAt: new Date().toISOString(),
  vectorOps: vectorOpsB,
  historyEntries: historyB,
};
const { ciphertext: cipherB, plaintextBytes: plainBytesB, encryptMs: encryptMsB } = encryptJson(deltaBEnvelope);
const uploadB = await uploadBlob(cipherB, 'step2-deltaB');
console.log(`[step2] PASS uploaded delta B — tx ${uploadB.txHash}, root ${uploadB.rootHash}, ${plainBytesB}B plaintext / ${cipherB.length}B cipher, ${uploadB.uploadMs.toFixed(0)}ms, cost ${ethers.formatEther(uploadB.costWei)} 0G`);

const flushTimeA = encryptMsA + uploadA.uploadMs;
const flushTimeB = encryptMsB + uploadB.uploadMs;

// --- wipe --------------------------------------------------------------
fs.unlinkSync(journalDbPath);
pass('wiped local journal-mode state (deleted temp db file)');

// --- restore: resolve latest (deltaB) -> walk prevRootHash chain ------------
const restoreResolve2 = await resolveLatestRootHash();
assert(restoreResolve2.rootHash.toLowerCase() === uploadB.rootHash.toLowerCase(), 'eth_getLogs-resolved root hash matches latest delta (deltaB)');

let cumulativeDownloadMs = 0;
let cumulativeVerifyMs = 0;
let cumulativeDecryptMs = 0;

const dlB = await downloadAndVerify(restoreResolve2.rootHash);
cumulativeDownloadMs += dlB.downloadMs;
cumulativeVerifyMs += dlB.verifyMs;
const { obj: envelopeB, decryptMs: decryptMsB } = decryptJson(dlB.bytes);
cumulativeDecryptMs += decryptMsB;
pass(`downloaded + verified + decrypted delta B (seq ${envelopeB.seq}, prevRootHash ${envelopeB.prevRootHash})`);

const chain = [envelopeB];
let cursor = envelopeB.prevRootHash;
while (cursor) {
  const dl = await downloadAndVerify(cursor);
  cumulativeDownloadMs += dl.downloadMs;
  cumulativeVerifyMs += dl.verifyMs;
  const { obj: env, decryptMs } = decryptJson(dl.bytes);
  cumulativeDecryptMs += decryptMs;
  pass(`downloaded + verified + decrypted delta by prevRootHash chain link (seq ${env.seq})`);
  chain.push(env);
  cursor = env.prevRootHash;
}
chain.reverse(); // oldest -> newest
assert(chain.length === 2 && chain[0].seq === 0 && chain[1].seq === 1, 'delta chain resolved in correct order [deltaA, deltaB] via prevRootHash');

// --- replay: fresh native store + fresh history map, apply deltas in order --
const tReplay2Start = performance.now();
const restoreDbPath2 = path.join(os.tmpdir(), `dmemo-c3-journal-restored-${Date.now()}.db`);
const memory2b = new Memory(makeMemoryConfig(restoreDbPath2));
await memory2b._initPromise;
if (memory2b._initError) fail(`memory2b init failed: ${memory2b._initError.message}`);

const freshNative = memory2b.vectorStore; // untouched native store, fresh + empty
const historyMap = new Map();
for (const delta of chain) {
  for (const op of delta.vectorOps) {
    if (op.op === 'insert') await freshNative.insert(op.vectors.map(unpackVector), op.ids, op.payloads);
    else if (op.op === 'update') await freshNative.update(op.vectorId, unpackVector(op.vector), op.payload);
    else if (op.op === 'delete') await freshNative.delete(op.vectorId);
    else if (op.op === 'deleteCol') await freshNative.deleteCol();
  }
  for (const [id, entry] of delta.historyEntries) historyMap.set(id, entry);
}
memory2b.db.memoryStore = historyMap;
const replayMs2 = performance.now() - tReplay2Start;
pass(`replayed ${chain.reduce((n, d) => n + d.vectorOps.length, 0)} vector ops + ${historyMap.size} history entries from ${chain.length} deltas (replay ${replayMs2.toFixed(1)}ms)`);

const searchesAfterRestore2 = await runSearches(memory2b);
console.log('[step2] post-restore search result IDs:', searchesAfterRestore2.map((r) => r.map((x) => x.id.slice(0, 8))));

const parity2 = compareSearchResults(searchesBeforeFlush2, searchesAfterRestore2);
assert(parity2, 'STEP 2 search parity: identical IDs and scores before flush vs after journal replay');

fs.unlinkSync(restoreDbPath2);

results.journal = {
  batchA: { memoriesAdded: idsA.length, plaintextBytes: plainBytesA, ciphertextBytes: cipherA.length, encryptMs: encryptMsA, uploadMs: uploadA.uploadMs, flushMs: flushTimeA, costWei: uploadA.costWei.toString() },
  batchB: { memoriesAdded: idsB.length, plaintextBytes: plainBytesB, ciphertextBytes: cipherB.length, encryptMs: encryptMsB, uploadMs: uploadB.uploadMs, flushMs: flushTimeB, costWei: uploadB.costWei.toString() },
  restore: {
    pointerResolveMs: restoreResolve2.elapsedMs,
    downloadMs: cumulativeDownloadMs,
    merkleVerifyMs: cumulativeVerifyMs,
    decryptMs: cumulativeDecryptMs,
    replayMs: replayMs2,
    totalMs: restoreResolve2.elapsedMs + cumulativeDownloadMs + cumulativeVerifyMs + cumulativeDecryptMs + replayMs2,
    chainLength: chain.length,
  },
  parityPassed: parity2,
};

// ===========================================================================
// wrap up
// ===========================================================================
section('SUMMARY');

const balanceAfter = await provider.getBalance(wallet.address);
results.balanceAfter = ethers.formatEther(balanceAfter);
results.totalCostWei = totalCostWei.toString();
results.totalCostEth = ethers.formatEther(totalCostWei);
results.flushLog = flushLog;

console.log(`balance before: ${results.balanceBefore} 0G`);
console.log(`balance after:  ${results.balanceAfter} 0G`);
console.log(`total spend this run: ${results.totalCostEth} 0G across ${flushLog.length} flushes`);
console.log(JSON.stringify(results, null, 2));

fs.writeFileSync(new URL('./c3-results.json', import.meta.url), JSON.stringify(results, null, 2));

const allPassed = parity1 && parity2 && failures === 0;
console.log(allPassed ? '\n=== ALL CHECKS PASSED ===' : '\n=== SOME CHECKS FAILED ===');
if (!allPassed) process.exitCode = 1;
else process.exitCode = 0;
// Do NOT call process.exit() here — see header comment: it aborts with a
// libc++abi mutex error during fastembed/onnxruntime-node native teardown.
