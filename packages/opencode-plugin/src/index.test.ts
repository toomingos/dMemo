import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks } from '@opencode-ai/plugin';
import { createDmemoPlugin, type DmemoPluginDeps } from './index.js';
import { shouldTriggerCapture, totalTokens, COMPACTION_THRESHOLD_RATIO, COMPACTION_MIN_TOKENS, COMPACTION_COOLDOWN_MS } from './compaction.js';
import { MissingConfigError, type DmemoConfig } from '@dmemo/core';
import type { DmemoSessionLike } from './types.js';

// F7: every hooks object whose session actually opened has
// `installGracefulShutdown` registering real `process.on('SIGTERM'/...)`
// listeners against *this* test process. Track each one and dispose it in
// `afterEach` (below) — otherwise every test in this file that opens a
// session leaks 3 more listeners onto the shared node:test process
// (MaxListenersExceededWarning after ~10), and a real signal during a test
// run would invoke a pile of stale closures over already-torn-down mock
// sessions. Disposing per-test (not just once at file end) keeps the
// listener count bounded throughout the run, not just after it.
const openedHooks: Hooks[] = [];
function trackHooks(hooks: Hooks): Hooks {
  openedHooks.push(hooks);
  return hooks;
}
afterEach(async () => {
  const pending = openedHooks.splice(0, openedHooks.length);
  await Promise.allSettled(pending.map((h) => h.dispose?.()));
});

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
  const hooks = trackHooks(await plugin(ctx as any));
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

  const userMsg = { info: { role: 'user', id: 'u1', sessionID: 's1' }, parts: [{ type: 'text', text: 'what did we decide about auth?' }] };
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

  const userMsg = { info: { role: 'user', id: 'u1', sessionID: 's1' }, parts: [{ type: 'text', text: 'hello there friend' }] };
  const output = { messages: [userMsg] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, output);
  assert.equal(output.messages[0].parts.length, 1);
});

// --- cross-session context isolation (fix for the leak F5 flagged but left
// out of scope: `pendingContext` used to be one array shared by every
// session on the server, so session A's injected memory could be drained
// into session B's `transform` call under interleaving). These tests exist
// specifically to fail against the pre-fix code — a test that only drives
// one session at a time cannot catch this.

test('cross-session isolation: interleaved sessions each get only their own queued context, never the other\'s', async () => {
  const session = makeMockSession();
  // Distinguish "whose memory is this" by echoing the query into the result,
  // rather than relying on the mock's fixed 'prior fact'.
  session.memory.search = async (query: unknown) => ({ results: [{ id: 'mem-1', memory: `secret for ${query}`, score: 0.9 }] });
  const { hooks } = await buildHooks(session);

  const userMsgFor = (sessionID: string) => ({
    info: { role: 'user', id: `u-${sessionID}`, sessionID },
    parts: [{ type: 'text', text: `question from ${sessionID}` }],
  });

  // The decisive interleaving: BOTH sessions produce context before EITHER
  // transform runs, and the transforms fire in the opposite order (B then
  // A) — a shared array would deliver whichever push happened last (B's) to
  // both.
  await hooks['chat.message']!({ sessionID: 'A' } as any, { message: {} as any, parts: [{ type: 'text', text: 'question from A' }] as any });
  await hooks['chat.message']!({ sessionID: 'B' } as any, { message: {} as any, parts: [{ type: 'text', text: 'question from B' }] as any });

  const outputB = { messages: [userMsgFor('B')] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, outputB);
  assert.equal(outputB.messages[0].parts.length, 2, 'B must receive its own injected context');
  assert.match(outputB.messages[0].parts[0].text, /question from B/, 'B must see its own memory');
  assert.doesNotMatch(outputB.messages[0].parts[0].text, /question from A/, 'B must never see A\'s memory');

  const outputA = { messages: [userMsgFor('A')] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, outputA);
  assert.equal(outputA.messages[0].parts.length, 2, 'A must still receive its own injected context, undisturbed by B');
  assert.match(outputA.messages[0].parts[0].text, /question from A/, 'A must see its own memory');
  assert.doesNotMatch(outputA.messages[0].parts[0].text, /question from B/, 'A must never see B\'s memory');

  // Each session's context is consumed exactly once.
  const outputBAgain = { messages: [userMsgFor('B')] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, outputBAgain);
  assert.equal(outputBAgain.messages[0].parts.length, 1, 'already-drained context must not be redelivered');
});

