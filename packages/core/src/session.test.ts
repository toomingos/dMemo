import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEC_VERSION,
  encodeBlob,
  type Blob as DmemoBlob,
  type CheckpointBlob,
  type DeltaBlob,
  type EnvelopeMeta,
  type CheckpointVectorRow,
  type DeleteOp,
  type VectorOp,
} from '@dmemo/blob-spec';
import { BlobUnretrievableError, BlobCorruptError, type ResolvedPointer } from './storage/client.js';
import {
  resolveRestoreChain,
  applyRestoreChain,
  RestoreChainUnavailableError,
  RestoreTemporarilyUnavailableError,
  type ChainEntry,
} from './session.js';

/**
 * F6 regression tests. These target the two pure, dependency-injected
 * functions `DmemoSession.open()` delegates to for restore:
 *  - `resolveRestoreChain`: walks Submit-log candidates back (newest first)
 *    until a fully downloadable/decodable chain is found.
 *  - `applyRestoreChain`: replays an already-resolved chain into the native
 *    store, truncating at the first blob that fails to replay.
 * Both are hermetic — no network, no 0G SDK, no mem0 — driven entirely by
 * fakes and by real `encodeBlob`/`decodeBlob` from `@dmemo/blob-spec`.
 */

function meta(seq: number, prevRootHash: string | null): EnvelopeMeta {
  return {
    specVersion: SPEC_VERSION,
    walletAddress: '0x' + '1'.repeat(40),
    agentScope: 'test:scope',
    seq,
    prevRootHash,
    embedder: { provider: 'test', model: 'test-model', dim: 4 },
    engine: { name: 'mem0-oss', version: 'test' },
    createdAt: new Date(0).toISOString(),
  };
}

function checkpoint(seq: number, prevRootHash: string | null, vectors: CheckpointVectorRow[] = []): CheckpointBlob {
  return { kind: 'checkpoint', meta: meta(seq, prevRootHash), vectors, historyEntries: [] };
}

function delta(seq: number, prevRootHash: string, vectorOps: VectorOp[] = []): DeltaBlob {
  return { kind: 'delta', meta: meta(seq, prevRootHash), vectorOps, historyEntries: [] };
}

function pointer(rootHash: string, txSeq: number): ResolvedPointer {
  return { rootHash, txSeq, blockNumber: txSeq, elapsedMs: 0 };
}

type DlOutcome = DmemoBlob | Error | Buffer;

/** Fake `downloadAndVerify`: maps a rootHash to either a Blob (encoded on
 * the fly to realistic plaintext bytes), raw bytes (to exercise decodeBlob's
 * own validation), or an Error to throw (simulating a download/verify/decrypt
 * failure at the `StorageClient` layer). */
function fakeDownloader(table: Record<string, DlOutcome>) {
  return async (rootHash: string) => {
    const outcome = table[rootHash];
    if (outcome === undefined) throw new Error(`fakeDownloader: no entry for ${rootHash}`);
    if (outcome instanceof Error) throw outcome;
    const plaintext = Buffer.isBuffer(outcome) ? outcome : encodeBlob(outcome);
    return { plaintext, downloadMs: 1, verifyMs: 1, decryptMs: 1 };
  };
}

// ---------------------------------------------------------------------
// resolveRestoreChain
// ---------------------------------------------------------------------

test('resolveRestoreChain: happy path — single candidate, nothing skipped', async () => {
  const table = { r1: checkpoint(0, null) };
  const result = await resolveRestoreChain([pointer('r1', 1)], { downloadAndVerify: fakeDownloader(table) });
  assert.equal(result.pointer.rootHash, 'r1');
  assert.equal(result.chain.length, 1);
  assert.equal(result.chain[0]!.rootHash, 'r1');
  assert.deepEqual(result.skipped, []);
});

test('resolveRestoreChain: corrupt-only head with intact ancestors — still degrades and recovers (unchanged)', async () => {
  // The head is CONFIRMED corrupt (not merely unreachable) — nothing left to
  // wait for, so degrading to the older, fully-resolved candidate is still
  // correct and must not be affected by the refuse-don't-degrade rule below.
  const table = {
    rHeadBad: new BlobCorruptError('rHeadBad', 'decrypt failed'),
    rGood: checkpoint(0, null),
  };
  const result = await resolveRestoreChain(
    [pointer('rHeadBad', 2), pointer('rGood', 1)],
    { downloadAndVerify: fakeDownloader(table) }
  );
  assert.equal(result.pointer.rootHash, 'rGood');
  assert.equal(result.chain.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.rootHash, 'rHeadBad');
  assert.equal(result.skipped[0]!.reason, 'corrupt');
});

