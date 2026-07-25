import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { register as realRegister } from "./index.js";
import { makeMockApi, makeMockSession } from "./test-helpers.js";

// `makeMockApi`'s `resolvePath` returns a single fixed path shared by every
// test in this file (and across repeated `pnpm test` runs, since it's not
// cleaned up). E1's capture-state.json now persists real per-session data
// under `<stateDir>/capture-state.json`, so any test that calls `agent_end`
// needs its OWN isolated stateDir — otherwise leftover counts from one test
// (or a prior run) silently change another test's `newMessagesSince` slice.
// Mirrors `dream-gate.test.ts`'s own `tmpStateDir()` helper exactly.
function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dmemo-openclaw-index-test-"));
}

// All tests here use a structural mock `openSession` — no @dmemo/core
// module is ever constructed, no network call is possible.

// F7: `register()` installs real `process.on('SIGTERM'/...)` listeners
// against *this* test process whenever memory is enabled (this host has no
// dispose/teardown hook of its own — see index.ts). Track each returned
// handle's `uninstall()` and call it after every test, or the ~7 tests here
// that configure a `privateKey` leak 3 listeners apiece onto the shared
// node:test process (MaxListenersExceededWarning, plus stale closures over
// already-torn-down mock sessions that would fire on a real signal mid-run).
const handles: Array<{ uninstall: () => void; dispose: () => Promise<void> }> = [];
function register(...args: Parameters<typeof realRegister>): ReturnType<typeof realRegister> {
  const handle = realRegister(...args);
  handles.push(handle);
  return handle;
}
afterEach(() => {
  const pending = handles.splice(0, handles.length);
  for (const { uninstall } of pending) uninstall();
});

test("fail-open: no privateKey configured -> no-op tools registered, opener never called", async () => {
  const { api, tools, logs } = makeMockApi({});
  let openerCalled = false;
  register(api, async () => {
    openerCalled = true;
    return makeMockSession().session;
  });

  assert.equal(openerCalled, false);
  assert.ok(tools.find((t) => t.name === "memory_search"));
  assert.ok(tools.find((t) => t.name === "memory_get"));
  const result = (await tools
    .find((t) => t.name === "memory_search")!
    .execute("id1", { query: "x" })) as { content: Array<{ text: string }> };
  assert.match(result.content[0]!.text, /not configured/);
  assert.ok(logs.some((l) => l.level === "warn" && /privateKey/.test(l.msg)));
});

test("registers memory_search and memory_get tools when configured", () => {
  const { api, tools } = makeMockApi({ privateKey: "0xabc", scope: "u1", dream: { stateDir: tmpStateDir() } });
  const { session } = makeMockSession();
  register(api, async () => session);

  assert.ok(tools.find((t) => t.name === "memory_search"));
  assert.ok(tools.find((t) => t.name === "memory_get"));
});

test("hard assert: infer is always false on capture, even if config sets infer:true (core-invariant guard)", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "u1", infer: true, dream: { stateDir: tmpStateDir() } });
  const { session, addCalls } = makeMockSession();
  register(api, async () => session);

  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  await agentEnd.handler(
    { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello there" }], success: true },
    { sessionKey: "agent:main:main", trigger: "user" },
  );

  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0]!.opts.infer, false);
  // Structural guard: nothing in the resolved config surface can carry an
  // OpenAI provider string through to the session — dMemo has no such knob.
  assert.equal(JSON.stringify(api.pluginConfig).toLowerCase().includes("openai"), false);
});