test('transform for a session with no queued context (never called chat.message) is a no-op', async () => {
  const { hooks } = await buildHooks(makeMockSession());
  const userMsg = { info: { role: 'user', id: 'u1', sessionID: 'never-seen' }, parts: [{ type: 'text', text: 'hi' }] };
  const output = { messages: [userMsg] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, output);
  assert.equal(output.messages[0].parts.length, 1, 'no pending context for this session -> transcript untouched');
});

test('missing sessionID on the transform output drops rather than misdelivers another session\'s context', async () => {
  const { hooks } = await buildHooks(makeMockSession());

  // Session A has real pending context waiting.
  await hooks['chat.message']!({ sessionID: 'A' } as any, { message: {} as any, parts: [{ type: 'text', text: 'question from A' }] as any });

  const userMsgNoSessionID = { info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'anything' }] };
  const output = { messages: [userMsgNoSessionID] as any };
  await hooks['experimental.chat.messages.transform']!({} as any, output);

  assert.equal(output.messages[0].parts.length, 1, 'unresolvable owner -> drop, never guess and misdeliver A\'s context');
});

test('transform output messages disagreeing on sessionID is a fail-closed drop (contract-drift defense)', async () => {
  const { hooks } = await buildHooks(makeMockSession());
  await hooks['chat.message']!({ sessionID: 'B' } as any, { message: {} as any, parts: [{ type: 'text', text: 'question from B' }] as any });

  const mixed = {
    messages: [
      { info: { role: 'assistant', id: 'a1', sessionID: 'A' }, parts: [] },
      { info: { role: 'user', id: 'u1', sessionID: 'B' }, parts: [{ type: 'text', text: 'question from B' }] },
    ] as any,
  };
  await hooks['experimental.chat.messages.transform']!({} as any, mixed);
  assert.equal(mixed.messages[1].parts.length, 1, 'disagreeing sessionIDs across the array -> drop, never guess which owns it');
});

// --- F5: capture cadence -----------------------------------------------------
// These replay the event stream a real OpenCode 1.18.5 server emits, recorded
// from a live `opencode serve` run (see `sessionTurns.ts`). The shape that
// matters: each assistant message emits `message.updated` with `finish` set
// TWICE, a tool-using turn emits one such message per step, and the turn
// boundary arrives as BOTH `session.status`{idle} and the deprecated
// `session.idle`.

/** Drive one complete assistant turn exactly as OpenCode reports it. */
async function playTurn(
  hooks: any,
  sessionID: string,
  opts: { userText: string; answerId: string; toolStepId?: string }
): Promise<void> {
  await hooks['chat.message']!({ sessionID } as any, {
    message: {} as any,
    parts: [{ type: 'text', text: opts.userText }] as any,
  });

  const finishEvents: any[] = [];
  // A tool step is its own assistant message, finishing with "tool-calls".
  if (opts.toolStepId) {
    finishEvents.push({ id: opts.toolStepId, finish: 'tool-calls' }, { id: opts.toolStepId, finish: 'tool-calls' });
  }
  finishEvents.push({ id: opts.answerId, finish: 'stop' }, { id: opts.answerId, finish: 'stop' });
  for (const e of finishEvents) {
    await hooks.event!({
      event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID, ...e } } },
    } as any);
  }

  // Boundary, published under both names for the same turn.
  await hooks.event!({ event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } } } as any);
  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID } } } as any);
}

/**
 * Run `fn` with a pinned capture cadence. The plugin reads
 * `DMEMO_OPENCODE_CAPTURE_EVERY` once at hook-init, so this must wrap
 * `buildHooks` too. Tests that assert cadence *arithmetic* pin the value
 * explicitly rather than riding on the default, so changing the default
 * can't silently gut them.
 */
async function withCaptureEvery(n: number, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.DMEMO_OPENCODE_CAPTURE_EVERY;
  process.env.DMEMO_OPENCODE_CAPTURE_EVERY = String(n);
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.DMEMO_OPENCODE_CAPTURE_EVERY;
    else process.env.DMEMO_OPENCODE_CAPTURE_EVERY = prev;
  }
}

