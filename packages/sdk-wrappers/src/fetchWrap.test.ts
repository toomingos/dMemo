import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAIMemoryFetch } from './fetchWrap.js';
import { accumulateOpenAIStream } from './sse.js';
import type { DmemoMemorySession, MemorySearchResult } from './memorySession.js';

// ---------------------------------------------------------------------------
// Local mock server speaking OpenAI-style chat/completions, both plain-JSON
// and SSE-streamed, matching the shape createOpenAIMemoryFetch expects.
// ---------------------------------------------------------------------------

type Handler = (body: any) => { status?: number; stream?: string[]; json?: unknown };

async function startMockServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const result = handler(body);
      if (result.stream) {
        res.writeHead(result.status ?? 200, { 'content-type': 'text/event-stream' });
        for (const piece of result.stream) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.json ?? {}));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function makeFakeSession(searchResults: readonly MemorySearchResult[] = []) {
  const searchCalls: Array<{ query: string; options: unknown }> = [];
  const addCalls: Array<{ data: unknown; options: unknown }> = [];
  let flushCalls = 0;
  let resolveAdded!: () => void;
  const added = new Promise<void>((resolve) => {
    resolveAdded = resolve;
  });

  const session: DmemoMemorySession = {
    memory: {
      async search(query, options) {
        searchCalls.push({ query, options });
        return { results: searchResults };
      },
      async add(data, options) {
        addCalls.push({ data, options });
        resolveAdded();
        return { results: [] };
      },
    },
    flush() {
      flushCalls++;
    },
  };

  return {
    session,
    searchCalls,
    addCalls,
    get flushCalls() {
      return flushCalls;
    },
    waitForAdd: () =>
      Promise.race([
        added,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for memory.add')), 2000)),
      ]),
  };
}

function postJson(url: string, wrappedFetch: typeof fetch, body: unknown, extra: RequestInit = {}) {
  return wrappedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...extra,
  });
}

test('injection shape: memory search results are injected as a system message before the real fetch', async () => {
  let receivedBody: any;
  const mock = await startMockServer((body) => {
    receivedBody = body;
    return { json: { choices: [{ message: { role: 'assistant', content: 'The sky is blue because of Rayleigh scattering.' } }] } };
  });
  try {
    const fake = makeFakeSession([{ id: 'm1', memory: 'User previously asked about atmospheric optics.' }]);
    const wrapped = createOpenAIMemoryFetch({ session: fake.session, userId: 'u1' }, fetch);

    await postJson(mock.url, wrapped, {
      model: 'qwen/qwen2.5-omni-7b',
      messages: [{ role: 'user', content: 'why is the sky blue?' }],
    });

    assert.equal(fake.searchCalls.length, 1);
    assert.equal(fake.searchCalls[0]!.query, 'why is the sky blue?');
    assert.equal(receivedBody.messages[0].role, 'system');
    assert.match(receivedBody.messages[0].content, /User previously asked about atmospheric optics\./);
    assert.equal(receivedBody.messages[1].role, 'user');
  } finally {
    await mock.close();
  }
});

test('non-stream write-back: awaited completion text is captured via session.memory.add + flush', async () => {
  const mock = await startMockServer(() => ({
    json: { choices: [{ message: { role: 'assistant', content: 'Paris is the capital of France.' } }] },
  }));
  try {
    const fake = makeFakeSession();
    const wrapped = createOpenAIMemoryFetch({ session: fake.session, userId: 'u1' }, fetch);

    const res = await postJson(mock.url, wrapped, {
      model: 'qwen/qwen2.5-omni-7b',
      messages: [{ role: 'user', content: 'what is the capital of France?' }],
    });
    const callerJson = (await res.json()) as any;
    assert.equal(callerJson.choices[0].message.content, 'Paris is the capital of France.');

    await fake.waitForAdd();
    assert.equal(fake.addCalls.length, 1);
    const turns = fake.addCalls[0]!.data as Array<{ role: string; content: string }>;
    assert.equal(turns[0]!.role, 'user');
    assert.equal(turns[0]!.content, 'what is the capital of France?');
    assert.equal(turns[1]!.role, 'assistant');
    assert.equal(turns[1]!.content, 'Paris is the capital of France.');
    assert.equal(fake.flushCalls, 1);
  } finally {
    await mock.close();
  }
});

test('stream write-back parity: accumulated write-back text equals what the caller actually received', async () => {
  const pieces = ['The ', 'quick ', 'brown ', 'fox ', 'jumps.'];
  const expected = pieces.join('');
  const mock = await startMockServer((body) => (body.stream ? { stream: pieces } : { json: {} }));
  try {
    const fake = makeFakeSession();
    const wrapped = createOpenAIMemoryFetch({ session: fake.session, userId: 'u1' }, fetch);

    const res = await postJson(mock.url, wrapped, {
      model: 'qwen/qwen2.5-omni-7b',
      messages: [{ role: 'user', content: 'tell me something' }],
      stream: true,
    });
    assert.ok(res.body, 'expected a readable stream body');
    // Simulate the caller/agent reading the primary (untouched) stream.
    const callerText = await accumulateOpenAIStream(res.body as ReadableStream<Uint8Array>);
    assert.equal(callerText, expected);

    await fake.waitForAdd();
    assert.equal(fake.addCalls.length, 1);
    const turns = fake.addCalls[0]!.data as Array<{ role: string; content: string }>;
    assert.equal(turns[1]!.content, expected, 'write-back text must match what the caller streamed');
    assert.equal(fake.flushCalls, 1);
  } finally {
    await mock.close();
  }
});

test('fail-open: with no session, the wrapper is a transparent passthrough', async () => {
  let receivedBody: any;
  const mock = await startMockServer((body) => {
    receivedBody = body;
    return { json: { choices: [{ message: { role: 'assistant', content: 'unchanged' } }] } };
  });
  try {
    const wrapped = createOpenAIMemoryFetch({}, fetch); // no session
    const outboundBody = { model: 'qwen/qwen2.5-omni-7b', messages: [{ role: 'user', content: 'hi' }] };
    const res = await postJson(mock.url, wrapped, outboundBody);
    const json = (await res.json()) as any;
    assert.equal(json.choices[0].message.content, 'unchanged');
    assert.deepEqual(receivedBody, outboundBody);
  } finally {
    await mock.close();
  }
});

test('fail-open: a throwing session.memory.search does not break the outgoing request', async () => {
  let receivedBody: any;
  const mock = await startMockServer((body) => {
    receivedBody = body;
    return { json: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
  });
  try {
    const session: DmemoMemorySession = {
      memory: {
        async search() {
          throw new Error('search backend unavailable');
        },
        async add() {
          return { results: [] };
        },
      },
      flush() {},
    };
    let loggedStage: string | undefined;
    const wrapped = createOpenAIMemoryFetch(
      { session, userId: 'u1', onError: (stage) => (loggedStage = stage) },
      fetch
    );
    const outboundBody = { model: 'qwen/qwen2.5-omni-7b', messages: [{ role: 'user', content: 'hi' }] };
    const res = await postJson(mock.url, wrapped, outboundBody);
    assert.equal(res.status, 200);
    assert.deepEqual(receivedBody, outboundBody, 'falls back to the unmodified request body');
    assert.equal(loggedStage, 'search');
  } finally {
    await mock.close();
  }
});