test("subagent scoping: recall reads the PARENT scope, and capture is skipped entirely", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir: tmpStateDir() } });
  const { session, addCalls, searchCalls } = makeMockSession([{ memory: "parent fact" }]);
  register(api, async () => session);

  const beforePromptBuild = hooks.find((h) => h.event === "before_prompt_build")!;
  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  const subagentCtx = { sessionKey: "agent:main:subagent:uuid-1", trigger: "user" };

  const recallResult = await beforePromptBuild.handler(
    { prompt: "what did we decide about the schema?" },
    subagentCtx,
  );

  assert.equal(searchCalls.length, 1);
  assert.deepEqual((searchCalls[0]!.opts as { filters: { user_id: string } }).filters, {
    user_id: "base", // parent scope, no ":agent:" suffix
  });
  assert.ok((recallResult as { prependContext: string }).prependContext.includes("parent fact"));

  await agentEnd.handler(
    { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello there" }], success: true },
    subagentCtx,
  );
  assert.equal(addCalls.length, 0, "subagent turns must never be captured");
});

test("non-interactive triggers (cron/heartbeat) skip both recall and capture", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir: tmpStateDir() } });
  const { session, addCalls, searchCalls } = makeMockSession([{ memory: "should not surface" }]);
  register(api, async () => session);

  const beforePromptBuild = hooks.find((h) => h.event === "before_prompt_build")!;
  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  const cronCtx = { sessionKey: "agent:main:main", trigger: "cron" };

  await beforePromptBuild.handler({ prompt: "run the nightly job please" }, cronCtx);
  assert.equal(searchCalls.length, 0);

  await agentEnd.handler(
    { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello there" }], success: true },
    cronCtx,
  );
  assert.equal(addCalls.length, 0);
});

test("recall.strategy 'manual' disables auto-recall on before_prompt_build", async () => {
  const { api, hooks } = makeMockApi({
    privateKey: "0xabc",
    scope: "base",
    recall: { strategy: "manual" },
    dream: { stateDir: tmpStateDir() },
  });
  const { session, searchCalls } = makeMockSession([{ memory: "x" }]);
  register(api, async () => session);

  const beforePromptBuild = hooks.find((h) => h.event === "before_prompt_build")!;
  const result = await beforePromptBuild.handler({ prompt: "a normal user question here" }, {
    sessionKey: "agent:main:main",
    trigger: "user",
  });

  assert.equal(searchCalls.length, 0);
  assert.equal(result, undefined);
});

test("before_prompt_build fails open on a session-open error (never throws)", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir: tmpStateDir() } });
  register(api, async () => {
    throw new Error("simulated storage-network failure");
  });

  const beforePromptBuild = hooks.find((h) => h.event === "before_prompt_build")!;
  const result = await beforePromptBuild.handler({ prompt: "a normal user question here" }, {
    sessionKey: "agent:main:main",
    trigger: "user",
  });
  assert.equal(result, undefined);
});

test("registers before_prompt_build with the configured recall timeoutMs (default 10000ms)", () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", dream: { stateDir: tmpStateDir() } });
  register(api, async () => makeMockSession().session);
  const beforePromptBuild = hooks.find((h) => h.event === "before_prompt_build")!;
  assert.equal(beforePromptBuild.opts?.timeoutMs, 10_000);
});

test("F7: register() installs one SIGTERM/SIGINT/SIGHUP listener each, and uninstall() removes them", () => {
  const before = {
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGHUP: process.listenerCount("SIGHUP"),
  };

  const { api } = makeMockApi({ privateKey: "0xabc", dream: { stateDir: tmpStateDir() } });
  const handle = register(api, async () => makeMockSession().session);

  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1);
  assert.equal(process.listenerCount("SIGHUP"), before.SIGHUP + 1);

  handle.uninstall();

  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
  assert.equal(process.listenerCount("SIGHUP"), before.SIGHUP);
});

test("F7: no privateKey configured -> no signal listeners installed (nothing to flush, ever)", () => {
  const before = process.listenerCount("SIGTERM");
  const { api } = makeMockApi({});
  register(api, async () => makeMockSession().session);
  assert.equal(process.listenerCount("SIGTERM"), before, "the fail-open path must never touch process signal handling");
});

