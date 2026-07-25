import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VectorStore, VectorStoreResult, SearchFilters } from 'mem0ai/oss';
import { JournalingVectorStore } from './journal.js';

/** Minimal in-memory fake of mem0's `VectorStore` interface, for offline
 * (no mem0/0G/network) journal-replay parity testing. Deliberately dumb:
 * cosine-less "search" just returns everything, since these tests only
 * care about journal/replay/mirror correctness, not ranking. */
class FakeVectorStore implements VectorStore {
  private rows = new Map<string, { vector: number[]; payload: Record<string, unknown> }>();
  private userId = '';

  async initialize(): Promise<void> {}
  async insert(vectors: number[][], ids: string[], payloads: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      this.rows.set(ids[i]!, { vector: vectors[i]!, payload: payloads[i] ?? {} });
    }
  }
  async search(_query: number[], _topK?: number, _filters?: SearchFilters): Promise<VectorStoreResult[]> {
    return [...this.rows.entries()].map(([id, r]) => ({ id, payload: r.payload }));
  }
  async keywordSearch(): Promise<VectorStoreResult[] | null> {
    return null;
  }
  async get(vectorId: string): Promise<VectorStoreResult | null> {
    const r = this.rows.get(vectorId);
    return r ? { id: vectorId, payload: r.payload } : null;
  }
  async update(vectorId: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    this.rows.set(vectorId, { vector, payload });
  }
  async delete(vectorId: string): Promise<void> {
    this.rows.delete(vectorId);
  }
  async deleteCol(): Promise<void> {
    this.rows.clear();
  }
  async list(): Promise<[VectorStoreResult[], number]> {
    const all = [...this.rows.entries()].map(([id, r]) => ({ id, payload: r.payload }));
    return [all, all.length];
  }
  async getUserId(): Promise<string> {
    return this.userId;
  }
  async setUserId(userId: string): Promise<void> {
    this.userId = userId;
  }

  /** Test-only introspection: full materialized state, for parity assertions. */
  dump(): Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> {
    return [...this.rows.entries()]
      .map(([id, r]) => ({ id, vector: r.vector, payload: r.payload }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

test('JournalingVectorStore forwards mutations to native store unchanged', async () => {
  const native = new FakeVectorStore();
  const journal = new JournalingVectorStore(native);

  await journal.insert([[1, 2, 3], [4, 5, 6]], ['a', 'b'], [{ data: 'hello' }, { data: 'world' }]);
  await journal.update('a', [7, 8, 9], { data: 'hello-updated' });
  await journal.delete('b');

  assert.deepEqual(native.dump(), [{ id: 'a', vector: [7, 8, 9], payload: { data: 'hello-updated' } }]);
});

test('JournalingVectorStore.drainJournal returns ops in order and clears the buffer', async () => {
  const journal = new JournalingVectorStore(new FakeVectorStore());
  await journal.insert([[1, 2]], ['x'], [{ data: 'x' }]);
  await journal.update('x', [3, 4], { data: 'x2' });
  await journal.delete('x');

  const ops = journal.drainJournal();
  assert.equal(ops.length, 3);
  assert.equal(ops[0]!.op, 'insert');
  assert.equal(ops[1]!.op, 'update');
  assert.equal(ops[2]!.op, 'delete');
  assert.deepEqual(journal.drainJournal(), []); // drained, buffer now empty
});

test('journal replay parity: applying drained ops to a fresh store reproduces identical state (offline/mock)', async () => {
  // --- "session 1": write some data, drain the journal -------------------
  const native1 = new FakeVectorStore();
  const journal1 = new JournalingVectorStore(native1);

  await journal1.insert(
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    ['mem-1', 'mem-2', 'mem-3'],
    [{ data: 'one' }, { data: 'two' }, { data: 'three' }]
  );
  await journal1.update('mem-2', [0, 9, 0], { data: 'two-updated' });
  await journal1.delete('mem-3');
  journal1.journalTombstone(0, 'test tombstone');

  const opsBatchA = journal1.drainJournal();

  await journal1.insert([[5, 5, 5]], ['mem-4'], [{ data: 'four' }]);
  const opsBatchB = journal1.drainJournal();

  const expectedFinalState = native1.dump();
  const expectedRowCount = journal1.rowCount;
  const expectedSnapshot = journal1.snapshotRows();

  // --- "restore": fresh native store + fresh journal, replay both batches ---
  const native2 = new FakeVectorStore();
  const journal2 = new JournalingVectorStore(native2);
  for (const op of [...opsBatchA, ...opsBatchB]) {
    await journal2.applyReplayOp(op);
  }

  assert.deepEqual(native2.dump(), expectedFinalState, 'replayed native store state matches original');
  assert.equal(journal2.rowCount, expectedRowCount, 'replayed mirror row count matches original');
  assert.deepEqual(
    journal2.snapshotRows().sort((a, b) => a.id.localeCompare(b.id)),
    expectedSnapshot.sort((a, b) => a.id.localeCompare(b.id)),
    'replayed checkpoint-row snapshot matches original (base64 vectors included)'
  );
  assert.equal(journal2.hasPendingOps(), false, 'replay via applyReplayOp must not itself journal new ops');
});

test('applyCheckpointRows loads a full checkpoint into a fresh store + mirror', async () => {
  const native = new FakeVectorStore();
  const journal = new JournalingVectorStore(native);

  const source = new FakeVectorStore();
  const sourceJournal = new JournalingVectorStore(source);
  await sourceJournal.insert([[1, 1], [2, 2]], ['a', 'b'], [{ data: 'A' }, { data: 'B' }]);
  const rows = sourceJournal.snapshotRows();

  await journal.applyCheckpointRows(rows);

  assert.equal(journal.rowCount, 2);
  assert.equal(journal.hasPendingOps(), false, 'loading a checkpoint must not journal new ops');
  assert.deepEqual(native.dump(), source.dump());
});
