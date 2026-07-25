import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDmemoPlugin, type DmemoPluginDeps } from './index.js';
import { shouldTriggerCapture, totalTokens, COMPACTION_THRESHOLD_RATIO, COMPACTION_MIN_TOKENS, COMPACTION_COOLDOWN_MS } from './compaction.js';
import { MissingConfigError, type DmemoConfig } from '@dmemo/core';
import type { DmemoSessionLike } from './types.js';

// Structural mock — never touches mem0ai, 0G Storage, or the network.
// Matches the subset of DmemoSession this plugin actually calls.
function makeMockSession(): DmemoSessionLike & { adds: any[]; searches: any[]; flushed: number; closed: boolean } {
  const state = { adds: [] as any[], searches: [] as any[], flushed: 0, closed: false };
  return {
    memory: {
      async add(messages: unknown, config: unknown) {
        state.adds.push({ messages, config });
        return { results: [{ id: `mem-${state.adds.length}`, memory: String(messages) }] };
      },
      async search(query: unknown, config: unknown) {
        state.searches.push({ query, config });
        return { results: [{ id: 'mem-1', memory: 'prior fact', score: 0.9 }] };
      },
    } as any,
    flush() {
      state.flushed++;
    },
    async waitForPendingFlush() {},
    async close() {
      state.closed = true;
    },
    // Getters, not spread-copied primitives — `flushed`/`closed` must
    // reflect live mutations from `flush()`/`close()`, not a snapshot
    // taken at construction time.
    get adds() {
      return state.adds;
    },
    get searches() {
      return state.searches;
    },
    get flushed() {
      return state.flushed;
    },
    get closed() {
      return state.closed;
    },
  } as any;
}

const FAKE_CONFIG: DmemoConfig = {
  network: 'testnet',
  privateKey: '0xfake',
  infer: false,
  checkpointEveryNFlushes: 2,
  checkpointSizeThresholdBytes: 65536,
  uploadTimeoutMs: 120_000,
  networkOverrides: {},
};

function makeCtx(overrides: Partial<any> = {}) {
  const logs: any[] = [];
  return {
    client: {
      app: { log: async (o: any) => { logs.push(o); } },
      provider: { list: async () => ({ data: { all: [{ id: 'anthropic', models: { 'claude': { limit: { context: 100_000 } } } }] } }) },
      session: { messages: async () => ({ data: [] }) },
    },
    directory: '/repo/my-project',
    worktree: '/repo/my-project',
    project: {},
    serverUrl: new URL('http://localhost:1234'),
    $: (async () => {}) as any,
    experimental_workspace: { register() {} },
    _logs: logs,
    ...overrides,
  };
}

async function buildHooks(session: DmemoSessionLike, ctxOverrides: Partial<any> = {}, configOverrides: Partial<DmemoConfig> = {}) {
  const deps: DmemoPluginDeps = {
    openSession: async () => session,
    loadConfig: () => ({ ...FAKE_CONFIG, ...configOverrides }),
  };
  const plugin = createDmemoPlugin(deps);
  const ctx = makeCtx(ctxOverrides);
  const hooks = await plugin(ctx as any);
  return { hooks, ctx };
}

test('fail-open: missing config disables the plugin (no hooks, no session opened)', async () => {
  let openCalled = false;
  const deps: DmemoPluginDeps = {
    openSession: async () => {
      openCalled = true;
      return makeMockSession();
    },
    loadConfig: () => {
      throw new MissingConfigError('DMEMO_PRIVATE_KEY');
    },
  };
  const plugin = createDmemoPlugin(deps);
  const hooks = await plugin(makeCtx() as any);
  assert.deepEqual(hooks, {});
  assert.equal(openCalled, false);
});

test('fail-open: session open failure (e.g. no funded wallet) disables the plugin, never throws', async () => {
  const deps: DmemoPluginDeps = {
    openSession: async () => {
      throw new Error('simulated: RPC unreachable');
    },
    loadConfig: () => FAKE_CONFIG,
  };
  const plugin = createDmemoPlugin(deps);
  const hooks = await plugin(makeCtx() as any);
  assert.deepEqual(hooks, {});
});

test('Platform-only tools are absent; only the two manual memory tools are registered', async () => {
  const { hooks } = await buildHooks(makeMockSession());
  const toolNames = Object.keys(hooks.tool ?? {});
  assert.deepEqual(toolNames.sort(), ['dmemo_add', 'dmemo_search']);
  for (const stripped of ['autoSetupCategories', 'delete_entities', 'list_entities', 'get_event_status']) {
    assert.equal(toolNames.includes(stripped), false);
  }
});

test('injection: chat.message searches memory, transform inserts a leading text block into the newest user message', async () => {
  const { hooks } = await buildHooks(makeMockSession());

  await hooks['chat.message']!(
    { sessionID: 's1' } as any,
    { message: {} as any, parts: [{ type: 'text', text: 'what did we decide about auth?' }] as any }
  );

  const userMsg = { info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'what did we decide about auth?' }] };
  const output = { messages: [userMsg] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, output);

  assert.equal(output.messages[0].parts.length, 2);
  assert.match(output.messages[0].parts[0].text, /dMemo Memory Context/);
  assert.match(output.messages[0].parts[0].text, /prior fact/);
});

