import {
  SPEC_VERSION,
  type Blob,
  type CheckpointBlob,
  type CheckpointVectorRow,
  type DeltaBlob,
  type EnvelopeMeta,
  type HistoryEntryTuple,
  type VectorOp,
} from './types.js';

export class BlobDecodeError extends Error {
  constructor(message: string) {
    super(`dMemo blob decode error: ${message}`);
    this.name = 'BlobDecodeError';
  }
}

function orderedMeta(meta: EnvelopeMeta): EnvelopeMeta {
  // Fixed key order so encode() is deterministic across runs/languages —
  // required for cross-language (Python, v1.1) parity and for stable
  // content hashing of the plaintext prior to encryption.
  const ordered: EnvelopeMeta = {
    specVersion: meta.specVersion,
    walletAddress: meta.walletAddress,
    agentScope: meta.agentScope,
    seq: meta.seq,
    prevRootHash: meta.prevRootHash,
    embedder: {
      provider: meta.embedder.provider,
      model: meta.embedder.model,
      dim: meta.embedder.dim,
    },
    engine: { name: meta.engine.name, version: meta.engine.version },
    createdAt: meta.createdAt,
  };
  if (meta.createdAtChain !== undefined) ordered.createdAtChain = meta.createdAtChain;
  return ordered;
}

function orderedOp(op: VectorOp): VectorOp {
  switch (op.op) {
    case 'insert':
      return { op: 'insert', ids: op.ids, vectors: op.vectors, payloads: op.payloads };
    case 'update':
      return { op: 'update', id: op.id, vector: op.vector, payload: op.payload };
    case 'delete':
      return { op: 'delete', id: op.id };
    case 'deleteCol':
      return { op: 'deleteCol' };
    case 'tombstone':
      return {
        op: 'tombstone',
        epoch: op.epoch,
        tombstonedAt: op.tombstonedAt,
        ...(op.reason !== undefined ? { reason: op.reason } : {}),
      };
  }
}

function orderedHistory(entries: HistoryEntryTuple[]): HistoryEntryTuple[] {
  return entries.map(([id, r]) => [
    id,
    {
      id: r.id,
      memory_id: r.memory_id,
      previous_value: r.previous_value,
      new_value: r.new_value,
      action: r.action,
      created_at: r.created_at,
      updated_at: r.updated_at,
      is_deleted: r.is_deleted,
    },
  ]);
}

/** Encode a Blob into deterministic-key-order JSON bytes (UTF-8 Buffer),
 * ready for encryption + upload. Never throws on well-typed input. */
export function encodeBlob(blob: Blob): Buffer {
  let ordered: Record<string, unknown>;
  if (blob.kind === 'delta') {
    ordered = {
      kind: 'delta',
      meta: orderedMeta(blob.meta),
      vectorOps: blob.vectorOps.map(orderedOp),
      historyEntries: orderedHistory(blob.historyEntries),
    };
  } else {
    ordered = {
      kind: 'checkpoint',
      meta: orderedMeta(blob.meta),
      vectors: blob.vectors.map((v: CheckpointVectorRow) => ({
        id: v.id,
        vector: v.vector,
        payload: v.payload,
      })),
      historyEntries: orderedHistory(blob.historyEntries),
    };
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new BlobDecodeError(msg);
}

function validateMeta(meta: unknown): asserts meta is EnvelopeMeta {
  assert(meta && typeof meta === 'object', 'meta missing or not an object');
  const m = meta as Record<string, unknown>;
  assert(m.specVersion === SPEC_VERSION, `unsupported specVersion: ${String(m.specVersion)}`);
  assert(typeof m.walletAddress === 'string', 'meta.walletAddress must be a string');
  assert(typeof m.agentScope === 'string', 'meta.agentScope must be a string');
  assert(typeof m.seq === 'number', 'meta.seq must be a number');
  assert(m.prevRootHash === null || typeof m.prevRootHash === 'string', 'meta.prevRootHash must be string|null');
  assert(m.embedder && typeof m.embedder === 'object', 'meta.embedder missing');
  const e = m.embedder as Record<string, unknown>;
  assert(typeof e.provider === 'string' && typeof e.model === 'string' && typeof e.dim === 'number', 'meta.embedder malformed');
  assert(m.engine && typeof m.engine === 'object', 'meta.engine missing');
  const eng = m.engine as Record<string, unknown>;
  assert(eng.name === 'mem0-oss' && typeof eng.version === 'string', 'meta.engine malformed');
  assert(typeof m.createdAt === 'string', 'meta.createdAt must be a string');
}

function validateOp(op: unknown): asserts op is VectorOp {
  assert(op && typeof op === 'object', 'vectorOp must be an object');
  const o = op as Record<string, unknown>;
  switch (o.op) {
    case 'insert':
      assert(Array.isArray(o.ids) && Array.isArray(o.vectors) && Array.isArray(o.payloads), 'insert op malformed');
      return;
    case 'update':
      assert(typeof o.id === 'string' && typeof o.vector === 'string', 'update op malformed');
      return;
    case 'delete':
      assert(typeof o.id === 'string', 'delete op malformed');
      return;
    case 'deleteCol':
      return;
    case 'tombstone':
      assert(typeof o.epoch === 'number' && typeof o.tombstonedAt === 'string', 'tombstone op malformed');
      return;
    default:
      throw new BlobDecodeError(`unknown vectorOp.op: ${String(o.op)}`);
  }
}

/** Decode UTF-8 JSON bytes into a validated Blob. Throws BlobDecodeError on
 * any structural mismatch — callers must treat decode failure as data
 * corruption / tamper, never silently coerce. */
export function decodeBlob(bytes: Uint8Array | Buffer): Blob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (e) {
    throw new BlobDecodeError(`invalid JSON: ${(e as Error).message}`);
  }
  assert(parsed && typeof parsed === 'object', 'top-level value is not an object');
  const obj = parsed as Record<string, unknown>;
  validateMeta(obj.meta);
  assert(Array.isArray(obj.historyEntries), 'historyEntries must be an array');

  if (obj.kind === 'delta') {
    assert(Array.isArray(obj.vectorOps), 'delta.vectorOps must be an array');
    for (const op of obj.vectorOps) validateOp(op);
    return {
      kind: 'delta',
      meta: obj.meta as EnvelopeMeta,
      vectorOps: obj.vectorOps as VectorOp[],
      historyEntries: obj.historyEntries as HistoryEntryTuple[],
    } satisfies DeltaBlob;
  }
  if (obj.kind === 'checkpoint') {
    assert(Array.isArray(obj.vectors), 'checkpoint.vectors must be an array');
    for (const row of obj.vectors) {
      assert(row && typeof row === 'object', 'checkpoint vector row must be an object');
      const r = row as Record<string, unknown>;
      assert(typeof r.id === 'string' && typeof r.vector === 'string' && typeof r.payload === 'object', 'checkpoint vector row malformed');
    }
    return {
      kind: 'checkpoint',
      meta: obj.meta as EnvelopeMeta,
      vectors: obj.vectors as CheckpointVectorRow[],
      historyEntries: obj.historyEntries as HistoryEntryTuple[],
    } satisfies CheckpointBlob;
  }
  throw new BlobDecodeError(`unknown blob.kind: ${String(obj.kind)}`);
}