test('resolveRestoreChain: several consecutive CONFIRMED-corrupt candidates are all walked back (still degrades)', async () => {
  // Every abandoned newer candidate is confirmed corrupt — nothing left to
  // wait for — so this must still degrade to the oldest good candidate,
  // exactly as before the refuse-don't-degrade fix.
  const table = {
    c1: new BlobCorruptError('c1', 'decrypt failed'),
    c2: new BlobCorruptError('c2', 'decrypt failed'),
    c3: checkpoint(0, null),
  };
  const result = await resolveRestoreChain(
    [pointer('c1', 3), pointer('c2', 2), pointer('c3', 1)],
    { downloadAndVerify: fakeDownloader(table) }
  );
  assert.equal(result.pointer.rootHash, 'c3');
  assert.equal(result.skipped.length, 2);
  assert.equal(result.skipped[0]!.rootHash, 'c1');
  assert.equal(result.skipped[0]!.reason, 'corrupt');
  assert.equal(result.skipped[1]!.rootHash, 'c2');
  assert.equal(result.skipped[1]!.reason, 'corrupt');
});

test('resolveRestoreChain: mixed corrupt-then-transient — refuses even though an older candidate is confirmed corrupt', async () => {
  // head (c1) confirmed corrupt, c2 merely transient, c3 fully resolves.
  // A later retry might still recover c2 — which is NEWER than c3 — so this
  // must refuse rather than degrade to c3, even though c1 alone would not
  // have blocked the degrade.
  const table = {
    c1: new BlobCorruptError('c1', 'decrypt failed'),
    c2: new BlobUnretrievableError('c2', 'transient', 'timeout'),
    c3: checkpoint(0, null),
  };
  await assert.rejects(
    () =>
      resolveRestoreChain([pointer('c1', 3), pointer('c2', 2), pointer('c3', 1)], {
        downloadAndVerify: fakeDownloader(table),
      }),
    (err: unknown) => {
      if (!(err instanceof RestoreTemporarilyUnavailableError)) throw new Error(`unexpected error type: ${err}`);
      assert.equal(err.skipped.length, 2);
      return true;
    }
  );
});

test('resolveRestoreChain: an unreachable head we ourselves abandoned is walked back, not deferred on', async () => {
  // The exact live failure this rule exists for: an upload timed out AFTER
  // its Submit tx mined, so the wallet gained pointers with no segment data
  // behind them — permanently. Without orphanSuspect these look transient and
  // every future session refuses forever, wedging the wallet.
  const table = {
    dead1: new BlobUnretrievableError('dead1', 'transient', 'timeout'),
    dead2: new BlobUnretrievableError('dead2', 'transient', 'timeout'),
    good: checkpoint(0, null),
  };
  const result = await resolveRestoreChain(
    [
      { ...pointer('dead1', 3), orphanSuspect: true },
      { ...pointer('dead2', 2), orphanSuspect: true },
      pointer('good', 1),
    ],
    { downloadAndVerify: fakeDownloader(table) }
  );
  assert.equal(result.pointer.rootHash, 'good');
  assert.deepEqual(
    result.skipped.map((s) => s.reason),
    ['orphaned', 'orphaned']
  );
});

test('resolveRestoreChain: an orphan-suspect ANCESTOR still defers — only the head can be our wreckage', async () => {
  // We abandoned one submission and never chained onto it, so `mid` (reached
  // by walking prevRootHash) was written by a confirmed upload. Its being
  // unreachable is a real outage, and degrading past it would orphan an
  // intact blob.
  const table = {
    head: delta(1, 'mid'),
    mid: new BlobUnretrievableError('mid', 'transient', 'timeout'),
    good: checkpoint(0, null),
  };
  await assert.rejects(
    () =>
      resolveRestoreChain([{ ...pointer('head', 3), orphanSuspect: true }, pointer('good', 1)], {
        downloadAndVerify: fakeDownloader(table),
      }),
    (err: unknown) => err instanceof RestoreTemporarilyUnavailableError
  );
});