function ctxWithLastAssistant(lastId: () => string, text = 'the reply') {
  return {
    client: {
      app: { log: async () => {} },
      provider: { list: async () => ({ data: { all: [] } }) },
      session: {
        messages: async () => ({
          data: [{ info: { role: 'assistant', id: lastId() }, parts: [{ type: 'text', text }] }],
        }),
      },
    },
  };
}

test('F5 default: every turn is captured exactly once, despite the doubled events', async () => {
  const session = makeMockSession();
  let current = 'a1';
  const { hooks } = await buildHooks(session, ctxWithLastAssistant(() => current));

  // No DMEMO_OPENCODE_CAPTURE_EVERY set: this is the shipped default.
  for (const i of [1, 2, 3]) {
    current = `a${i}`;
    await playTurn(hooks, 's1', { userText: `question ${i}`, answerId: current });
  }

  // Each turn arrives as 2 finish events + 2 idle spellings = 4 chances to
  // over-capture. Idempotency per assistant message is what holds it to 3.
  assert.equal(session.adds.length, 3, 'three turns, three captures — no turn dropped, none duplicated');
  assert.deepEqual(
    session.adds.map((a: any) => /question (\d)/.exec(a.messages)?.[1]),
    ['1', '2', '3'],
    'every turn captured, in order'
  );
  assert.equal(session.adds[0].config.infer, false, 'dMemo default: verbatim capture, no LLM inference');
  assert.match(session.adds[0].messages, /the reply/, 'and the assistant answer, not just the prompt');
});

test('F5 default: a tool-call turn is still ONE capture, and it holds the answer', async () => {
  const session = makeMockSession();
  let current = 'a1';
  const { hooks } = await buildHooks(session, ctxWithLastAssistant(() => current));

  // One turn, one tool call: 2 assistant messages, 4 finish events. Even at
  // "capture every turn" this must not become two captures — and the one it
  // makes must be the answer, not the empty finish:"tool-calls" step.
  current = 'a1';
  await playTurn(hooks, 's1', { userText: 'question 1', answerId: current, toolStepId: 'tool1' });

  assert.equal(session.adds.length, 1, 'a multi-step turn is one turn');
  assert.match(session.adds[0].messages, /the reply/, 'captured the answer, not the empty tool step');
});

test('F5 cadence: with an explicit cadence, tool steps do not advance the turn counter', async () => {
  await withCaptureEvery(3, async () => {
    const session = makeMockSession();
    let current = 'a1';
    const { hooks } = await buildHooks(session, ctxWithLastAssistant(() => current));

    // Two turns, each with a tool call: 4 assistant messages, 8 finish events.
    // The old gate would have captured twice (at events 3 and 6).
    for (const i of [1, 2]) {
      current = `a${i}`;
      await playTurn(hooks, 's1', { userText: `question ${i}`, answerId: current, toolStepId: `tool${i}` });
    }
    assert.equal(session.adds.length, 0, 'two turns is short of the every-3rd cadence, tool steps notwithstanding');

    current = 'a3';
    await playTurn(hooks, 's1', { userText: 'question 3', answerId: current, toolStepId: 'tool3' });
    assert.equal(session.adds.length, 1, 'the third real turn captures');
    assert.match(session.adds[0].messages, /question 3/, 'and it is the turn that landed on the cadence');
  });
});

test('F5 cadence: message.updated alone never captures — only the turn boundary does', async () => {
  const session = makeMockSession();
  const { hooks } = await buildHooks(session, ctxWithLastAssistant(() => 'a1'));

  await hooks['chat.message']!({ sessionID: 's1' } as any, { message: {} as any, parts: [{ type: 'text', text: 'q' }] as any });
  for (let i = 1; i <= 12; i++) {
    await hooks.event!({
      event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 's1', id: `a${i}`, finish: 'stop' } } },
    } as any);
  }
  assert.equal(session.adds.length, 0, 'twelve finish events, no idle: nothing captured');
});

