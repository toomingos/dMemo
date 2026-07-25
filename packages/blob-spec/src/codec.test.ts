import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBlob, encodeBlob } from './codec.js';
import { packVector, unpackVector } from './vector.js';
import type { CheckpointBlob, DeltaBlob, EnvelopeMeta } from './types.js';

function sampleMeta(overrides: Partial<EnvelopeMeta> = {}): EnvelopeMeta {
  return {
    specVersion: 'dmemo/1',
    walletAddress: '0xabc0000000000000000000000000000000000f',
    agentScope: 'claude-code:tomas:project-x',
    seq: 0,
    prevRootHash: null,
    embedder: { provider: 'fastembed', model: 'fast-bge-small-en-v1.5', dim: 4 },
    engine: { name: 'mem0-oss', version: '3.1.1' },
    createdAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

test('packVector/unpackVector round-trips floats exactly (as float32)', () => {
  const original = [0.1, -2.5, 3.333333, 0, -0];
  const packed = packVector(original);
  const unpacked = unpackVector(packed);
  assert.equal(unpacked.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs((unpacked[i] as number) - Math.fround(original[i] as number)) < 1e-6);
  }
});

test('packVector produces base64 of Float32Array bytes (size sanity)', () => {
  const v = [1, 2, 3, 4];
  const packed = packVector(v);
  const raw = Buffer.from(packed, 'base64');
  assert.equal(raw.length, v.length * 4);
});

test('delta blob encode/decode round-trip is lossless', () => {
  const vec = packVector([1, 2, 3, 4]);
  const blob: DeltaBlob = {
    kind: 'delta',
    meta: sampleMeta({ seq: 1, prevRootHash: '0xdead' }),
    vectorOps: [
      { op: 'insert', ids: ['m1'], vectors: [vec], payloads: [{ data: 'hello' }] },
      { op: 'update', id: 'm1', vector: vec, payload: { data: 'hello v2' } },
      { op: 'delete', id: 'm0' },
      { op: 'deleteCol' },
      { op: 'tombstone', epoch: 3, tombstonedAt: '2026-07-25T00:00:01.000Z', reason: 'user request' },
    ],
    historyEntries: [
      [
        'h1',
        {
          id: 'h1',
          memory_id: 'm1',
          previous_value: null,
          new_value: 'hello',
          action: 'ADD',
          created_at: '2026-07-25T00:00:00.000Z',
          updated_at: null,
          is_deleted: 0,
        },
      ],
    ],
  };

  const bytes = encodeBlob(blob);
  const decoded = decodeBlob(bytes);
  assert.deepEqual(decoded, blob);

  // Determinism: encoding twice must produce byte-identical output.
  assert.deepEqual(encodeBlob(blob), bytes);
});

test('checkpoint blob encode/decode round-trip is lossless', () => {
  const blob: CheckpointBlob = {
    kind: 'checkpoint',
    meta: sampleMeta({ seq: 2, prevRootHash: null }),
    vectors: [
      { id: 'm1', vector: packVector([1, 2, 3, 4]), payload: { data: 'a' } },
      { id: 'm2', vector: packVector([5, 6, 7, 8]), payload: { data: 'b' } },
    ],
    historyEntries: [],
  };
  const bytes = encodeBlob(blob);
  const decoded = decodeBlob(bytes);
  assert.deepEqual(decoded, blob);
});

test('decodeBlob rejects tampered/corrupt JSON', () => {
  assert.throws(() => decodeBlob(Buffer.from('not json', 'utf8')));
  assert.throws(() => decodeBlob(Buffer.from(JSON.stringify({ kind: 'delta' }), 'utf8')));
});

test('decodeBlob rejects unsupported specVersion', () => {
  const blob: DeltaBlob = {
    kind: 'delta',
    meta: sampleMeta(),
    vectorOps: [],
    historyEntries: [],
  };
  const bytes = encodeBlob(blob);
  const mutated = JSON.parse(bytes.toString('utf8'));
  mutated.meta.specVersion = 'dmemo/999';
  assert.throws(() => decodeBlob(Buffer.from(JSON.stringify(mutated), 'utf8')));
});
