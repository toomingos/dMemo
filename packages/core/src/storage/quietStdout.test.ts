import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withQuietSdkStdout, __resetQuietSdkStdoutForTests } from './quietStdout.js';

// The stdout-purity requirement (see quietStdout.ts's module doc) is that
// nothing @0gfoundation/0g-ts-sdk writes via console.log during an
// upload/download call reaches the host process's *real* stdout — Claude
// Code/Codex hooks parse stdout as a single JSON document, and a --json CLI
// consumer would see the same corruption. These tests spy at the
// process.stdout.write level (what console.log ultimately calls) rather
// than replacing console.log itself, so they observe exactly what a host
// process would actually receive on its stdout stream.

function spyOnRealStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return original(chunk, ...rest);
  };
  return {
    chunks,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

test.afterEach(() => {
  __resetQuietSdkStdoutForTests();
  delete process.env.DMEMO_DEBUG;
});

test('console.log calls made inside the wrapped function never reach real stdout', async () => {
  const spy = spyOnRealStdout();
  try {
    const result = await withQuietSdkStdout(async () => {
      // Mirrors the exact lines observed live from indexer/Indexer.js.
      console.log('Getting file locations for root hash: 0x541208693a911c...');
      console.log("Found 4 locations for 0x5412...:", ['http://34.83.53.209:5678']);
      console.log('Selected 2 of 4 nodes for 0x5412...');
      return 'sdk-result';
    });
    assert.equal(result, 'sdk-result', 'the wrapped function\'s return value must pass through unchanged');
    assert.deepEqual(spy.chunks, [], 'no console.log output should have reached real stdout');
  } finally {
    spy.restore();
  }
});

test('console.error and console.warn are never touched — genuine diagnostics are not swallowed', async () => {
  const originalError = console.error;
  const errorCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  try {
    await withQuietSdkStdout(async () => {
      console.error('Upload failed with error:', 'boom');
      return null;
    });
    assert.equal(errorCalls.length, 1, 'console.error must reach its (real) destination untouched');
    assert.deepEqual(errorCalls[0], ['Upload failed with error:', 'boom']);
  } finally {
    console.error = originalError;
  }
});

test('the wrapped function\'s rejection propagates and still restores console.log', async () => {
  const originalLog = console.log;
  await assert.rejects(
    withQuietSdkStdout(async () => {
      console.log('Wait for log entry on storage node');
      throw new Error('upload timed out');
    }),
    /upload timed out/
  );
  assert.equal(console.log, originalLog, 'console.log must be restored even when the wrapped call throws');
});

test('overlapping (concurrent) calls share one patch and only the last to finish restores console.log', async () => {
  const spy = spyOnRealStdout();
  const originalLog = console.log;
  try {
    let resolveA!: () => void;
    let resolveB!: () => void;
    const aGate = new Promise<void>((r) => (resolveA = r));
    const bGate = new Promise<void>((r) => (resolveB = r));

    // A starts first and finishes LAST; B starts second and finishes FIRST.
    // If restore weren't ref-counted, B's completion would restore the
    // original console.log while A is still mid-flight, un-suppressing A's
    // remaining SDK noise.
    const a = withQuietSdkStdout(async () => {
      console.log('A: starting upload');
      await aGate;
      console.log('A: finishing upload (after B already finished)');
      return 'a';
    });
    const b = withQuietSdkStdout(async () => {
      console.log('B: starting download');
      await bGate;
      console.log('B: finishing download');
      return 'b';
    });

    // No timer needed: calling an async function runs it synchronously up
    // to its first `await` (here, the un-resolved gate), so by the time
    // both `withQuietSdkStdout(...)` calls above have returned, both
    // synchronous prefixes — patch install, refCount++, and the first
    // console.log in each — have already run. (A real macrotask delay here
    // would risk capturing node:test's own stdout-based IPC traffic between
    // test files, an unrelated source of writes on this same stream.)
    assert.notEqual(console.log, originalLog, 'patch should be installed while both calls are in flight');

    resolveB();
    await b;
    // B finished but A is still in flight — patch must still be installed.
    assert.notEqual(console.log, originalLog, 'patch must survive while a sibling call is still in flight');

    resolveA();
    await a;
    assert.equal(console.log, originalLog, 'patch must be restored once the last in-flight call finishes');
    assert.deepEqual(spy.chunks, [], 'no console.log output from either overlapping call should have reached real stdout');
  } finally {
    spy.restore();
  }
});

test('default (DMEMO_DEBUG unset): captured lines are dropped, not relayed anywhere', async () => {
  delete process.env.DMEMO_DEBUG;
  const originalError = console.error;
  const errorCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  try {
    await withQuietSdkStdout(async () => {
      console.log('Selected 2 of 4 nodes for 0x5412...');
    });
    assert.deepEqual(errorCalls, [], 'quiet by default: no relay to stderr without DMEMO_DEBUG');
  } finally {
    console.error = originalError;
  }
});

for (const truthy of ['1', 'true']) {
  test(`DMEMO_DEBUG=${truthy}: captured lines are relayed to real stderr, tagged, never dropped forever`, async () => {
    process.env.DMEMO_DEBUG = truthy;
    const spy = spyOnRealStdout();
    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };
    try {
      await withQuietSdkStdout(async () => {
        console.log('Selected 2 of 4 nodes for 0x5412...');
      });
      assert.equal(errorCalls.length, 1);
      assert.deepEqual(errorCalls[0], ['[0g-sdk]', 'Selected 2 of 4 nodes for 0x5412...']);
      assert.deepEqual(spy.chunks, [], 'the debug relay must go to stderr, never stdout');
    } finally {
      console.error = originalError;
      spy.restore();
    }
  });
}