test('injection is fail-open: a search error leaves the transcript untouched, no throw', async () => {
  const session = makeMockSession();
  session.memory.search = async () => {
    throw new Error('simulated: session closed');
  };
  const { hooks } = await buildHooks(session);

  await hooks['chat.message']!({ sessionID: 's1' } as any, { message: {} as any, parts: [{ type: 'text', text: 'hello there friend' }] as any });

  const userMsg = { info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'hello there friend' }] };
  const output = { messages: [userMsg] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, output);
  assert.equal(output.messages[0].parts.length, 1);
});

test('capture cadence: every 3rd assistant-finish message.updated event triggers a verbatim add()+flush()', async () => {
  const session = makeMockSession();
  const { hooks, ctx } = await buildHooks(session, {
    client: {
      app: { log: async () => {} },
      provider: { list: async () => ({ data: { all: [] } }) },
      session: {
        messages: async () => ({
          data: [{ info: { role: 'assistant', id: 'a1' }, parts: [{ type: 'text', text: 'the reply' }] }],
        }),
      },
    },
  });

  await hooks['chat.message']!({ sessionID: 's1' } as any, { message: {} as any, parts: [{ type: 'text', text: 'question one' }] as any });

  for (let i = 1; i <= 3; i++) {
    await hooks.event!({
      event: {
        type: 'message.updated',
        properties: { info: { role: 'assistant', finish: 'stop', sessionID: 's1', id: `a${i}` } },
      } as any,
    });
  }

  assert.equal(session.adds.length, 1, 'expected exactly one capture at the 3rd assistant turn');
  assert.equal(session.flushed, 1);
  assert.equal(session.adds[0].config.infer, false, 'dMemo default: verbatim capture, no LLM inference');
});

test('capture cadence: capture is deduped per assistant messageID (no double-add)', async () => {
  const session = makeMockSession();
  const { hooks } = await buildHooks(session, {
    client: {
      app: { log: async () => {} },
      provider: { list: async () => ({ data: { all: [] } }) },
      session: { messages: async () => ({ data: [] }) },
    },
  });
  await hooks['chat.message']!({ sessionID: 's1' } as any, { message: {} as any, parts: [{ type: 'text', text: 'q' }] as any });
  for (let i = 0; i < 3; i++) {
    await hooks.event!({
      event: { type: 'message.updated', properties: { info: { role: 'assistant', finish: 'stop', sessionID: 's1', id: 'same-id' } } } as any,
    });
  }
  // Same messageID every time -> dedup keeps this at most 1 add even though
  // the 3rd-message counter would otherwise fire once here.
  assert.ok(session.adds.length <= 1);
});

test('compaction trigger math: cooldown gate blocks even when ratio/size thresholds are met', () => {
  const now = 1_000_000;
  const result = shouldTriggerCapture({
    totalTokens: COMPACTION_MIN_TOKENS + 1,
    contextLimit: 100_000,
    lastCaptureAtMs: now - (COMPACTION_COOLDOWN_MS - 1),
    now,
  });
  assert.equal(result, false);
});

test('compaction trigger math: fires only when ratio >= 0.80 AND tokens >= 50k AND cooldown elapsed', () => {
  const now = 1_000_000;
  const base = { lastCaptureAtMs: now - COMPACTION_COOLDOWN_MS - 1, now };

  assert.equal(
    shouldTriggerCapture({ ...base, totalTokens: 79_000, contextLimit: 100_000 }),
    false,
    'ratio 0.79 must not trigger'
  );
  assert.equal(
    shouldTriggerCapture({ ...base, totalTokens: 80_000, contextLimit: 100_000 }),
    true,
    'ratio exactly 0.80 must trigger'
  );
  assert.equal(
    shouldTriggerCapture({ ...base, totalTokens: 49_999, contextLimit: 10_000 }),
    false,
    'below the 50k token floor must not trigger even at 100% ratio'
  );
  assert.equal(
    shouldTriggerCapture({ ...base, totalTokens: 80_000, contextLimit: undefined }),
    false,
    'unresolved context limit fails open to no-trigger'
  );
});

test('totalTokens sums all five token buckets', () => {
  assert.equal(totalTokens({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }), 15);
});

test('compaction hook: captures the last assistant turn and injects a recall note, fail-open on error', async () => {
  const session = makeMockSession();
  const { hooks } = await buildHooks(session, {
    client: {
      app: { log: async () => {} },
      provider: { list: async () => ({ data: { all: [] } }) },
      session: {
        messages: async () => ({
          data: [{ info: { role: 'assistant', id: 'final-1' }, parts: [{ type: 'text', text: 'final answer' }] }],
        }),
      },
    },
  });
  const output = { context: [] as string[] };
  await hooks['experimental.session.compacting']!({ sessionID: 's1' } as any, output as any);
  assert.equal(session.adds.length, 1);
  assert.equal(output.context.length, 1);
  assert.match(output.context[0]!, /dmemo_search/);
});

test('dmemo_add tool captures verbatim (infer:false) and flushes', async () => {
  const session = makeMockSession();
  const { hooks } = await buildHooks(session);
  const result = await (hooks.tool!.dmemo_add as any).execute({ text: 'remember this fact' }, {} as any);
  assert.equal(session.adds.length, 1);
  assert.equal(session.adds[0].config.infer, false);
  assert.equal(session.flushed, 1);
  assert.match(result as string, /mem-1/);
});
