import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register as realRegister } from "./index.js";
import { makeMockApi, makeMockSession } from "./test-helpers.js";

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
  const { api, tools } = makeMockApi({ privateKey: "0xabc", scope: "u1" });
  const { session } = makeMockSession();
  register(api, async () => session);

  assert.ok(tools.find((t) => t.name === "memory_search"));
  assert.ok(tools.find((t) => t.name === "memory_get"));
});

test("hard assert: infer is always false on capture, even if config sets infer:true (core-invariant guard)", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "u1", infer: true });
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
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base" });
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
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base" });
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
  const { api, hooks } = makeMockApi({ privateKey: "0xabc", scope: "base" });
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
  const { api, hooks } = makeMockApi({ privateKey: "0xabc" });
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

  const { api } = makeMockApi({ privateKey: "0xabc" });
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
  const { api } = makeMockApi({ privateKey: "0xabc" });
  let openCalled = false;
  const handle = register(api, async () => {
    openCalled = true;
    return makeMockSession().session;
  });

  await handle.dispose();
  assert.equal(openCalled, false, "dispose() must never trigger the first session open");
});

test("F7: dispose() flushes and closes a session that WAS opened, and is idempotent on a second call", async () => {
  const { api, hooks } = makeMockApi({ privateKey: "0xabc" });
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