test("F7: dispose() is a no-op when no session was ever opened (a signal must not be what opens the first one)", async () => {
  const { api } = makeMockApi({ privateKey: "0xabc", dream: { stateDir: tmpStateDir() } });
  let openCalled = false;
  const handle = register(api, async () => {
    openCalled = true;
    return makeMockSession().session;
  });

  await handle.dispose();
  assert.equal(openCalled, false, "dispose() must never trigger the first session open");
});

test("F7: dispose() flushes and closes a session that WAS opened, and is idempotent on a second call", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", dream: { stateDir: tmpStateDir() } });
  // Not destructured: `waitForPendingFlushCalls`/`closeCalls` are getters
  // that must be read live, not snapshotted once (see makeMockSession/the
  // opencode-plugin mock's own note on this exact footgun).
  const mock = makeMockSession();
  const handle = register(api, async () => mock.session);

  // Open the session the same way a real turn would, via the agent_end hook.
  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  await agentEnd.handler(
    { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], success: true },
    { sessionKey: "agent:main:main", trigger: "user" },
  );

  await handle.dispose();
  assert.equal(mock.waitForPendingFlushCalls, 1);
  assert.equal(mock.closeCalls, 1);

  // A second dispose (idempotent, per shutdown.ts's cached-promise contract
  // mirrored here) must not re-run the flush/close path.
  await handle.dispose();
  assert.equal(mock.waitForPendingFlushCalls, 1);
  assert.equal(mock.closeCalls, 1);
});

// ============================================================================
// E1/E2/E5 — live e2e findings (2026-07-25, OpenClaw 2026.7.1-2): agent_end
// resends the FULL cumulative session history every turn (E1), an injected
// recall block gets baked into the user's next prompt and re-captured as if
// they typed it (E2), and the host's own timestamp envelope prefix pollutes
// stored content (E5). See recall.ts's doc comments above `newMessagesSince`
// / `stripTimestampPrefix` / `sanitizeCapturedText` for the host-source
// citations backing each fix.
// ============================================================================

test("E1: repeated agent_end calls with a growing cumulative message list store each exchange exactly once", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir: tmpStateDir() } });
  const { session, addCalls } = makeMockSession();
  register(api, async () => session);
  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  const ctx = { sessionKey: "agent:main:main", trigger: "user" };

  const turn1 = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
  ];
  await agentEnd.handler({ messages: turn1, success: true }, ctx);

  const turn2 = [
    ...turn1,
    { role: "user", content: "second question" },
    { role: "assistant", content: "second answer" },
  ];
  await agentEnd.handler({ messages: turn2, success: true }, ctx);

  const turn3 = [
    ...turn2,
    { role: "user", content: "third question" },
    { role: "assistant", content: "third answer" },
  ];
  await agentEnd.handler({ messages: turn3, success: true }, ctx);

  assert.equal(addCalls.length, 3, "one add() call per NEW turn, not a growing full-history resend");
  assert.deepEqual(addCalls[0]!.messages, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
  ]);
  assert.deepEqual(addCalls[1]!.messages, [
    { role: "user", content: "second question" },
    { role: "assistant", content: "second answer" },
  ]);
  assert.deepEqual(addCalls[2]!.messages, [
    { role: "user", content: "third question" },
    { role: "assistant", content: "third answer" },
  ]);
});

test("E1: dedup survives a process restart between turns (state is file-backed, not an in-memory Map) — the live e2e run showed a different pid per turn", async () => {
  const stateDir = tmpStateDir();
  const ctx = { sessionKey: "agent:main:main", trigger: "user" };

  // "Process 1": first turn, on its own register() instance.
  {
    const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir } });
    const { session, addCalls } = makeMockSession();
    register(api, async () => session);
    const agentEnd = hooks.find((h) => h.event === "agent_end")!;
    await agentEnd.handler(
      { messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }], success: true },
      ctx,
    );
    assert.equal(addCalls.length, 1);
  }

  // "Process 2": a BRAND NEW register() call against the same stateDir (no
  // in-memory state carried over) receiving the host's full cumulative
  // history — must still only capture the new tail.
  {
    const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir } });
    const { session, addCalls } = makeMockSession();
    register(api, async () => session);
    const agentEnd = hooks.find((h) => h.event === "agent_end")!;
    await agentEnd.handler(
      {
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
          { role: "assistant", content: "a2" },
        ],
        success: true,
      },
      ctx,
    );
    assert.equal(addCalls.length, 1, "must not re-capture turn 1 just because it's a fresh process");
    assert.deepEqual(addCalls[0]!.messages, [
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
  }
});

