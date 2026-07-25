// dMemo canonical blob spec — TS types.
//
// Two record types, versioned: `delta` (an ordered list of vector-store
// mutations since the last flush) and `checkpoint` (full materialized
// state: every vector row + the full mem0 history map).
//
// Plain JSON, deterministic key order (see codec.ts), designed for Python
// parity in v1.1 — this is the ONLY thing that ever gets encrypted and
// uploaded to 0G Storage. Raw engine/SQLite files are never part of the
// spec (that was only the Phase-0 stepping stone — see spike/RESULTS.md
// Step 1 vs Step 2).
//
// Embedding vectors inside payloads are base64-encoded Float32Array bytes
// (see vector.ts), never JSON float arrays (gotcha 14).

export const SPEC_VERSION = 'dmemo/1' as const;

/** Identifies which embedder produced the vectors in this blob (and its
 * ancestors, by convention — a mismatch at restore time vs. the locally
 * configured embedder triggers a re-embed migration, see T1.5). */
export interface EmbedderIdentity {
  provider: string;
  model: string;
  dim: number;
}

/** Identifies the memory engine that produced this blob (for forward
 * compatibility with non-mem0 engines / other language ports). */
export interface EngineIdentity {
  name: 'mem0-oss';
  version: string;
}

/** Envelope metadata common to both delta and checkpoint records. */
export interface EnvelopeMeta {
  specVersion: typeof SPEC_VERSION;
  /** The wallet address that authored this blob (also the ECIES recipient). */
  walletAddress: string;
  /** Logical scope this memory belongs to (host + user + agent, host-defined). */
  agentScope: string;
  /** Monotonically increasing sequence number for this wallet+scope's chain. */
  seq: number;
  /** rootHash of the previous blob in the chain, or null if this is the
   * first blob ever written for this wallet+scope (chain root). */
  prevRootHash: string | null;
  embedder: EmbedderIdentity;
  engine: EngineIdentity;
  /** ISO-8601 timestamp at blob-construction time (client clock, informational only). */
  createdAt: string;
  /** Block number the *previous* write was confirmed in, if known. Optional —
   * purely informational, never load-bearing for pointer resolution. */
  createdAtChain?: number;
}

/** One mem0 `MemoryHistoryManager` row, as stored in its in-process Map. */
export interface HistoryEntryRecord {
  id: string;
  memory_id: string;
  previous_value: string | null;
  new_value: string | null;
  action: string;
  created_at: string;
  updated_at: string | null;
  is_deleted: 0 | 1;
}

/** A single history-map entry as it appears inside a blob: `[mapKey, record]`,
 * mirroring `Map.entries()` so restore is a direct `new Map(entries)`. */
export type HistoryEntryTuple = [string, HistoryEntryRecord];

export interface InsertOp {
  op: 'insert';
  ids: string[];
  /** base64-encoded Float32Array bytes, one per id, same order as `ids`. */
  vectors: string[];
  payloads: Record<string, unknown>[];
}

export interface UpdateOp {
  op: 'update';
  id: string;
  /** base64-encoded Float32Array bytes. */
  vector: string;
  payload: Record<string, unknown>;
}

export interface DeleteOp {
  op: 'delete';
  id: string;
}

export interface DeleteColOp {
  op: 'deleteCol';
}

/** T1.7 (forget = crypto-shred): a tombstone marks an epoch as forgotten.
 * It carries no vector-store mutation of its own — replay treats it as a
 * no-op against the vector store, but MUST preserve it in the replayed
 * journal/audit trail so `forget()` calls are durable and visible on-chain. */
export interface TombstoneOp {
  op: 'tombstone';
  epoch: number;
  tombstonedAt: string;
  reason?: string;
}

export type VectorOp = InsertOp | UpdateOp | DeleteOp | DeleteColOp | TombstoneOp;

export interface DeltaBlob {
  kind: 'delta';
  meta: EnvelopeMeta;
  vectorOps: VectorOp[];
  historyEntries: HistoryEntryTuple[];
}

/** One fully-materialized vector row, as stored in a checkpoint. */
export interface CheckpointVectorRow {
  id: string;
  /** base64-encoded Float32Array bytes. */
  vector: string;
  payload: Record<string, unknown>;
}

export interface CheckpointBlob {
  kind: 'checkpoint';
  meta: EnvelopeMeta;
  vectors: CheckpointVectorRow[];
  historyEntries: HistoryEntryTuple[];
}

export type Blob = DeltaBlob | CheckpointBlob;
