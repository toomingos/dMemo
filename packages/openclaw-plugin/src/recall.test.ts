import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderMemoryBlock,
  extractTurns,
  sanitizeQuery,
  newMessagesSince,
  stripTimestampPrefix,
  sanitizeCapturedText,
  sanitizeTurns,
} from "./recall.js";

// ==========================================================================
// E1 — newMessagesSince
// ==========================================================================

test("newMessagesSince: slices off already-seen messages given a previous count", () => {
  const messages = ["a", "b", "c", "d"];
  assert.deepEqual(newMessagesSince(messages, 2), ["c", "d"]);
});

test("newMessagesSince: previousCount 0 (first-ever turn) returns everything", () => {
  const messages = ["a", "b"];
  assert.deepEqual(newMessagesSince(messages, 0), ["a", "b"]);
});

test("newMessagesSince: previousCount === length returns an empty slice (nothing new)", () => {
  const messages = ["a", "b"];
  assert.deepEqual(newMessagesSince(messages, 2), []);
});

test("newMessagesSince: undefined previousCount (no prior state) returns the full array", () => {
  const messages = ["a", "b", "c"];
  assert.deepEqual(newMessagesSince(messages, undefined), ["a", "b", "c"]);
});

test("newMessagesSince: previousCount larger than the array (state reset / array shrank) falls back to the full array rather than dropping data", () => {
  const messages = ["a", "b"];
  assert.deepEqual(newMessagesSince(messages, 99), ["a", "b"]);
});

test("newMessagesSince: negative or non-finite previousCount falls back to the full array", () => {
  const messages = ["a", "b"];
  assert.deepEqual(newMessagesSince(messages, -1), ["a", "b"]);
  assert.deepEqual(newMessagesSince(messages, NaN), ["a", "b"]);
});

test("newMessagesSince: non-array messages returns an empty array", () => {
  assert.deepEqual(newMessagesSince(undefined, 0), []);
});

test("newMessagesSince: models the growing-cumulative-snapshot bug directly (E1 evidence: 2 -> 4 -> 6 messages across 3 turns)", () => {
  const turn1 = ["u1", "a1"];
  const turn2 = [...turn1, "u2", "a2"];
  const turn3 = [...turn2, "u3", "a3"];

  const seenAfterTurn1 = newMessagesSince(turn1, undefined);
  assert.deepEqual(seenAfterTurn1, ["u1", "a1"]);

  const seenAfterTurn2 = newMessagesSince(turn2, seenAfterTurn1.length);
  assert.deepEqual(seenAfterTurn2, ["u2", "a2"], "must NOT re-include turn1's messages");

  const seenAfterTurn3 = newMessagesSince(turn3, turn2.length);
  assert.deepEqual(seenAfterTurn3, ["u3", "a3"], "must NOT re-include turn1+turn2's messages");
});

// ==========================================================================
// E5 — stripTimestampPrefix
// ==========================================================================

test("stripTimestampPrefix: strips the host's exact envelope shape (weekday, date, HH:MM, zone)", () => {
  assert.equal(
    stripTimestampPrefix("[Sat 2026-07-25 20:21 GMT+1] I want to tell you something."),
    "I want to tell you something.",
  );
});

test("stripTimestampPrefix: handles an optional :SS seconds component", () => {
  assert.equal(
    stripTimestampPrefix("[Mon 2026-01-05 09:03:47 UTC] hello"),
    "hello",
  );
});

test("stripTimestampPrefix: handles a missing timezone suffix (host may omit it)", () => {
  assert.equal(stripTimestampPrefix("[Tue 2026-02-10 14:00] no timezone here"), "no timezone here");
});

test("stripTimestampPrefix: leaves ordinary text without the envelope untouched", () => {
  assert.equal(stripTimestampPrefix("just a normal message"), "just a normal message");
});

test("stripTimestampPrefix: does not eat real user text that merely starts with a bracket", () => {
  const text = "[TODO] fix the timestamp bug";
  assert.equal(stripTimestampPrefix(text), text);
});

