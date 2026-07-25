import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapIndexerQuiet } from './quietIndexer.js';
import { __resetQuietSdkStdoutForTests } from './quietStdout.js';

// These tests exercise `wrapIndexerQuiet()` directly (not through
// StorageClient) to prove the *structural* claim: wrapping is generic over
// "whatever methods this object happens to have", not a hardcoded list of
// `upload`/`downloadToBlob`. In particular one test below adds a method
// that did not exist when this wrapper was written — standing in for a
// future SDK version, or a third call site nobody has coded yet — and
// shows it is quiet with zero changes to `quietIndexer.ts`.

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
});

test('a method that exists today (async, tuple-returning like the real SDK) is quiet', async () => {
  const spy = spyOnRealStdout();
  try {
    const raw = {
      async upload(file: string) {
        console.log('Data prepared to upload', file);
        return [{ txHash: '0xdead' }, null];
      },
    };
    const wrapped = wrapIndexerQuiet(raw);
    const [result] = await wrapped.upload('memdata');
    assert.equal(result!.txHash, '0xdead');
    assert.deepEqual(spy.chunks, [], 'upload() noise must not reach real stdout');
  } finally {
    spy.restore();
  }
});

test('a method invented AFTER this wrapper was written is quiet with zero code changes — the structural claim', async () => {
  const spy = spyOnRealStdout();
  try {
    // Stand-in for a hypothetical future SDK method (or a new call site
    // nobody has written yet), unknown to quietIndexer.ts.
    const raw = {
      async someBrandNewSdkMethodFromAFutureVersion(x: number) {
        console.log('chatty new SDK internal', x);
        return x * 2;
      },
    };
    const wrapped = wrapIndexerQuiet(raw);
    const out = await wrapped.someBrandNewSdkMethodFromAFutureVersion(21);
    assert.equal(out, 42);
    assert.deepEqual(spy.chunks, [], 'a brand-new method must be quiet with no changes to quietIndexer.ts');
  } finally {
    spy.restore();
  }
});

test('synchronous methods keep their synchronous contract (Indexer extends HttpProvider, which has sync members)', () => {
  const spy = spyOnRealStdout();
  try {
    const raw = {
      close(): void {
        console.log('closing http provider');
      },
      id(): number {
        console.log('generating id');
        return 7;
      },
    };
    const wrapped = wrapIndexerQuiet(raw);
    const closeResult = wrapped.close();
    const idResult = wrapped.id();
    assert.equal(closeResult, undefined, 'close() must still return synchronously, not a Promise');
    assert.equal(idResult, 7, 'id() must still return its value synchronously, not a Promise');
    assert.deepEqual(spy.chunks, [], 'sync-method noise must not reach real stdout either');
  } finally {
    spy.restore();
  }
});

test('errors thrown synchronously still restore the patch and propagate unchanged', () => {
  const raw = {
    explode(): never {
      console.log('about to explode');
      throw new Error('sync boom');
    },
  };
  const wrapped = wrapIndexerQuiet(raw);
  assert.throws(() => wrapped.explode(), /sync boom/);
});

test('rejections still restore the patch and propagate unchanged', async () => {
  const raw = {
    async explodeAsync(): Promise<never> {
      console.log('about to explode async');
      throw new Error('async boom');
    },
  };
  const wrapped = wrapIndexerQuiet(raw);
  await assert.rejects(wrapped.explodeAsync(), /async boom/);
});

test('non-function properties pass through untouched (e.g. a plain `url` field)', () => {
  const raw = { url: 'https://indexer.example', upload: async () => 'x' };
  const wrapped = wrapIndexerQuiet(raw);
  assert.equal(wrapped.url, 'https://indexer.example');
});

test('a method that internally calls a sibling method via `this` is not double-wrapped or broken', async () => {
  const calls: string[] = [];
  const raw = {
    async inner() {
      calls.push('inner');
      console.log('inner noise');
      return 'inner-result';
    },
    async outer(this: { inner: () => Promise<string> }) {
      calls.push('outer');
      console.log('outer noise');
      // Mirrors how the real Indexer's methods call sibling
      // methods/HttpProvider internals via `this` — must resolve against
      // the raw object, not bounce back through the proxy trap.
      const innerResult = await this.inner();
      return `outer+${innerResult}`;
    },
  };
  const spy = spyOnRealStdout();
  try {
    const wrapped = wrapIndexerQuiet(raw);
    const result = await wrapped.outer();
    assert.equal(result, 'outer+inner-result');
    assert.deepEqual(calls, ['outer', 'inner']);
    assert.deepEqual(spy.chunks, []);
  } finally {
    spy.restore();
  }
});
