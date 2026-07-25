import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Memory as Mem0Memory, MemoryConfig } from 'mem0ai/oss';
import {
  SPEC_VERSION,
  encodeBlob,
  decodeBlob,
  BlobDecodeError,
  type Blob as DmemoBlob,
  type DeltaBlob,
  type CheckpointBlob,
  type EnvelopeMeta,
  type EmbedderIdentity,
  type HistoryEntryTuple,
  type HistoryEntryRecord,
  type VectorOp,
} from '@dmemo/blob-spec';
import {
  StorageClient,
  BlobUnretrievableError,
  BlobCorruptError,
  type ResolvedPointer,
} from './storage/client.js';
import { resolveNetworkConfig, type NetworkName, type NetworkOverrides } from './storage/network.js';
import { JournalingVectorStore } from './store/journal.js';
import {
  resolveEmbedderConfig,
  getEmbedderIdentity,
  embedderIdentityEquals,
  type ExplicitEmbedderConfig,
  type ResolvedEmbedderConfig,
} from './embedder.js';
import { internals } from './mem0Internal.js';
import { ensureBetterSqlite3Compat } from './runtime/bunSqliteCompat.js';

const require = createRequire(import.meta.url);
const MEM0_ENGINE_VERSION: string = (() => {
  try {
    return (require('mem0ai/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

// T1.4 — flush engine + session lifecycle (D3, D4). See TASKS.md's API
// sketch:
//   const session = await DmemoSession.open({wallet, network, scope})
//   const results = await session.memory.search(query, {topK})
//   await session.memory.add(messages, {infer: cfg.infer})
//   session.flush()
//   await session.close()

export interface OpenSessionOptions {
  privateKey: string;
  scope: string;
  network?: NetworkName;
  networkOverrides?: NetworkOverrides;
  embedder?: ExplicitEmbedderConfig;
  checkpointEveryNFlushes?: number;
  checkpointSizeThresholdBytes?: number;
  uploadTimeoutMs?: number;
  /** App-level per-attempt download timeout during restore (F6). See
   * `StorageClientOptions.downloadTimeoutMs`. */
  downloadTimeoutMs?: number;
  pointerCachePath?: string;
}

export interface FlushLogEntry {
  kind: 'delta' | 'checkpoint';
  rootHash: string;
  seq: number;
  uploadMs: number;
  costWei: bigint;
  bytes: number;
}

/** F6: why a blob was left out of the restored chain. Root hashes and
 * reasons only — never plaintext/decrypted content — so this is always safe
 * to log or surface to a caller.
 *  - `'transient'` / `'unretrievable'`: not proof of data loss — the blob
 *    could not be confirmed *right now* (network/timeout, or the SDK/Merkle
 *    layer reporting it absent/mismatched). Never treated as corruption.
 *  - `'corrupt'`: a definitive, deterministic failure on data whose Merkle
 *    root already matched the on-chain value — undecryptable, structurally
 *    undecodable, or (decoded fine but) unreplayable content. Retrying
 *    cannot change this.
 *  - `'orphaned'`: unreachable, AND this client holds a local record of an
 *    upload it started in that block range and never confirmed. The Submit
 *    transaction mines before segment data is durable, so an abandoned upload
 *    leaves a paid-for pointer with nothing behind it — permanently. That is
 *    our own wreckage, not a peer's intact blob, so walking back past it is
 *    correct rather than destructive. Nothing was ever chained onto it.
 */
export type BlobSkipReason = 'transient' | 'unretrievable' | 'corrupt' | 'orphaned';

export interface SkippedBlobInfo {
  rootHash: string;
  reason: BlobSkipReason;
  /** Short, non-sensitive diagnostic (error message) — no key material or
   * memory content. */
  detail: string;
}

export interface RestoreStats {
  restored: boolean;
  chainLength: number;
  pointerResolveMs: number;
  downloadMs: number;
  verifyMs: number;
  decryptMs: number;
  replayMs: number;
  totalMs: number;
  reembedMigrated: boolean;
  /** Count of `skippedBlobs` below — kept for backward compatibility with
   * the original gotcha-20 field name/shape. */
  danglingPointersSkipped: number;
  /** F6: every blob skipped while walking back to a restorable chain,
   * newest-first, with why. Empty on a clean restore. This is the visible,
   * structured record of any data loss — see `BlobSkipReason`. */
  skippedBlobs: SkippedBlobInfo[];
}

/**
 * F6: thrown when no candidate pointer produced a complete, restorable
 * chain at all (every candidate's walk-back was exhausted). Carries the
 * full skip list so the caller gets an actionable answer to "is this
 * temporary or is my memory actually gone" instead of a bare message.
 */
export class RestoreChainUnavailableError extends Error {
  readonly skipped: SkippedBlobInfo[];
  constructor(candidates: readonly Pick<ResolvedPointer, 'txSeq'>[], skipped: SkippedBlobInfo[]) {
    const anyCorrupt = skipped.some((s) => s.reason === 'corrupt');
    const verdict = anyCorrupt
      ? 'at least one blob is confirmed corrupt/unreplayable — this chain segment is unrecoverable, not just temporarily unavailable'
      : 'every failure looks transient/unretrievable (network, timeout, or not-yet-finalized) — this may be temporary; retry later before assuming data loss';
    const seqRange =
      candidates.length > 0 ? `txSeq ${candidates[candidates.length - 1]!.txSeq}..${candidates[0]!.txSeq}` : '(no candidates)';
    super(
      `dmemo restore failed: none of the ${candidates.length} most recent on-chain pointers (${seqRange}) ` +
        `produced a complete, restorable chain (${skipped.length} blob(s) skipped — ${verdict})`
    );
    this.name = 'RestoreChainUnavailableError';
    this.skipped = skipped;
  }
}

function classifyDownloadError(e: unknown): BlobSkipReason {
  if (e instanceof BlobCorruptError || e instanceof BlobDecodeError) return 'corrupt';
  if (e instanceof BlobUnretrievableError) return e.reason;
  // Defensive default for an unclassified throw (e.g. a bug elsewhere): never
  // invent a 'corrupt' verdict we can't back up — treat as transient so an
  // unexpected error can't be mistaken for confirmed, permanent data loss.
  // Under resolveRestoreChain's refuse-don't-degrade rule below, 'transient'
  // now correctly biases toward refusing to open rather than toward
  // silently orphaning a possibly-intact head.
  return 'transient';
}

/**
 * F6 follow-up: thrown by `resolveRestoreChain` when an older candidate
 * fully resolved, but a NEWER candidate was abandoned for a reason that is
 * NOT confirmed permanent (`'transient'`/`'unretrievable'`). Degrading to
 * that older candidate would look like a successful restore, but would
 * cache/chain onto it — and `resolveCandidates()`'s search window is keyed
 * off the newest known-good pointer, so once an older pointer is cached the
 * abandoned newer blob is never walked back to again (permanently orphaned,
 * even though it was probably still intact and merely unreachable *right
 * now*). Refusing to open is recoverable (retry once the transient
 * condition clears — nothing is cached, written, or chained onto); silently
 * degrading is not. Distinct from `RestoreChainUnavailableError`, which
 * means every candidate is confirmed-or-suspected genuinely gone.
 */
export class RestoreTemporarilyUnavailableError extends Error {
  readonly skipped: SkippedBlobInfo[];
  constructor(candidates: readonly Pick<ResolvedPointer, 'txSeq'>[], skipped: SkippedBlobInfo[]) {
    const seqRange =
      candidates.length > 0 ? `txSeq ${candidates[candidates.length - 1]!.txSeq}..${candidates[0]!.txSeq}` : '(no candidates)';
    super(
      `dmemo restore deferred: the newest blob(s) in this wallet's chain (${seqRange}) are temporarily ` +
        `unreachable (network, timeout, or not-yet-finalized — NOT confirmed corrupt) while an older blob ` +
        `resolved cleanly. Refusing to open onto that older blob rather than permanently orphaning the ` +
        `current head — your memory is intact; retry later (${skipped.length} blob(s) currently unreachable).`
    );
    this.name = 'RestoreTemporarilyUnavailableError';
    this.skipped = skipped;
  }
}

export interface ChainEntry {
  rootHash: string;
  blob: DmemoBlob;
}

interface RestoreChainDeps {
  downloadAndVerify(rootHash: string): Promise<{ plaintext: Buffer; downloadMs: number; verifyMs: number; decryptMs: number }>;
}

interface RestoreChainResult {
  pointer: ResolvedPointer;
  /** Newest -> oldest (matches the walk-back order; caller reverses). */
  chain: ChainEntry[];
  skipped: SkippedBlobInfo[];
  downloadMs: number;
  verifyMs: number;
  decryptMs: number;
  decodeMs: number;
}

/**
 * F6: the pure chain-walk-back at the heart of restore. Given the wallet's
 * most-recent Submit-log candidates (newest first) and a `downloadAndVerify`
 * primitive, walk `prevRootHash` back from each candidate's head until a
 * checkpoint (or a chain-root delta, `prevRootHash === null`) is reached.
 *
 * A failure ANYWHERE in one candidate's walk discards that whole attempt —
 * not because failures are treated as equally severe, but because a delta
 * chain has no meaning without its unbroken ancestor set: if blob X is bad,
 * every blob newer than X was computed as an incremental diff on top of
 * exactly X's state, so none of them can be safely replayed either. The
 * next-older Submit-log candidate is therefore the correct, minimal
 * walk-back unit — not a blanket reset to the last checkpoint — since (for a
 * wallet with no interleaved dangling retries) each candidate corresponds to
 * exactly one blob's position in the real chain.
 *
 * Refuse rather than degrade: if the FIRST candidate that fully resolves is
 * not the newest one, some newer candidate was abandoned along the way. If
 * any of those abandonments was `'transient'`/`'unretrievable'` (as opposed
 * to confirmed `'corrupt'`), the true head may still be intact — merely
 * unreachable right now — so this throws `RestoreTemporarilyUnavailableError`
 * instead of returning the older candidate: caching/chaining onto it would
 * permanently orphan a probably-recoverable newer blob (see that class's
 * doc). Only when EVERY abandoned newer candidate was confirmed `'corrupt'`
 * (nothing left to wait for) does this degrade to the older, fully-resolved
 * candidate, exactly as before.
 *
 * Kept dependency-injected (just `downloadAndVerify`) and side-effect-free
 * so it is unit-testable with a fake in `session.test.ts`, with no network,
 * mem0, or 0G SDK involved.
 */
export async function resolveRestoreChain(
  candidates: readonly ResolvedPointer[],
  deps: RestoreChainDeps
): Promise<RestoreChainResult> {
  const skipped: SkippedBlobInfo[] = [];
  let downloadMs = 0;
  let verifyMs = 0;
  let decryptMs = 0;
  let decodeMs = 0;

  for (const candidate of candidates) {
    const attempt: ChainEntry[] = [];
    let cursor: string | null = candidate.rootHash;
    let ok = true;

    while (cursor) {
      let dl;
      try {
        dl = await deps.downloadAndVerify(cursor);
      } catch (e) {
        let reason = classifyDownloadError(e);
        // Only the candidate's own head can be our abandoned upload: the
        // marker says we submitted *one* pointer we never confirmed, and
        // nothing was chained onto it, so its ancestors were written by
        // confirmed uploads and an unreachable one there is a real outage.
        if (reason !== 'corrupt' && candidate.orphanSuspect && cursor === candidate.rootHash) {
          reason = 'orphaned';
        }
        skipped.push({ rootHash: cursor, reason, detail: (e as Error).message });
        ok = false;
        break;
      }
      downloadMs += dl.downloadMs;
      verifyMs += dl.verifyMs;
      decryptMs += dl.decryptMs;

      const tDecode = performance.now();
      let blob: DmemoBlob;
      try {
        blob = decodeBlob(dl.plaintext);
      } catch (e) {
        decodeMs += performance.now() - tDecode;
        skipped.push({ rootHash: cursor, reason: 'corrupt', detail: (e as Error).message });
        ok = false;
        break;
      }
      decodeMs += performance.now() - tDecode;

      attempt.push({ rootHash: cursor, blob });
      if (blob.kind === 'checkpoint') break; // fully materialized — stop walking further back
      cursor = blob.meta.prevRootHash;
    }

    if (ok) {
      // Every `skipped` entry accumulated so far belongs to a candidate
      // NEWER than this one (we return on the first full success, so we
      // never reach here after skipping an older candidate). If any of
      // them was not confirmed corrupt, refuse rather than silently
      // degrading onto this older candidate — see
      // `RestoreTemporarilyUnavailableError`'s doc.
      const anyNewerMaybeRecoverable = skipped.some((s) => s.reason !== 'corrupt' && s.reason !== 'orphaned');
      if (anyNewerMaybeRecoverable) {
        throw new RestoreTemporarilyUnavailableError(candidates, skipped);
      }
      return { pointer: candidate, chain: attempt, skipped, downloadMs, verifyMs, decryptMs, decodeMs };
    }
    // This candidate's chain is incomplete/unusable end to end (see doc
    // above) — fall through to the next-older Submit-log candidate.
  }

  throw new RestoreChainUnavailableError(candidates, skipped);
}

interface ApplyRestoreChainDeps {
  applyCheckpoint(rows: CheckpointBlob['vectors']): Promise<void>;
  applyOp(op: VectorOp): Promise<void>;
}

export interface ApplyRestoreChainResult {
  /** The newest blob that applied cleanly, or `null` if not even the oldest
   * (first) blob in the chain could be replayed. */
  lastGood: ChainEntry | null;
  /** How many blobs (from the oldest) applied cleanly before any truncation. */
  appliedCount: number;
  historyMap: Map<string, HistoryEntryRecord>;
  /** Populated with exactly one `'corrupt'` entry if a replay failure
   * truncated the chain; empty on a clean apply of every blob. */
  skipped: SkippedBlobInfo[];
}

/**
 * F6: apply an oldest-to-newest chain of already-downloaded, Merkle-verified,
 * structurally-decoded blobs to the (fresh, empty) native store, truncating
 * at the first blob that fails to replay rather than throwing uncaught.
 *
 * This is the other half of F6 (`resolveRestoreChain` above handles
 * download/decode-time corruption; this handles corruption that survives
 * both — decodeBlob()'s validation is intentionally shallow, e.g. it only
 * checks `vector` is *a string*, not that it's well-formed base64/Float32
 * bytes of the right dimension — see blob-spec/codec.ts). Gotcha 6: AES-CTR
 * has no auth tag, so this kind of corruption can hide until replay actually
 * touches the bytes; it is deterministic, so callers must not retry it, only
 * truncate to the last blob that DID apply cleanly.
 *
 * A failure on blob N drops N and every blob newer than it (each newer blob
 * is an incremental diff computed on top of exactly N's — and therefore
 * every earlier blob's — state, so none of them can be safely replayed
 * either), but every strictly-older blob that already applied stands.
 *
 * Kept dependency-injected and side-effect-free (beyond calling the two
 * deps) so it is unit-testable with fakes in `session.test.ts`, with no
 * mem0/journal/embedder machinery involved.
 */
export async function applyRestoreChain(
  chainOldestFirst: readonly ChainEntry[],
  deps: ApplyRestoreChainDeps
): Promise<ApplyRestoreChainResult> {
  const historyMap = new Map<string, HistoryEntryRecord>();
  const skipped: SkippedBlobInfo[] = [];
  let lastGood: ChainEntry | null = null;
  let appliedCount = 0;

  for (const entry of chainOldestFirst) {
    const { blob, rootHash } = entry;
    try {
      if (blob.kind === 'checkpoint') {
        await deps.applyCheckpoint(blob.vectors);
      } else {
        for (const op of blob.vectorOps) await deps.applyOp(op);
      }
    } catch (e) {
      skipped.push({ rootHash, reason: 'corrupt', detail: `unreplayable: ${(e as Error).message}` });
      break; // truncate: this blob and every newer one are dropped, see doc above
    }
    for (const [id, rec] of blob.historyEntries as HistoryEntryTuple[]) historyMap.set(id, rec);
    lastGood = entry;
    appliedCount++;
  }

  return { lastGood, appliedCount, historyMap, skipped };
}

const DEFAULT_CHECKPOINT_K = 2;
const DEFAULT_CHECKPOINT_SIZE_THRESHOLD_BYTES = 64 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

function buildMemoryConfig(dbPath: string, embedderCfg: ResolvedEmbedderConfig): Partial<MemoryConfig> {
  return {
    embedder: embedderCfg.mem0Config,
    vectorStore: { provider: 'memory', config: { dbPath, collectionName: 'memories' } },
    // Never actually called: dMemo always passes infer:false on add(). A
    // valid-looking (but unused, non-network) config is required because
    // MemoryConfigSchema validates the llm slot eagerly at construction —
    // see spike/c3-mem0-loop.mjs's makeMemoryConfig for the same pattern.
    // This is NOT a silent remote-LLM default (T1.5's privacy claim): it is
    // never reached because infer is always false for dMemo-captured turns.
    llm: { provider: 'openai', config: { apiKey: 'unused-dmemo-infer-false', model: 'gpt-5-mini' } },
    historyStore: { provider: 'memory', config: {} },
  };
}

export class DmemoSession {
  readonly memory: Mem0Memory;
  readonly scope: string;
  readonly restoreStats: RestoreStats;
  readonly flushLog: FlushLogEntry[] = [];

  private readonly storage: StorageClient;
  private readonly journal: JournalingVectorStore;
  private readonly dbPath: string;
  private readonly checkpointEveryNFlushes: number;
  private readonly checkpointSizeThresholdBytes: number;

  private embedderIdentity: EmbedderIdentity;
  private seq: number;
  private prevRootHash: string | null;
  private deltasSinceCheckpoint: number;
  private historyFlushedCount: number;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;
  private droppedFlushBatches = 0;

  private constructor(opts: {
    memory: Mem0Memory;
    scope: string;
    storage: StorageClient;
    journal: JournalingVectorStore;
    dbPath: string;
    checkpointEveryNFlushes: number;
    checkpointSizeThresholdBytes: number;
    embedderIdentity: EmbedderIdentity;
    seq: number;
    prevRootHash: string | null;
    deltasSinceCheckpoint: number;
    historyFlushedCount: number;
    restoreStats: RestoreStats;
  }) {
    this.memory = opts.memory;
    this.scope = opts.scope;
    this.storage = opts.storage;
    this.journal = opts.journal;
    this.dbPath = opts.dbPath;
    this.checkpointEveryNFlushes = opts.checkpointEveryNFlushes;
    this.checkpointSizeThresholdBytes = opts.checkpointSizeThresholdBytes;
    this.embedderIdentity = opts.embedderIdentity;
    this.seq = opts.seq;
    this.prevRootHash = opts.prevRootHash;
    this.deltasSinceCheckpoint = opts.deltasSinceCheckpoint;
    this.historyFlushedCount = opts.historyFlushedCount;
    this.restoreStats = opts.restoreStats;
  }

  /** Restore (or freshly start) a session for `scope` on `network`, per
   * T1.4's `open()` contract: resolveCandidates -> download checkpoint +
   * subsequent deltas (walking `prevRootHash`) -> verify each -> decrypt ->
   * replay into a fresh native store at a temp path. Empty chain = fresh
   * store (first run for this wallet). */
  static async open(opts: OpenSessionOptions): Promise<DmemoSession> {
    // Must be set before the dynamic import below — mem0ai/oss reads
    // process.env.MEM0_TELEMETRY at module-eval time (gotcha 13).
    process.env.MEM0_TELEMETRY = 'false';

    // Also strictly before that import: mem0ai/oss statically imports
    // better-sqlite3, a V8-C++ addon that ABORTS the process on Bun rather
    // than throwing (oven-sh/bun#4290). Route it to bun:sqlite first. No-op
    // on Node. If it cannot be installed we must NOT reach the import —
    // raising here keeps the failure catchable, so an in-process host like
    // OpenCode fails open with memory disabled instead of dying.
    const sqliteCompat = await ensureBetterSqlite3Compat();
    if (sqliteCompat.isBun && !sqliteCompat.installed) {
      throw new Error(
        `dmemo cannot start on this Bun runtime: ${sqliteCompat.reason}. ` +
          `mem0's sqlite store would abort the process (see oven-sh/bun#4290).`
      );
    }

    const { Memory: MemoryCtor } = await import('mem0ai/oss');

    const networkConfig = resolveNetworkConfig(opts.network ?? 'testnet', opts.networkOverrides ?? {});
    const storage = new StorageClient({
      network: networkConfig,
      privateKey: opts.privateKey,
      pointerCachePath: opts.pointerCachePath,
      uploadTimeoutMs: opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
      downloadTimeoutMs: opts.downloadTimeoutMs,
    });

    const embedderCfg = await resolveEmbedderConfig(opts.embedder);

    const dbPath = path.join(
      os.tmpdir(),
      `dmemo-${storage.address.slice(2, 10)}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );

    const memory = new MemoryCtor(buildMemoryConfig(dbPath, embedderCfg));
    await internals(memory)._initPromise;
    const initError = internals(memory)._initError;
    if (initError) throw initError;

    const nativeStore = internals(memory).vectorStore;
    const journal = new JournalingVectorStore(nativeStore);
    // Post-init property swap (gotcha 11): mem0ai 3.1.1's VectorStoreFactory
    // has no custom-provider registration path in this version. `vectorStore`
    // is a plain-class TS-`private` field (no `#` privacy), erased at
    // runtime — proven live in spike/c3-mem0-loop.mjs.
    internals(memory).vectorStore = journal;

    let currentEmbedderIdentity = await getEmbedderIdentity(memory, embedderCfg.provider, embedderCfg.model);

    const restoreStats: RestoreStats = {
      restored: false,
      chainLength: 0,
      pointerResolveMs: 0,
      downloadMs: 0,
      verifyMs: 0,
      decryptMs: 0,
      replayMs: 0,
      totalMs: 0,
      reembedMigrated: false,
      danglingPointersSkipped: 0,
      skippedBlobs: [],
    };

    let seq = 0;
    let prevRootHash: string | null = null;
    let deltasSinceCheckpoint = 0;
    let historyFlushedCount = 0;

    // A Submit log lands on-chain when the upload *transaction* is mined —
    // BEFORE segment data is durable on storage nodes, so a crashed/failed
    // upload leaves a dangling pointer shadowing the last good blob
    // (gotcha 20). F6: the newest blob can also be durably present and
    // Merkle-valid yet still be corrupt or unreplayable. Try candidates
    // newest-first, walking back one blob (one Submit-log candidate) at a
    // time, until a fully retrievable, decodable chain is found — see
    // resolveRestoreChain()'s doc for why "one blob at a time" is exactly
    // what iterating candidates already gives us.
    const candidates = await storage.resolveCandidates();
    restoreStats.pointerResolveMs = candidates[0]?.elapsedMs ?? 0;

    let pointer: ResolvedPointer | null = null;
    let chain: ChainEntry[] = [];
    let replayMs = 0;

    if (candidates.length > 0) {
      // NOTE: downloadMs/verifyMs/decryptMs (accumulated per-blob inside the
      // chain-walk) and replayMs are measured as DISJOINT spans — replayMs
      // covers only decode+apply-to-journal+history-merge, which happens
      // strictly after each blob's download/verify/decrypt — so that
      // totalMs (their sum) does not double-count. Failed candidates' time
      // is included: the stats measure real restore cost. Lets both
      // RestoreChainUnavailableError (every candidate exhausted) and
      // RestoreTemporarilyUnavailableError (a possibly-intact newer blob
      // was abandoned for a non-corrupt reason) propagate uncaught — F6:
      // fail clearly rather than silently falling back to "fresh store", or
      // silently orphaning a probably-recoverable head.
      const result = await resolveRestoreChain(candidates, {
        downloadAndVerify: (rootHash) => storage.downloadAndVerify(rootHash),
      });
      pointer = result.pointer;
      chain = result.chain;
      restoreStats.downloadMs += result.downloadMs;
      restoreStats.verifyMs += result.verifyMs;
      restoreStats.decryptMs += result.decryptMs;
      replayMs += result.decodeMs;
      restoreStats.skippedBlobs.push(...result.skipped);
      restoreStats.danglingPointersSkipped += result.skipped.length;
      for (const s of result.skipped) {
        console.warn(`[dmemo] blob ${s.rootHash} skipped during restore (${s.reason}): ${s.detail}; walking back`);
      }
    }

    if (pointer) {
      chain.reverse(); // oldest (base) -> newest

      const tApplyStart = performance.now();
      const applyResult = await applyRestoreChain(chain, {
        applyCheckpoint: (rows) => journal.applyCheckpointRows(rows),
        applyOp: (op) => journal.applyReplayOp(op),
      });
      restoreStats.skippedBlobs.push(...applyResult.skipped);
      restoreStats.danglingPointersSkipped += applyResult.skipped.length;
      for (const s of applyResult.skipped) {
        console.error(
          `[dmemo] blob ${s.rootHash} decoded but failed to replay (${s.detail}); ` +
            `restoring only the ${applyResult.appliedCount} older blob(s) applied so far`
        );
      }

      const lastGood = applyResult.lastGood;
      if (!lastGood) {
        // Every blob resolveRestoreChain resolved turned out to be
        // unreplayable — there is no partial state left to fall back to
        // inside this chain. Fail loudly instead of silently returning a
        // fresh, empty store: that would be indistinguishable from "this
        // wallet has no history" and would hide a genuine loss (never
        // silent, per F6's requirement).
        throw new RestoreChainUnavailableError(candidates, restoreStats.skippedBlobs);
      }

      internals(memory).db.memoryStore = applyResult.historyMap;
      replayMs += performance.now() - tApplyStart;

      seq = lastGood.blob.meta.seq + 1;
      prevRootHash = lastGood.rootHash;
      historyFlushedCount = applyResult.historyMap.size;
      deltasSinceCheckpoint =
        chain[0]!.blob.kind === 'checkpoint' ? applyResult.appliedCount - 1 : applyResult.appliedCount;

      // Only cache the pointer as "the" restored head when every resolved
      // blob actually applied — if replay truncated the chain,
      // `pointer.rootHash` is no longer the real restored head
      // (`lastGood.rootHash` is), and caching the wrong one would poison the
      // next resolveCandidates() call's search window with an unreplayable
      // pointer, never revisiting it (F6: must not make a skipped-but-maybe-
      // recoverable blob unreachable forever).
      if (applyResult.appliedCount === chain.length) {
        storage.savePointer(pointer);
      }

      restoreStats.replayMs = replayMs;
      restoreStats.restored = true;
      restoreStats.chainLength = applyResult.appliedCount;
      restoreStats.totalMs =
        restoreStats.pointerResolveMs +
        restoreStats.downloadMs +
        restoreStats.verifyMs +
        restoreStats.decryptMs +
        restoreStats.replayMs;

      // Embedder-identity-mismatch migration (T1.5): if the embedder that
      // produced the restored vectors differs from the one resolved for
      // this session, re-embed every stored memory's text and journal the
      // result as `update` ops (so the mismatch is durably fixed on the
      // next flush, not just patched in this session's local store).
      const restoredIdentity = lastGood.blob.meta.embedder;
      if (!embedderIdentityEquals(currentEmbedderIdentity, restoredIdentity)) {
        await reembedMigration(memory, journal, currentEmbedderIdentity);
        restoreStats.reembedMigrated = true;
      }
    }

    return new DmemoSession({
      memory,
      scope: opts.scope,
      storage,
      journal,
      dbPath,
      checkpointEveryNFlushes: opts.checkpointEveryNFlushes ?? DEFAULT_CHECKPOINT_K,
      checkpointSizeThresholdBytes: opts.checkpointSizeThresholdBytes ?? DEFAULT_CHECKPOINT_SIZE_THRESHOLD_BYTES,
      embedderIdentity: currentEmbedderIdentity,
      seq,
      prevRootHash,
      deltasSinceCheckpoint,
      historyFlushedCount,
      restoreStats,
    });
  }

  /** Batches dropped by the fail-open double-failure path in runFlush().
   * Anything > 0 means local memories exist that were NEVER persisted
   * remotely — callers that need durability (benchmarks, migration tools)
   * must check this before wiping local state. */
  get droppedFlushCount(): number {
    return this.droppedFlushBatches;
  }

  /** Fire-and-forget flush (D4): never blocks the caller. Internally
   * sequenced (a flush chain, not concurrent flushes) so seq/prevRootHash
   * stay consistent. In-flight failures: retry once, then log-and-drop
   * (fail-open — memory must never break the host). */
  flush(): void {
    if (this.closed) return;
    this.flushChain = this.flushChain.then(
      () => this.runFlush(),
      () => this.runFlush() // previous link swallowed its own errors; this is defensive
    );
  }

  /** Await completion of any currently in-flight/queued flush(es). Purely an
   * observability hook (tests, CLI tooling, "did my flush land yet?"
   * diagnostics) — normal host-adapter usage never needs this and must
   * never block on `flush()` itself (D4). */
  async waitForPendingFlush(): Promise<void> {
    await this.flushChain.catch(() => {});
  }

  /** Await any pending flush, then perform one final flush, then wipe local
   * state. Per T1.4: "final awaited flush -> wipe temp file + RAM". */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flushChain.catch(() => {});
    await this.runFlush();
    try {
      internals(this.memory).db.close();
    } catch {
      // history manager close is best-effort; provider 'memory' is a
      // pure in-RAM Map with nothing OS-level to release.
    }
    try {
      fs.unlinkSync(this.dbPath);
    } catch {
      // Non-fatal: temp file may already be gone, or the OS may still hold
      // an open fd on it (safe to unlink regardless on POSIX — the space is
      // reclaimed once the process's fd closes at exit).
    }
  }

  private async runFlush(): Promise<void> {
    const vectorOps = this.journal.drainJournal();
    const historyEntries = this.drainNewHistory();
    if (vectorOps.length === 0 && historyEntries.length === 0) return;

    const attempt = () => this.uploadFlushBlob(vectorOps, historyEntries);
    try {
      await attempt();
    } catch (e1) {
      console.warn(`[dmemo] flush upload failed, retrying once: ${(e1 as Error).message}`);
      try {
        await attempt();
      } catch (e2) {
        this.droppedFlushBatches += 1;
        console.error(
          `[dmemo] flush failed twice — dropping this batch (fail-open, ` +
            `${vectorOps.length} vector ops / ${historyEntries.length} history entries not persisted remotely this round): ${(e2 as Error).message}`
        );
      }
    }
  }

  private drainNewHistory(): HistoryEntryTuple[] {
    const map = internals(this.memory).db.memoryStore as Map<string, HistoryEntryRecord>;
    const all = Array.from(map.entries()) as HistoryEntryTuple[];
    const fresh = all.slice(this.historyFlushedCount);
    // Drained eagerly (symmetric with journal.drainJournal()) so a
    // double-failed flush behaves like the vector-ops side: the batch is
    // genuinely dropped, not resent forever.
    this.historyFlushedCount = all.length;
    return fresh;
  }

  private buildMeta(): EnvelopeMeta {
    return {
      specVersion: SPEC_VERSION,
      walletAddress: this.storage.address,
      agentScope: this.scope,
      seq: this.seq,
      prevRootHash: this.prevRootHash,
      embedder: this.embedderIdentity,
      engine: { name: 'mem0-oss', version: MEM0_ENGINE_VERSION },
      createdAt: new Date().toISOString(),
    };
  }

  private buildCheckpointBlob(meta: EnvelopeMeta): CheckpointBlob {
    const allHistory = Array.from(
      (internals(this.memory).db.memoryStore as Map<string, HistoryEntryRecord>).entries()
    ) as HistoryEntryTuple[];
    return { kind: 'checkpoint', meta, vectors: this.journal.snapshotRows(), historyEntries: allHistory };
  }

  private async uploadFlushBlob(vectorOps: VectorOp[], historyEntries: HistoryEntryTuple[]): Promise<void> {
    const candidateDeltaCount = this.deltasSinceCheckpoint + 1;
    const forceCheckpointByCount = candidateDeltaCount >= this.checkpointEveryNFlushes;

    const meta = this.buildMeta();
    let blob: DmemoBlob;
    if (forceCheckpointByCount) {
      blob = this.buildCheckpointBlob(meta);
    } else {
      const deltaBlob: DeltaBlob = { kind: 'delta', meta, vectorOps, historyEntries };
      // "accumulated state > size threshold" (T1.4): measured on this
      // flush's own delta payload — the thing that would otherwise go out
      // as a delta. If it alone exceeds the threshold, a checkpoint is not
      // just safer but usually smaller (spike found naive deltas can
      // exceed an equivalent checkpoint's size — see blob-spec/SPEC.md).
      const encodedDelta = encodeBlob(deltaBlob);
      blob = encodedDelta.length > this.checkpointSizeThresholdBytes ? this.buildCheckpointBlob(meta) : deltaBlob;
    }

    const plaintext = encodeBlob(blob);
    const upload = await this.storage.upload(plaintext);

    this.seq += 1;
    this.prevRootHash = upload.rootHash;
    this.deltasSinceCheckpoint = blob.kind === 'checkpoint' ? 0 : candidateDeltaCount;
    this.flushLog.push({
      kind: blob.kind,
      rootHash: upload.rootHash,
      seq: meta.seq,
      uploadMs: upload.uploadMs,
      costWei: upload.costWei,
      bytes: plaintext.length,
    });
  }
}

/** T1.5 re-embed migration: re-embed every currently-stored memory's text
 * with the newly-resolved embedder and journal the result as `update` ops,
 * so a restored session whose embedder differs from the one that produced
 * the chain gets durably fixed on the next flush (not just patched
 * in-memory for this session). */
async function reembedMigration(
  memory: Mem0Memory,
  journal: JournalingVectorStore,
  newIdentity: EmbedderIdentity
): Promise<void> {
  const rows = journal.snapshotRows();
  if (rows.length === 0) return;
  console.warn(
    `[dmemo] embedder identity mismatch at restore — re-embedding ${rows.length} memories with ` +
      `${newIdentity.provider}/${newIdentity.model} (dim ${newIdentity.dim})`
  );
  const embed = internals(memory).embedder.embed.bind(internals(memory).embedder);
  for (const row of rows) {
    const text = typeof row.payload['data'] === 'string' ? (row.payload['data'] as string) : '';
    if (!text) continue;
    const newVector = await embed(text);
    await journal.update(row.id, newVector, row.payload);
  }
}
