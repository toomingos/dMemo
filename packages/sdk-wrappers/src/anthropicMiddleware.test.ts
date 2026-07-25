import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicMemoryMiddleware } from './anthropicMiddleware.js';
import type { DmemoMemorySession, MemorySearchResult } from './memorySession.js';

// Unit-tests the middleware function directly against fake `next`/`ctx`
// objects shaped per `@anthropic-ai/sdk`'s `Middleware` signature
// (`core/middleware.d.ts`) — no live Anthropic/Router network call needed
// (mainnet-only for Claude models per TASKS.md; nothing here is live-tested,
// see the final report).

function makeFakeSession(searchResults: readonly MemorySearchResult[] = []) {
  const addCalls: Array<{ data: unknown; options: unknown }> = [];
  let flushCalls = 0;
  let resolveAdded!: () => void;
  const added = new Promise<void>((resolve) => {
    resolveAdded = resolve;
  });

  const session: DmemoMemorySession = {
    memory: {
      async search(_query, _options) {
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

function fakeRequest(body: unknown) {
  return { url: 'https://example.invalid/v1/messages', method: 'POST', headers: new Headers(), body: JSON.stringify(body) } as any;
}

test('anthropic middleware: injects memory into the system field, non-stream write-back via ctx.parse', async () => {
  const fake = makeFakeSession([{ id: 'm1', memory: 'The user is named Ada.' }]);
  const mw = createAnthropicMemoryMiddleware({ session: fake.session, userId: 'u1' });

  const request = fakeRequest({
    model: 'claude-sonnet-5',
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'what is my name?' }],
    stream: false,
  });

  let nextSawBody: any;
  const next = async (req: any) => {
    nextSawBody = JSON.parse(req.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Your name is Ada.' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const ctx = {
    logger: console,
    parse: async (response: Response) => response.json(),
  } as any;

  const response = await mw(request, next, ctx);
  assert.equal(response.status, 200);
  assert.match(nextSawBody.system, /Be concise\./);
  assert.match(nextSawBody.system, /The user is named Ada\./);

  await fake.waitForAdd();
  const turns = fake.addCalls[0]!.data as Array<{ role: string; content: string }>;
  assert.equal(turns[0]!.content, 'what is my name?');
  assert.equal(turns[1]!.content, 'Your name is Ada.');
  assert.equal(fake.flushCalls, 1);
});

test('anthropic middleware: streaming write-back accumulates ctx.parse-yielded events', async () => {
  const fake = makeFakeSession();
  const mw = createAnthropicMemoryMiddleware({ session: fake.session, userId: 'u1' });

  const request = fakeRequest({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'tell me something' }],
    stream: true,
  });

  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there.' } },
    { type: 'message_stop' },
  ];
  const next = async () => new Response(null, { status: 200 });
  const ctx = {
    logger: console,
    parse: async () => (async function* () {
      for (const e of events) yield e;
    })(),
  } as any;

  const response = await mw(request, next, ctx);
  assert.equal(response.status, 200);

  await fake.waitForAdd();
  const turns = fake.addCalls[0]!.data as Array<{ role: string; content: string }>;
  assert.equal(turns[1]!.content, 'Hi there.');
  assert.equal(fake.flushCalls, 1);
});

test('anthropic middleware: fail-open with no session leaves the request untouched', async () => {
  const mw = createAnthropicMemoryMiddleware({});
  const originalBody = JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const request = { url: 'https://example.invalid/v1/messages', method: 'POST', headers: new Headers(), body: originalBody } as any;

  let nextCalled = false;
  const next = async (req: any) => {
    nextCalled = true;
    assert.equal(req.body, originalBody, 'request body must be unmodified when there is no session');
    return new Response(JSON.stringify({ content: [] }), { status: 200 });
  };
  const ctx = { logger: console, parse: async (r: Response) => r.json() } as any;

  await mw(request, next, ctx);
  assert.ok(nextCalled);
});