test("stripTimestampPrefix: does not eat a bracket that looks close but isn't the exact shape (e.g. no weekday)", () => {
  const text = "[2026-07-25 20:21 GMT+1] not quite the host's shape";
  assert.equal(stripTimestampPrefix(text), text);
});

// ==========================================================================
// E2 — sanitizeCapturedText / sanitizeTurns
// ==========================================================================

const RECALL_BLOCK = "Relevant memories from prior sessions:\n- fact one\n- fact two";

test("sanitizeCapturedText: strips an exact injected recall block prefix", () => {
  const text = `${RECALL_BLOCK}\n\nWhat did we decide about the schema?`;
  assert.equal(sanitizeCapturedText(text, RECALL_BLOCK), "What did we decide about the schema?");
});

test("sanitizeCapturedText: strips the recall block AND the timestamp envelope underneath it, in order", () => {
  const text = `${RECALL_BLOCK}\n\n[Sat 2026-07-25 20:21 GMT+1] What did we decide about the schema?`;
  assert.equal(
    sanitizeCapturedText(text, RECALL_BLOCK),
    "What did we decide about the schema?",
  );
});

test("sanitizeCapturedText: leaves text untouched when no injectedContext is given", () => {
  const text = "just a normal prompt";
  assert.equal(sanitizeCapturedText(text, undefined), "just a normal prompt");
});

test("sanitizeCapturedText: does not strip when the text doesn't actually start with the given block (no false match)", () => {
  const text = "I was just talking about relevant memories from prior sessions, unrelated to the injected one";
  assert.equal(sanitizeCapturedText(text, RECALL_BLOCK), text);
});

test("sanitizeCapturedText: repeated recall blocks never compound — reproduces the observed double-nested case", () => {
  // Turn N's stored (buggy, pre-fix) content already contained one
  // recall-block layer; turn N+1 injects a NEW recall block built from
  // search results that include that already-polluted memory, then the
  // host prepends it again. Even in that pathological case, one strip pass
  // removes exactly the CURRENT turn's injected block.
  const nested = `${RECALL_BLOCK}\n\n${RECALL_BLOCK}\n\noriginal question`;
  assert.equal(sanitizeCapturedText(nested, RECALL_BLOCK), `${RECALL_BLOCK}\n\noriginal question`);
});

test("sanitizeTurns: strips the injected block from user turns only, leaves assistant turns untouched", () => {
  const turns = [
    { role: "user", content: `${RECALL_BLOCK}\n\n[Sat 2026-07-25 20:21 GMT+1] hi there` },
    { role: "assistant", content: "hello, how can I help?" },
  ];
  const result = sanitizeTurns(turns, RECALL_BLOCK);
  assert.deepEqual(result, [
    { role: "user", content: "hi there" },
    { role: "assistant", content: "hello, how can I help?" },
  ]);
});

test("sanitizeTurns: drops a turn that strips down to nothing", () => {
  const turns = [{ role: "user", content: `${RECALL_BLOCK}\n\n` }];
  const result = sanitizeTurns(turns, RECALL_BLOCK);
  assert.deepEqual(result, []);
});

test("sanitizeTurns: no injectedContext -> only timestamp stripping applies", () => {
  const turns = [{ role: "user", content: "[Sat 2026-07-25 20:21 GMT+1] hi there" }];
  assert.deepEqual(sanitizeTurns(turns, undefined), [{ role: "user", content: "hi there" }]);
});

// ==========================================================================
// Existing behavior — unchanged by this fix (regression guard).
// ==========================================================================

test("renderMemoryBlock/extractTurns/sanitizeQuery: still behave as before", () => {
  assert.equal(renderMemoryBlock([{ memory: "fact" }]), "Relevant memories from prior sessions:\n- fact");
  assert.deepEqual(extractTurns([{ role: "user", content: "hi" }, { role: "system", content: "ignored" }]), [
    { role: "user", content: "hi" },
  ]);
  assert.equal(sanitizeQuery("hi"), undefined);
  assert.equal(sanitizeQuery("a real question"), "a real question");
});
