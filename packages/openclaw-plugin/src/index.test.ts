import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "./index.js";
import { makeMockApi, makeMockSession } from "./test-helpers.js";

// All tests here use a structural mock `openSession` — no @dmemo/core
// module is ever constructed, no network call is possible.

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
