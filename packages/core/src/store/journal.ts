import type { VectorStore, VectorStoreResult, SearchFilters } from 'mem0ai/oss';
import {
  packVector,
  unpackVector,
  type VectorOp,
  type CheckpointVectorRow,
} from '@dmemo/blob-spec';

/**
 * T1.3 — journaling VectorStore wrapper (D7).
 *
 * Wraps mem0's native `VectorStore` instance and:
 *  1. Forwards every call to the native store unchanged (so search/read
 *     behavior is byte-for-byte identical to un-wrapped mem0).
 *  2. Records every mutating call (`insert`/`update`/`delete`/`deleteCol`)
 *     as a spec `VectorOp` (blob-spec's `packVector` for the base64
 *     Float32Array encoding, gotcha 14) into an in-memory journal that
 *     `flush()` drains.
 *  3. Maintains a materialized `Map<id, {vector, payload}>` mirror of
 *     current state. This exists because mem0ai@3.1.1's native store
 *     `list()`/`get()` do not return the embedding vector (only
 *     `{id, payload}`) — there is no public API to read back full vector
 *     rows, which checkpoint blobs need. The mirror is updated on every
 *     intercepted write and is the sole source for `snapshotRows()`.
 *
 * Installed via post-init property swap (`memory.vectorStore = new
 * JournalingVectorStore(nativeStore)`), matching the pattern proven live in
 * `spike/c3-mem0-loop.mjs`: mem0ai 3.1.1's `VectorStoreFactory` has no
 * custom-provider registration path (gotcha 11), so there's no cleaner
 * injection point in this SDK version.
 */
export class JournalingVectorStore implements VectorStore {
  private readonly native: VectorStore;
  private journal: VectorOp[] = [];
  private readonly mirror = new Map<string, { vector: number[]; payload: Record<string, unknown> }>();

  constructor(native: VectorStore) {
    this.native = native;
  }

  // -- lifecycle / reads: delegate untouched, never journaled -------------
  async initialize(): Promise<void> {
    return this.native.initialize();
  }
  async search(query: number[], topK?: number, filters?: SearchFilters): Promise<VectorStoreResult[]> {
    return this.native.search(query, topK, filters);
  }
  async keywordSearch(query: string, topK?: number, filters?: SearchFilters): Promise<VectorStoreResult[] | null> {
    if (!this.native.keywordSearch) return null;
    return this.native.keywordSearch(query, topK, filters);
  }
  async get(vectorId: string): Promise<VectorStoreResult | null> {
    return this.native.get(vectorId);
  }
  async list(filters?: SearchFilters, topK?: number): Promise<[VectorStoreResult[], number]> {
    return this.native.list(filters, topK);
  }
  async getUserId(): Promise<string> {
    return this.native.getUserId();
  }
  async setUserId(userId: string): Promise<void> {
    return this.native.setUserId(userId);
  }

  // -- mutations: forward to native, then journal + mirror -----------------
  async insert(vectors: number[][], ids: string[], payloads: Record<string, unknown>[]): Promise<void> {
    await this.native.insert(vectors, ids, payloads);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const vector = vectors[i]!;
      const payload = payloads[i] ?? {};
      this.mirror.set(id, { vector, payload });
    }
    this.journal.push({
      op: 'insert',
      ids: [...ids],
      vectors: vectors.map(packVector),
      payloads: payloads.map((p) => ({ ...p })),
    });
  }

  async update(vectorId: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    await this.native.update(vectorId, vector, payload);
    this.mirror.set(vectorId, { vector, payload });
    this.journal.push({ op: 'update', id: vectorId, vector: packVector(vector), payload: { ...payload } });
  }

  async delete(vectorId: string): Promise<void> {
    await this.native.delete(vectorId);
    this.mirror.delete(vectorId);
    this.journal.push({ op: 'delete', id: vectorId });
  }

  async deleteCol(): Promise<void> {
    await this.native.deleteCol();
    this.mirror.clear();
    this.journal.push({ op: 'deleteCol' });
  }

  // -- dmemo-specific extensions --------------------------------------------

  /** T1.7: record a forget-epoch tombstone. Carries no vector-store mutation
   * (nothing is deleted from the native store or mirror by this call alone —
   * callers that want to actually purge rows still issue explicit `delete`
   * calls; the tombstone is the durable, on-chain-visible marker). */
  journalTombstone(epoch: number, reason?: string): void {
    const op: VectorOp = {
      op: 'tombstone',
      epoch,
      tombstonedAt: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.journal.push(op);
  }

  /** Drain and return all journaled ops since the last drain (or since
   * construction). Used by `flush()` to build a delta blob. */
  drainJournal(): VectorOp[] {
    const j = this.journal;
    this.journal = [];
    return j;
  }

  /** True if there are unflushed ops pending (used for flush-cadence checks
   * without mutating the journal). */
  hasPendingOps(): boolean {
    return this.journal.length > 0;
  }

  /** Full materialized vector rows, for building a checkpoint blob. */
  snapshotRows(): CheckpointVectorRow[] {
    const rows: CheckpointVectorRow[] = [];
    for (const [id, { vector, payload }] of this.mirror.entries()) {
      rows.push({ id, vector: packVector(vector), payload });
    }
    return rows;
  }

  get rowCount(): number {
    return this.mirror.size;
  }

  /**
   * Apply a previously-journaled op directly to the native store + mirror,
   * WITHOUT re-journaling it. Used exclusively during restore-time replay
   * (walking the delta/checkpoint chain into a fresh native store) — replay
   * must not itself produce new journal entries.
   */
  async applyReplayOp(op: VectorOp): Promise<void> {
    switch (op.op) {
      case 'insert': {
        const vectors = op.vectors.map(unpackVector);
        await this.native.insert(vectors, op.ids, op.payloads);
        for (let i = 0; i < op.ids.length; i++) {
          const id = op.ids[i]!;
          this.mirror.set(id, { vector: vectors[i]!, payload: op.payloads[i] ?? {} });
        }
        return;
      }
      case 'update': {
        const vector = unpackVector(op.vector);
        await this.native.update(op.id, vector, op.payload);
        this.mirror.set(op.id, { vector, payload: op.payload });
        return;
      }
      case 'delete': {
        await this.native.delete(op.id);
        this.mirror.delete(op.id);
        return;
      }
      case 'deleteCol': {
        await this.native.deleteCol();
        this.mirror.clear();
        return;
      }
      case 'tombstone':
        // No vector-store side effect on replay — durability is handled by
        // the caller preserving tombstone ops in the replayed journal state.
        return;
      default: {
        const _exhaustive: never = op;
        throw new Error(`unknown VectorOp: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Load a full checkpoint's rows directly into a fresh native store +
   * mirror (bypasses per-row insert journaling; used once at the start of
   * chain replay when the chain begins with a checkpoint). */
  async applyCheckpointRows(rows: CheckpointVectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    const vectors = rows.map((r) => unpackVector(r.vector));
    const payloads = rows.map((r) => r.payload);
    await this.native.insert(vectors, ids, payloads);
    for (let i = 0; i < ids.length; i++) {
      this.mirror.set(ids[i]!, { vector: vectors[i]!, payload: payloads[i]! });
    }
  }
}
