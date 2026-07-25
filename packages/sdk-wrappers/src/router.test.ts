import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouterClients, listPrivateModels, ROUTER_BASE_URLS } from './router.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('listPrivateModels: filters to verifiability === "TeeML" only', async () => {
  const calls: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    calls.push(input.toString());
    return jsonResponse({
      data: [
        { id: 'qwen/qwen2.5-omni-7b', verifiability: 'TeeML' },
        { id: 'some/non-tee-model', verifiability: 'None' },
        { id: 'another/tee-model', verifiability: 'TeeML' },
      ],
    });
  }) as typeof fetch;

  const models = await listPrivateModels({ fetch: mockFetch });
  assert.equal(models.length, 2);
  assert.deepEqual(
    models.map((m) => m.id),
    ['qwen/qwen2.5-omni-7b', 'another/tee-model']
  );
  assert.equal(calls[0], `${ROUTER_BASE_URLS.testnet}/models`);
});

test('listPrivateModels: defaults to testnet, throws on non-OK response', async () => {
  const mockFetch = (async () => new Response('', { status: 500 })) as typeof fetch;
  await assert.rejects(() => listPrivateModels({ fetch: mockFetch }), /HTTP 500/);
});

test('createRouterClients: baseURL follows network selection (testnet default)', () => {
  const { network, baseURL } = createRouterClients({});
  assert.equal(network, 'testnet');
  assert.equal(baseURL, ROUTER_BASE_URLS.testnet);
});

test('createRouterClients: rejects an invalid network value', () => {
  assert.throws(() => createRouterClients({ network: 'devnet' as never }));
});

test('createRouterClients: sends X-0G-Provider-Trust-Mode: private by default and Bearer auth', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return jsonResponse({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' } }] });
  }) as typeof fetch;

  const { openai } = createRouterClients({ apiKey: 'sk-test-key', fetch: mockFetch });
  await openai.chat.completions.create({
    model: 'qwen/qwen2.5-omni-7b',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.startsWith(ROUTER_BASE_URLS.testnet));
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get('x-0g-provider-trust-mode'), 'private');
  assert.equal(headers.get('authorization'), 'Bearer sk-test-key');
});

test('createRouterClients: verifyTee injects verify_tee:true into the request body', async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ init });
    return jsonResponse({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' } }] });
  }) as typeof fetch;

  const { openai } = createRouterClients({ apiKey: 'sk-test-key', fetch: mockFetch, verifyTee: true });
  await openai.chat.completions.create({
    model: 'qwen/qwen2.5-omni-7b',
    messages: [{ role: 'user', content: 'hello' }],
  });

  const sentBody = JSON.parse(calls[0]!.init!.body as string);
  assert.equal(sentBody.verify_tee, true);
});

test('createRouterClients: logs x_0g_trace.tee_verified via onTeeTrace when present on the response', async () => {
  const mockFetch = (async () =>
    jsonResponse({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      x_0g_trace: { tee_verified: true },
    })) as typeof fetch;

  let seenTrace: unknown;
  let resolveSeen!: () => void;
  const seen = new Promise<void>((resolve) => {
    resolveSeen = resolve;
  });

  const { openai } = createRouterClients({
    apiKey: 'sk-test-key',
    fetch: mockFetch,
    onTeeTrace: (trace) => {
      seenTrace = trace;
      resolveSeen();
    },
  });

  await openai.chat.completions.create({
    model: 'qwen/qwen2.5-omni-7b',
    messages: [{ role: 'user', content: 'hello' }],
  });

  await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for onTeeTrace')), 2000))]);
  assert.equal((seenTrace as { tee_verified?: boolean })?.tee_verified, true);
});