test("E2: an injected recall block is never captured back into memory as if the user typed it", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir: tmpStateDir() } });
  const { session, addCalls } = makeMockSession([{ memory: "prior fact" }]);
  register(api, async () => session);

  const beforePromptBuild = hooks.find((h) => h.event === "before_prompt_build")!;
  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  const ctx = { sessionKey: "agent:main:main", trigger: "user" };

  const recallResult = (await beforePromptBuild.handler({ prompt: "what did we decide?" }, ctx)) as
    | { prependContext: string }
    | undefined;
  assert.ok(recallResult?.prependContext.includes("prior fact"));

  // Mirror exactly what the real host does before this plugin ever sees the
  // message again: `${prependContext}\n\n${prompt}` (confirmed against the
  // installed host source — see recall.ts's `sanitizeCapturedText` doc).
  const joinedPrompt = `${recallResult!.prependContext}\n\nwhat did we decide?`;
  await agentEnd.handler(
    {
      messages: [
        { role: "user", content: joinedPrompt },
        { role: "assistant", content: "we decided X" },
      ],
      success: true,
    },
    ctx,
  );

  assert.equal(addCalls.length, 1);
  const storedUserTurn = addCalls[0]!.messages.find((m) => m.role === "user")!;
  assert.equal(storedUserTurn.content, "what did we decide?");
  assert.ok(!storedUserTurn.content.includes("Relevant memories"));
});

test("E5: the host's timestamp envelope prefix is stripped before storage", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir: tmpStateDir() } });
  const { session, addCalls } = makeMockSession();
  register(api, async () => session);

  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  await agentEnd.handler(
    {
      messages: [
        { role: "user", content: "[Sat 2026-07-25 20:21 GMT+1] I want to tell you something." },
        { role: "assistant", content: "Sure, go ahead." },
      ],
      success: true,
    },
    { sessionKey: "agent:main:main", trigger: "user" },
  );

  assert.equal(addCalls.length, 1);
  const storedUserTurn = addCalls[0]!.messages.find((m) => m.role === "user")!;
  assert.equal(storedUserTurn.content, "I want to tell you something.");
});

test("fail-open: a stateDir where capture-state.json can't be read/written (E1 persistence broken) never blocks capture or throws", async () => {
  const stateDir = tmpStateDir();
  // Shadow the exact filename `readCaptureState`/`writeCaptureState` use
  // with a DIRECTORY, so reads/writes to it throw EISDIR — without also
  // breaking dream-gate.ts's own (differently-named) state file in the same
  // stateDir, which would fail this test for an unrelated reason.
  fs.mkdirSync(path.join(stateDir, "capture-state.json"));

  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base", dream: { stateDir } });
  const { session, addCalls } = makeMockSession();
  register(api, async () => session);

  const agentEnd = hooks.find((h) => h.event === "agent_end")!;
  await agentEnd.handler(
    { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], success: true },
    { sessionKey: "agent:main:main", trigger: "user" },
  );

  // Persistence is broken (read/write both throw internally, caught
  // fail-open by readCaptureState/writeCaptureState), but the turn itself
  // must still be captured — a state-file hiccup must never silently drop
  // a turn's content, and must never throw out of the agent_end handler.
  assert.equal(addCalls.length, 1);
});