test('F5 cadence: concurrent sessions keep independent counters', async () => {
  await withCaptureEvery(3, async () => {
    const session = makeMockSession();
    let current = 'x';
    const { hooks } = await buildHooks(session, ctxWithLastAssistant(() => current));

    // Two turns each, interleaved: 4 turns globally, but neither session has
    // reached its own 3rd turn, so nothing may be captured.
    for (const i of [1, 2]) {
      for (const s of ['s1', 's2']) {
        current = `${s}-a${i}`;
        await playTurn(hooks, s, { userText: `${s} question ${i}`, answerId: current });
      }
    }
    assert.equal(session.adds.length, 0, 'a shared counter would have fired at the global 3rd turn');

    current = 's1-a3';
    await playTurn(hooks, 's1', { userText: 's1 question 3', answerId: current });
    assert.equal(session.adds.length, 1);
    assert.match(session.adds[0].messages, /s1 question 3/, 'and it captures the right session’s prompt');
  });
});

test('F5: dispose drains a capture still in flight before closing (opencode drops event promises)', async () => {
  // Cadence pinned to 3 so exactly one capture (turn 3) is in flight at
  // dispose time — this asserts draining, not the default cadence.
  await withCaptureEvery(3, async () => {
    const session = makeMockSession();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = 'a1';
    let stall = false;
    const base = ctxWithLastAssistant(() => current);
    const { hooks } = await buildHooks(session, {
      client: {
        ...base.client,
        session: {
          messages: async () => {
            if (stall) await gate; // hold the final turn's capture mid-flight
            return { data: [{ info: { role: 'assistant', id: current }, parts: [{ type: 'text', text: 'the reply' }] }] };
          },
        },
      },
    });

    // Turns 1 and 2 settle normally and land short of the cadence.
    for (const i of [1, 2]) {
      current = `a${i}`;
      await playTurn(hooks, 's1', { userText: `q${i}`, answerId: current });
    }
    assert.equal(session.adds.length, 0);

    // Turn 3 lands ON the cadence, but its capture stalls. Do NOT await the
    // event hook — opencode drops the promise it returns.
    stall = true;
    current = 'a3';
    await hooks['chat.message']!({ sessionID: 's1' } as any, { message: {} as any, parts: [{ type: 'text', text: 'q3' }] as any });
    void hooks.event!({ event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } } } as any);

    assert.equal(session.adds.length, 0, 'still blocked on the transcript fetch');
    release!();
    await hooks.dispose!();
    assert.equal(session.adds.length, 1, 'dispose waited for the in-flight capture');
    assert.match(session.adds[0].messages, /q3/);
    assert.equal(session.closed, true);
  });
});

test('F7: hooks.dispose() is idempotent — a second call does not re-drain, re-flush or re-close', async () => {
  const session = makeMockSession();
  const { hooks } = await buildHooks(session);

  await hooks.dispose!();
  const flushedAfterFirst = session.flushed;
  const closedAfterFirst = session.closed;
  assert.equal(closedAfterFirst, true);

  // A second dispose (e.g. the host calling it again, or a caught signal
  // arriving after a clean plugin teardown already ran) must be a no-op —
  // it must not re-run the flush/close path a second time.
  await hooks.dispose!();
  assert.equal(session.flushed, flushedAfterFirst, 'flush must not run again on a second dispose');
  assert.equal(session.closed, true);
});

test('F7: dispose() uninstalls its own SIGTERM/SIGINT/SIGHUP listeners (no leak across plugin lifecycles)', async () => {
  const before = {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGHUP: process.listenerCount('SIGHUP'),
  };

  const session = makeMockSession();
  const { hooks } = await buildHooks(session);

  assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM + 1, 'opening a session installs one graceful-shutdown listener per signal');
  assert.equal(process.listenerCount('SIGINT'), before.SIGINT + 1);
  assert.equal(process.listenerCount('SIGHUP'), before.SIGHUP + 1);

  await hooks.dispose!();

  assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM, 'dispose must remove the listener it installed');
  assert.equal(process.listenerCount('SIGINT'), before.SIGINT);
  assert.equal(process.listenerCount('SIGHUP'), before.SIGHUP);

  // Already tracked and disposed above; remove from the module-level list so
  // the file-level `after()` cleanup doesn't call dispose() on it a third
  // time (harmless either way, since dispose is idempotent, but keeps the
  // accounting honest).
  const idx = openedHooks.indexOf(hooks);
  if (idx !== -1) openedHooks.splice(idx, 1);
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

