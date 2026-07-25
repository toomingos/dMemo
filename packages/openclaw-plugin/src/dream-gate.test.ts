import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDreamBatch, acquireDreamLock, checkCheapGates } from "./dream-gate.js";
import { makeMockSession } from "./test-helpers.js";
import type { DmemoSession } from "@dmemo/core";

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dmemo-dream-test-"));
}

test("runDreamBatch: tags every mutation source:dream and flushes exactly ONCE for the whole burst", async () => {
  const stateDir = tmpStateDir();
  const mock = makeMockSession();
  const { session, addCalls } = mock;

  const result = await runDreamBatch(
    session as unknown as DmemoSession,
    "user:1",
    stateDir,
    [{ content: "merged memory A" }, { content: "merged memory B" }, { content: "merged memory C" }],
    { minHours: 0, minSessions: 0, minMemories: 0 },
  );

  assert.equal(result.ran, true);
  assert.equal(result.count, 3);
  assert.equal(addCalls.length, 3, "one add() call per mutation");
  for (const call of addCalls) {
    assert.equal(call.opts.metadata?.source, "dream");
    assert.equal(call.opts.infer, false, "dream mutations never call an LLM either");
  }
  assert.equal(mock.flushCalls, 1, "the whole dream burst must be ONE flush, not N");
});

test("runDreamBatch: cheap gates block when session/time thresholds are not met", async () => {
  const stateDir = tmpStateDir();
  const { session, addCalls } = makeMockSession();

  const result = await runDreamBatch(
    session as unknown as DmemoSession,
    "user:1",
    stateDir,
    [{ content: "x" }],
    { minHours: 24, minSessions: 5, minMemories: 0 }, // fresh state: sessionsSince=0 < 5
  );

  assert.equal(result.ran, false);
  assert.match(result.reason ?? "", /sessions:/);
  assert.equal(addCalls.length, 0);
});

test("runDreamBatch: refuses to run while the lock is already held", async () => {
  const stateDir = tmpStateDir();
  assert.equal(acquireDreamLock(stateDir), true);

  const { session } = makeMockSession();
  const result = await runDreamBatch(
    session as unknown as DmemoSession,
    "user:1",
    stateDir,
    [{ content: "x" }],
    { minHours: 0, minSessions: 0, minMemories: 0 },
  );

  assert.equal(result.ran, false);
  assert.match(result.reason ?? "", /lock/);
});

test("checkCheapGates: fresh stateDir (never consolidated) passes the time gate immediately", () => {
  const stateDir = tmpStateDir();
  const gate = checkCheapGates(stateDir, { minHours: 24, minSessions: 0 });
  assert.equal(gate.proceed, true);
});