test('resolveRestoreChain: without the local marker an unreachable head still defers (unchanged)', async () => {
  const table = {
    head: new BlobUnretrievableError('head', 'transient', 'timeout'),
    good: checkpoint(0, null),
  };
  await assert.rejects(
    () =>
      resolveRestoreChain([pointer('head', 2), pointer('good', 1)], { downloadAndVerify: fakeDownloader(table) }),
    (err: unknown) => err instanceof RestoreTemporarilyUnavailableError
  );
});

test('resolveRestoreChain: a corrupt blob that is NOT the head discards only that candidate', async () => {
  // headOk is a perfectly good, decodable head — but its ancestor (midBad,
  // reached by walking prevRootHash) is corrupt. The whole headOk candidate
  // must be discarded (delta-chain semantics: headOk's diff assumes midBad's
  // state), and restore must fall back to the next-older Submit-log
  // candidate (altGood), not silently accept a chain missing its base.
  const table = {
    headOk: delta(1, 'midBad'),
    midBad: Buffer.from('not valid json'),
    altGood: checkpoint(0, null),
  };
  const result = await resolveRestoreChain(
    [pointer('headOk', 2), pointer('altGood', 1)],
    { downloadAndVerify: fakeDownloader(table) }
  );
  assert.equal(result.pointer.rootHash, 'altGood');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.rootHash, 'midBad');
  assert.equal(result.skipped[0]!.reason, 'corrupt');
});

test('resolveRestoreChain: a transient/network error on the head is NOT treated as corruption, and NOT degraded — refuses instead', async () => {
  // A network blip on the real head must never be silently treated as
  // corruption AND must never cause a silent degrade to the older `good`
  // candidate: that would cache/chain onto `good`, permanently orphaning
  // `head` even though it is probably still intact. `resolveRestoreChain`
  // must reject (never resolve) here — the caller (open()) never reaches
  // its `if (pointer)` / `storage.savePointer(pointer)` block at all, so
  // nothing is cached, written, or chained when this happens.
  const table = {
    head: new Error('ECONNRESET'),
    good: checkpoint(0, null),
  };
  await assert.rejects(
    () => resolveRestoreChain([pointer('head', 2), pointer('good', 1)], { downloadAndVerify: fakeDownloader(table) }),
    (err: unknown) => {
      if (!(err instanceof RestoreTemporarilyUnavailableError)) throw new Error(`unexpected error type: ${err}`);
      assert.equal(err.skipped.length, 1);
      assert.equal(err.skipped[0]!.rootHash, 'head');
      assert.notEqual(err.skipped[0]!.reason, 'corrupt');
      assert.equal(err.skipped[0]!.reason, 'transient');
      assert.match(err.message, /intact/);
      assert.match(err.message, /retry/);
      return true;
    }
  );
});

test('resolveRestoreChain: an unretrievable (Merkle-mismatch-class) head also refuses rather than degrades', async () => {
  const table = {
    head: new BlobUnretrievableError('head', 'unretrievable', 'merkle mismatch after 2 attempts'),
    good: checkpoint(0, null),
  };
  await assert.rejects(
    () => resolveRestoreChain([pointer('head', 2), pointer('good', 1)], { downloadAndVerify: fakeDownloader(table) }),
    (err: unknown) => {
      if (!(err instanceof RestoreTemporarilyUnavailableError)) throw new Error(`unexpected error type: ${err}`);
      assert.equal(err.skipped[0]!.reason, 'unretrievable');
      return true;
    }
  );
});

test('resolveRestoreChain: entirely unrecoverable chain fails clearly, with an actionable, corruption-aware message', async () => {
  const table = {
    a: new BlobCorruptError('a', 'decrypt failed'),
    b: new BlobUnretrievableError('b', 'transient', 'timeout'),
  };
  await assert.rejects(
    () => resolveRestoreChain([pointer('a', 2), pointer('b', 1)], { downloadAndVerify: fakeDownloader(table) }),
    (err: unknown) => {
      if (!(err instanceof RestoreChainUnavailableError)) throw new Error(`unexpected error type: ${err}`);
      assert.equal(err.skipped.length, 2);
      assert.match(err.message, /confirmed corrupt\/unreplayable/);
      return true;
    }
  );
});

