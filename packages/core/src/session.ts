import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Memory as Mem0Memory, MemoryConfig } from 'mem0ai/oss';
import {
  SPEC_VERSION,
  encodeBlob,
  decodeBlob,
  type Blob as DmemoBlob,
  type DeltaBlob,
  type CheckpointBlob,
  type EnvelopeMeta,
  type EmbedderIdentity,
  type HistoryEntryTuple,
  type HistoryEntryRecord,
  type VectorOp,
} from '@dmemo/blob-spec';
import { StorageClient } from './storage/client.js';
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
  /** Newest on-chain pointers skipped because their blob was unretrievable
   * or undecodable — dangling Submit logs from failed uploads (gotcha 20). */
  danglingPointersSkipped: number;
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
   * T1.4's `open()` contract: resolveLatest -> download checkpoint +
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
    };

    let seq = 0;
    let prevRootHash: string | null = null;
    let deltasSinceCheckpoint = 0;
    let historyFlushedCount = 0;

    // A Submit log lands on-chain when the upload *transaction* is mined —
    // BEFORE segment data is durable on storage nodes, so a crashed/failed
    // upload leaves a dangling pointer shadowing the last good blob
    // (gotcha 20). Try candidates newest-first until a fully retrievable,
    // decodable chain is found.
    const candidates = await storage.resolveCandidates();
    restoreStats.pointerResolveMs = candidates[0]?.elapsedMs ?? 0;

    let pointer: (typeof candidates)[number] | null = null;
    let chain: DmemoBlob[] = [];
    let replayMs = 0;
    for (const candidate of candidates) {
      try {
        // NOTE: downloadMs/verifyMs/decryptMs (accumulated per-blob inside
        // the chain-walk loop below) and replayMs are measured as DISJOINT
        // spans — replayMs covers only decode+apply-to-journal+history-merge,
        // which happens strictly after each blob's download/verify/decrypt —
        // so that totalMs (their sum) does not double-count. Failed
        // candidates' time is included: the stats measure real restore cost.
        const attempt: DmemoBlob[] = [];
        let cursor: string | null = candidate.rootHash;
        while (cursor) {
          const dl = await storage.downloadAndVerify(cursor);
          restoreStats.downloadMs += dl.downloadMs;
          restoreStats.verifyMs += dl.verifyMs;
          restoreStats.decryptMs += dl.decryptMs;
          const tDecodeStart = performance.now();
          const blob = decodeBlob(dl.plaintext);
          attempt.push(blob);
          replayMs += performance.now() - tDecodeStart;
          if (blob.kind === 'checkpoint') break; // fully materialized — stop walking further back
          cursor = blob.meta.prevRootHash;
        }
        pointer = candidate;
        chain = attempt;
        break;
      } catch (e) {
        restoreStats.danglingPointersSkipped++;
        console.warn(
          `[dmemo] on-chain pointer txSeq ${candidate.txSeq} (${candidate.rootHash}) is not restorable ` +
            `(${(e as Error).message}); walking back to the previous pointer`
        );
      }
    }
    if (!pointer && candidates.length > 0) {
      throw new Error(
        `dmemo restore failed: none of the ${candidates.length} most recent on-chain pointers ` +
          `(txSeq ${candidates[candidates.length - 1]!.txSeq}..${candidates[0]!.txSeq}) were retrievable`
      );
    }

    if (pointer) {
      chain.reverse(); // oldest (base) -> newest

      const tApplyStart = performance.now();
      const historyMap = new Map<string, HistoryEntryRecord>();
      for (const blob of chain) {
        if (blob.kind === 'checkpoint') {
          await journal.applyCheckpointRows(blob.vectors);
        } else {
          for (const op of blob.vectorOps) await journal.applyReplayOp(op);
        }
        for (const [id, rec] of blob.historyEntries as HistoryEntryTuple[]) historyMap.set(id, rec);
      }
      internals(memory).db.memoryStore = historyMap;
      replayMs += performance.now() - tApplyStart;

      const newest = chain[chain.length - 1]!;
      seq = newest.meta.seq + 1;
      prevRootHash = pointer.rootHash;
      storage.savePointer(pointer); // cache the pointer that actually restored, not the newest log
      historyFlushedCount = historyMap.size;
      deltasSinceCheckpoint = chain[0]!.kind === 'checkpoint' ? chain.length - 1 : chain.length;

      restoreStats.replayMs = replayMs;
      restoreStats.restored = true;
      restoreStats.chainLength = chain.length;
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
      const restoredIdentity = newest.meta.embedder;
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