// --- F1: the plugin's DEFAULT config loader (no `deps.loadConfig` override)
// must see `~/.dmemo/config.json` written by `dmemo setup`, not just
// `process.env` — this is the exact bug this task fixes. Every test above
// injects `loadConfig` directly; this one exercises the real default wired
// in `createDmemoPlugin` (`loadDmemoConfig` from `@dmemo/core`) end-to-end
// against a scratch `DMEMO_HOME`, restoring `process.env` afterward so it
// can't leak into any other test in this process.
const FAKE_KEY = '0xcccc3333333333333333333333333333333333333333333333333333333333';

function withScratchDmemoHome<T>(fn: () => Promise<T>): Promise<T> {
  const savedHome = process.env.DMEMO_HOME;
  const savedKey = process.env.DMEMO_PRIVATE_KEY;
  const savedNetwork = process.env.DMEMO_NETWORK;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-opencode-plugin-test-'));
  process.env.DMEMO_HOME = path.join(dir, '.dmemo');
  delete process.env.DMEMO_PRIVATE_KEY;
  delete process.env.DMEMO_NETWORK;

  const restore = () => {
    if (savedHome === undefined) delete process.env.DMEMO_HOME;
    else process.env.DMEMO_HOME = savedHome;
    if (savedKey === undefined) delete process.env.DMEMO_PRIVATE_KEY;
    else process.env.DMEMO_PRIVATE_KEY = savedKey;
    if (savedNetwork === undefined) delete process.env.DMEMO_NETWORK;
    else process.env.DMEMO_NETWORK = savedNetwork;
  };

  return fn().then(
    (result) => {
      restore();
      return result;
    },
    (err) => {
      restore();
      throw err;
    }
  );
}

test('F1: with no env var set, a config file at $DMEMO_HOME/config.json is enough for the real default loader to open a session', async () => {
  await withScratchDmemoHome(async () => {
    fs.mkdirSync(process.env.DMEMO_HOME!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.DMEMO_HOME!, 'config.json'),
      JSON.stringify({ DMEMO_PRIVATE_KEY: FAKE_KEY, DMEMO_NETWORK: 'testnet' }),
      { mode: 0o600 }
    );

    let openedWithKey: string | undefined;
    const plugin = createDmemoPlugin({
      openSession: async (opts: any) => {
        openedWithKey = opts.privateKey;
        return makeMockSession();
      },
    });
    const hooks = trackHooks(await plugin(makeCtx() as any));

    assert.notDeepEqual(hooks, {}, 'plugin must not fail open when config.json alone has the wallet');
    assert.equal(openedWithKey, FAKE_KEY, 'the session must be opened with the key from config.json');
  });
});

test('F1: a real DMEMO_PRIVATE_KEY env var still wins over config.json', async () => {
  await withScratchDmemoHome(async () => {
    fs.mkdirSync(process.env.DMEMO_HOME!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.DMEMO_HOME!, 'config.json'),
      JSON.stringify({ DMEMO_PRIVATE_KEY: FAKE_KEY, DMEMO_NETWORK: 'mainnet' }),
      { mode: 0o600 }
    );
    process.env.DMEMO_PRIVATE_KEY = '0xdddd444444444444444444444444444444444444444444444444444444444444';
    process.env.DMEMO_NETWORK = 'testnet';

    let opened: any;
    const plugin = createDmemoPlugin({
      openSession: async (opts: any) => {
        opened = opts;
        return makeMockSession();
      },
    });
    trackHooks(await plugin(makeCtx() as any));

    assert.equal(opened.privateKey, process.env.DMEMO_PRIVATE_KEY, 'env private key must win over the file');
    assert.equal(opened.network, 'testnet', 'env network must win over the file');
  });
});

test('F1: neither env nor config.json configured -> fails open (no hooks, no session), never throws', async () => {
  await withScratchDmemoHome(async () => {
    let openCalled = false;
    const plugin = createDmemoPlugin({
      openSession: async () => {
        openCalled = true;
        return makeMockSession();
      },
    });
    const hooks = await plugin(makeCtx() as any);
    assert.deepEqual(hooks, {});
    assert.equal(openCalled, false);
  });
});