test('resolveRestoreChain: an all-transient exhausted chain is reported as possibly temporary, not confirmed loss', async () => {
  const table = {
    a: new BlobUnretrievableError('a', 'transient', 'timeout'),
    b: new BlobUnretrievableError('b', 'transient', 'timeout'),
  };
  await assert.rejects(
    () => resolveRestoreChain([pointer('a', 2), pointer('b', 1)], { downloadAndVerify: fakeDownloader(table) }),
    (err: unknown) => {
      if (!(err instanceof RestoreChainUnavailableError)) throw new Error(`unexpected error type: ${err}`);
      assert.match(err.message, /may be temporary/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------
// applyRestoreChain
// ---------------------------------------------------------------------

test('applyRestoreChain: happy path — every blob applies, nothing truncated', async () => {
  const applied: string[] = [];
  const chain: ChainEntry[] = [
    { rootHash: 'r1', blob: checkpoint(0, null) },
    { rootHash: 'r2', blob: delta(1, 'r1', [{ op: 'delete', id: 'x' } satisfies DeleteOp]) },
  ];
  const result = await applyRestoreChain(chain, {
    applyCheckpoint: async () => {
      applied.push('checkpoint');
    },
    applyOp: async () => {
      applied.push('op');
    },
  });
  assert.equal(result.lastGood?.rootHash, 'r2');
  assert.equal(result.appliedCount, 2);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(applied, ['checkpoint', 'op']);
});

test('applyRestoreChain: a corrupt blob that is not the oldest truncates to the last good blob', async () => {
  const boom: DeleteOp = { op: 'delete', id: 'FAIL_ME' };
  const chain: ChainEntry[] = [
    { rootHash: 'r1', blob: checkpoint(0, null) },
    { rootHash: 'r2', blob: delta(1, 'r1', [boom]) },
    { rootHash: 'r3', blob: delta(2, 'r2', []) }, // never reached — truncated before this
  ];
  const result = await applyRestoreChain(chain, {
    applyCheckpoint: async () => {},
    applyOp: async (op) => {
      if (op.op === 'delete' && op.id === 'FAIL_ME') throw new Error('simulated unreplayable op');
    },
  });
  assert.equal(result.lastGood?.rootHash, 'r1');
  assert.equal(result.appliedCount, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.rootHash, 'r2');
  assert.equal(result.skipped[0]!.reason, 'corrupt');
  assert.match(result.skipped[0]!.detail, /unreplayable/);
});

test('applyRestoreChain: the oldest (base) blob itself failing to replay leaves no recoverable state', async () => {
  const chain: ChainEntry[] = [{ rootHash: 'r1', blob: checkpoint(0, null) }];
  const result = await applyRestoreChain(chain, {
    applyCheckpoint: async () => {
      throw new Error('simulated base corruption');
    },
    applyOp: async () => {},
  });
  // DmemoSession.open() treats a null lastGood as a hard failure
  // (RestoreChainUnavailableError) rather than silently returning a fresh,
  // empty store — never silent, per F6.
  assert.equal(result.lastGood, null);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.rootHash, 'r1');
});

test('applyRestoreChain: history entries only merge for blobs that actually applied', async () => {
  const boom: DeleteOp = { op: 'delete', id: 'FAIL_ME' };
  const chain: ChainEntry[] = [
    { rootHash: 'r1', blob: { ...checkpoint(0, null), historyEntries: [['h1', historyRow('h1')]] } },
    { rootHash: 'r2', blob: { ...delta(1, 'r1', [boom]), historyEntries: [['h2', historyRow('h2')]] } },
  ];
  const result = await applyRestoreChain(chain, {
    applyCheckpoint: async () => {},
    applyOp: async (op) => {
      if (op.op === 'delete' && op.id === 'FAIL_ME') throw new Error('simulated unreplayable op');
    },
  });
  assert.deepEqual([...result.historyMap.keys()], ['h1']);
});

function historyRow(id: string) {
  return {
    id,
    memory_id: id,
    previous_value: null,
    new_value: 'v',
    action: 'ADD',
    created_at: new Date(0).toISOString(),
    updated_at: null,
    is_deleted: 0 as const,
  };
}
