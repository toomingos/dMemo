import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmbedderConfig, embedderIdentityEquals } from './embedder.js';

// T1.5 auto-detect order: explicit config -> Ollama (if reachable) ->
// fastembed fallback. Ollama reachability is checked via a real `fetch`
// call to localhost:11434, so these tests stub `globalThis.fetch` to
// deterministically exercise both branches without depending on whether
// Ollama actually happens to be running on the test machine.

test('resolveEmbedderConfig: explicit config always wins, no fetch probe performed', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called when an explicit config is given');
  }) as typeof fetch;

  try {
    const resolved = await resolveEmbedderConfig({ provider: 'openai', model: 'text-embedding-3-small' });
    assert.equal(resolved.source, 'explicit');
    assert.equal(resolved.provider, 'openai');
    assert.equal(resolved.mem0Config.provider, 'openai');
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveEmbedderConfig: falls back to fastembed when Ollama is unreachable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED (simulated: no Ollama server)');
  }) as typeof fetch;

  try {
    const resolved = await resolveEmbedderConfig();
    assert.equal(resolved.source, 'fastembed-fallback');
    assert.equal(resolved.provider, 'fastembed');
    assert.equal(resolved.model, 'fast-bge-small-en-v1.5');
    assert.equal(resolved.mem0Config.provider, 'fastembed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveEmbedderConfig: falls back to fastembed when Ollama responds non-OK', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;

  try {
    const resolved = await resolveEmbedderConfig();
    assert.equal(resolved.source, 'fastembed-fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveEmbedderConfig: selects Ollama when reachable at localhost:11434', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (url: string | URL) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const resolved = await resolveEmbedderConfig();
    assert.equal(resolved.source, 'ollama-autodetect');
    assert.equal(resolved.provider, 'ollama');
    assert.equal(resolved.model, 'nomic-embed-text');
    assert.match(requestedUrl, /^http:\/\/localhost:11434/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('embedderIdentityEquals compares provider+model+dim', () => {
  const a = { provider: 'fastembed', model: 'fast-bge-small-en-v1.5', dim: 384 };
  const b = { provider: 'fastembed', model: 'fast-bge-small-en-v1.5', dim: 384 };
  const c = { provider: 'ollama', model: 'nomic-embed-text', dim: 768 };
  assert.equal(embedderIdentityEquals(a, b), true);
  assert.equal(embedderIdentityEquals(a, c), false);
});
