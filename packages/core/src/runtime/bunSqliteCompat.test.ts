import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BetterSqlite3OnBun,
  ensureBetterSqlite3Compat,
  resetBetterSqlite3CompatForTests,
} from './bunSqliteCompat.js';

// F4 — better-sqlite3 aborts the process on Bun (oven-sh/bun#4290), so
// DmemoSession routes it to `bun:sqlite`. These tests run under Node, where
// the install is a no-op; what they pin down is the handful of places
// `bun:sqlite` DIVERGES from better-sqlite3, because each divergence is a
// silent-wrong-answer bug in mem0's MemoryVectorStore rather than a crash:
//
//   - `.get()` miss:  bun -> null, better-sqlite3 -> undefined
//   - BLOB columns:   bun -> Uint8Array, better-sqlite3 -> Buffer, and mem0
//                     does `new Float32Array(v.buffer, v.byteOffset, …)`,
//                     which THROWS unless byteOffset is 4-byte aligned
//   - `.exec()`:      better-sqlite3 returns the Database for chaining
//
// The compat Database takes its underlying constructor as an argument
// precisely so it can be driven by the fake below without a Bun runtime.

/** Minimal stand-in for `bun:sqlite`, reproducing its divergent behaviors. */
function makeFakeBunDatabase(rows: Record<string, unknown>[], opts: { missing?: boolean } = {}) {
  const calls: string[] = [];
  class FakeBunDatabase {
    constructor(
      public filename: string,
      public options?: unknown
    ) {
      calls.push(`ctor:${filename}`);
    }
    exec(sql: string) {
      calls.push(`exec:${sql}`);
      return undefined; // bun:sqlite returns undefined, not the Database
    }
    prepare(sql: string) {
      calls.push(`prepare:${sql}`);
      return {
        run: (...p: unknown[]) => ({ changes: 1, lastInsertRowid: p.length }),
        get: () => (opts.missing ? null : rows[0]), // bun yields null on a miss
        all: () => rows,
        finalize: () => calls.push('finalize'),
      };
    }
    transaction(fn: (...a: unknown[]) => unknown) {
      return (...a: unknown[]) => {
        calls.push('tx:begin');
        const r = fn(...a);
        calls.push('tx:commit');
        return r;
      };
    }
    close(throwOnError: boolean) {
      calls.push(`close:${throwOnError}`);
    }
  }
  return { FakeBunDatabase, calls };
}

test('compat .get() maps bun’s null miss to better-sqlite3’s undefined', () => {
  const { FakeBunDatabase } = makeFakeBunDatabase([], { missing: true });
  const db = new BetterSqlite3OnBun(FakeBunDatabase, ':memory:');
  // mem0's getUserId() branches on `if (row)`, but callers that test
  // `=== undefined` would misread null as a hit.
  assert.equal(db.prepare('SELECT 1').get(), undefined);
});

test('compat .get()/.all() return BLOBs as 4-byte-aligned Buffers', () => {
  // A Uint8Array view at a deliberately unaligned offset — exactly what would
  // make mem0's `new Float32Array(v.buffer, v.byteOffset, …)` throw.
  const backing = new Uint8Array(1 + 12);
  const floats = new Float32Array([1.5, -2.25, 3.75]);
  backing.set(new Uint8Array(floats.buffer), 1);
  const unaligned = backing.subarray(1);
  assert.equal(unaligned.byteOffset % 4, 1, 'fixture must start unaligned');

  const { FakeBunDatabase } = makeFakeBunDatabase([{ id: 'a', vector: unaligned, payload: '{}' }]);
  const db = new BetterSqlite3OnBun(FakeBunDatabase, ':memory:');

  for (const row of [db.prepare('SELECT * FROM vectors').get(), db.prepare('SELECT * FROM vectors').all()[0]]) {
    const v = (row as { vector: Buffer }).vector;
    assert.ok(Buffer.isBuffer(v), 'BLOB should be a Buffer, as better-sqlite3 returns');
    assert.equal(v.byteOffset % 4, 0, 'BLOB must be 4-byte aligned');
    // The exact read mem0 performs must round-trip the original floats.
    const view = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
    assert.deepEqual(Array.from(view), [1.5, -2.25, 3.75]);
  }
});

test('compat leaves non-BLOB columns untouched', () => {
  const { FakeBunDatabase } = makeFakeBunDatabase([{ id: 'a', payload: '{"x":1}', n: 42, nil: null }]);
  const db = new BetterSqlite3OnBun(FakeBunDatabase, ':memory:');
  assert.deepEqual(db.prepare('SELECT *').get(), { id: 'a', payload: '{"x":1}', n: 42, nil: null });
});

test('compat .exec() returns the Database for chaining; .transaction() passes args through', () => {
  const { FakeBunDatabase, calls } = makeFakeBunDatabase([]);
  const db = new BetterSqlite3OnBun(FakeBunDatabase, ':memory:');
  assert.equal(db.exec('CREATE TABLE t (id TEXT)'), db);

  // mem0's insert() builds `db.transaction(fn)` then calls it with three
  // arrays; the wrapper must forward them and return fn's value.
  const run = db.transaction((a: unknown, b: unknown, c: unknown) => [a, b, c].join('|'));
  assert.equal(run(1, 2, 3), '1|2|3');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('tx:')),
    ['tx:begin', 'tx:commit']
  );
});

test('compat opens with create+readwrite and reports better-sqlite3 Database properties', () => {
  const { FakeBunDatabase } = makeFakeBunDatabase([]);
  // better-sqlite3 creates the DB file when absent; bun:sqlite's defaults
  // differ, so the flags are passed explicitly.
  const db = new BetterSqlite3OnBun(FakeBunDatabase, '/tmp/dmemo-test.db');
  const inner = (db as unknown as { db: { options: { create: boolean; readwrite: boolean } } }).db;
  assert.deepEqual(inner.options, { create: true, readwrite: true });
  assert.equal(db.name, '/tmp/dmemo-test.db');
  assert.equal(db.memory, false);
  assert.equal(db.open, true);
  db.close();
  assert.equal(db.open, false);

  // An empty/omitted filename means in-memory, as better-sqlite3 does.
  assert.equal(new BetterSqlite3OnBun(FakeBunDatabase).memory, true);
});

test('ensureBetterSqlite3Compat is inert and memoized off Bun', async () => {
  resetBetterSqlite3CompatForTests();
  const first = await ensureBetterSqlite3Compat();
  assert.equal(first.isBun, false);
  assert.equal(first.installed, false);
  assert.match(first.reason, /not running under Bun/);
  // Memoized: repeated session opens must not re-register a plugin.
  assert.equal(await ensureBetterSqlite3Compat(), first);
});
