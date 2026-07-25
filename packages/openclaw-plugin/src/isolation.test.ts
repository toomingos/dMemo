import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNonInteractiveTrigger,
  isSubagentSession,
  extractAgentId,
  effectiveUserId,
  resolveUserId,
} from "./isolation.js";

test("isNonInteractiveTrigger: skips cron/heartbeat/automation/schedule triggers", () => {
  assert.equal(isNonInteractiveTrigger("cron", undefined), true);
  assert.equal(isNonInteractiveTrigger("HEARTBEAT", undefined), true);
  assert.equal(isNonInteractiveTrigger(undefined, "agent:main:cron:123"), true);
  assert.equal(isNonInteractiveTrigger("user", "agent:main:main"), false);
});

test("isSubagentSession: detects :subagent: session keys", () => {
  assert.equal(isSubagentSession("agent:main:subagent:abc"), true);
  assert.equal(isSubagentSession("agent:main:main"), false);
  assert.equal(isSubagentSession(undefined), false);
});

test("extractAgentId: main session -> undefined, named agent -> id, subagent -> subagent-<uuid>", () => {
  assert.equal(extractAgentId("agent:main:main"), undefined);
  assert.equal(extractAgentId("agent:researcher:main"), "researcher");
  assert.equal(extractAgentId("agent:main:subagent:uuid-1"), "subagent-uuid-1");
  assert.equal(extractAgentId(undefined), undefined);
});

test("effectiveUserId: subagents read the PARENT scope (no :agent: suffix added)", () => {
  assert.equal(effectiveUserId("base", "agent:main:subagent:uuid-1"), "base");
  assert.equal(effectiveUserId("base", "agent:researcher:main"), "base:agent:researcher");
  assert.equal(effectiveUserId("base", "agent:main:main"), "base");
  assert.equal(effectiveUserId("base", undefined), "base");
});

test("resolveUserId: explicit agentId > explicit userId > session-derived > base", () => {
  assert.equal(resolveUserId("base", { agentId: "x" }, "agent:researcher:main"), "base:agent:x");
  assert.equal(resolveUserId("base", { userId: "explicit" }, "agent:researcher:main"), "explicit");
  assert.equal(resolveUserId("base", {}, "agent:researcher:main"), "base:agent:researcher");
  assert.equal(resolveUserId("base", {}, undefined), "base");
});
