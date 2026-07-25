import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  turnBoundarySessionID,
  parseCaptureEveryNTurns,
  transformMessagesSessionID,
  SessionTurnTracker,
  DEFAULT_CAPTURE_EVERY_N_TURNS,
} from './sessionTurns.js';

// F5 regression suite. Every case below encodes behaviour measured against a
// live OpenCode 1.18.5 server (see `sessionTurns.ts` for the raw numbers).

test('turn boundary: both spellings of idle are accepted, nothing else is', () => {
  assert.equal(
    turnBoundarySessionID({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } }),
    's1',
    'session.status{idle} is the current boundary event'
  );
  assert.equal(
    turnBoundarySessionID({ type: 'session.idle', properties: { sessionID: 's1' } }),
    's1',
    'session.idle is deprecated but still emitted by 1.18.5 and by older servers'
  );

  for (const notABoundary of [
    { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    { type: 'session.status', properties: { sessionID: 's1', status: { type: 'retry' } } },
    { type: 'message.updated', properties: { info: { role: 'assistant', finish: 'stop', sessionID: 's1' } } },
    { type: 'message.part.updated', properties: {} },
    { type: 'session.status', properties: { status: { type: 'idle' } } }, // no sessionID
  ]) {
    assert.equal(turnBoundarySessionID(notABoundary as any), undefined, `must ignore ${JSON.stringify(notABoundary)}`);
  }
  assert.equal(turnBoundarySessionID(undefined), undefined);
});

test('turn counting is idempotent per assistant message (the idle event PAIR counts once)', () => {
  const tracker = new SessionTurnTracker(3);
  // OpenCode publishes session.status{idle} AND session.idle for one turn.
  const first = tracker.observeTurn('s1', 'msg-a');
  const second = tracker.observeTurn('s1', 'msg-a');

  assert.deepEqual(first, { newTurn: true, turnIndex: 1, shouldCapture: false });
  assert.deepEqual(second, { newTurn: false, turnIndex: 1, shouldCapture: false });
});

test('cadence fires on every Nth DISTINCT turn, counting the doubled idle events once', () => {
  const tracker = new SessionTurnTracker(3);
  const captured: number[] = [];

  // Nine turns, each arriving as the measured pair of idle events.
  for (let turn = 1; turn <= 9; turn++) {
    const a = tracker.observeTurn('s1', `msg-${turn}`);
    const b = tracker.observeTurn('s1', `msg-${turn}`);
    assert.equal(b.shouldCapture, false, 'the duplicate boundary must never trigger a second capture');
    if (a.shouldCapture) captured.push(turn);
  }

  assert.deepEqual(captured, [3, 6, 9], 'exactly every 3rd turn — the old code fired on 2 of every 3');
});

test('a turn made of several assistant messages (tool steps) still counts as ONE turn', () => {
  // Measured: a single user turn with one tool call produces assistant
  // message #1 (finish "tool-calls") then #2 (finish "stop"). Only the
  // newest message reaches the tracker, because the boundary handler reads
  // the last assistant message rather than each finishing step.
  const tracker = new SessionTurnTracker(2);
  assert.equal(tracker.observeTurn('s1', 'answer-1').turnIndex, 1);
  assert.equal(tracker.observeTurn('s1', 'answer-2').turnIndex, 2);
  assert.equal(tracker.observeTurn('s1', 'answer-2').turnIndex, 2, 'duplicate boundary for turn 2');
  assert.equal(tracker.observeTurn('s1', 'answer-3').turnIndex, 3);
});

test('counters are per-session: interleaved sessions do not share a cadence', () => {
  const tracker = new SessionTurnTracker(3);
  const captures: string[] = [];

  // Two sessions interleaved on one plugin instance. Globally this is 6
  // turns, so a shared counter would fire twice; per-session it fires never
  // (each session only reaches turn 3 on its own third turn).
  for (let i = 1; i <= 2; i++) {
    for (const s of ['s1', 's2']) {
      if (tracker.observeTurn(s, `${s}-msg-${i}`).shouldCapture) captures.push(`${s}@${i}`);
    }
  }
  assert.deepEqual(captures, [], 'two sessions at 2 turns each must not add up to a capture');

  assert.equal(tracker.observeTurn('s1', 's1-msg-3').shouldCapture, true, 's1 reaches its own 3rd turn');
  assert.equal(tracker.observeTurn('s2', 's2-msg-3').shouldCapture, true, 's2 reaches its own 3rd turn');
});

test('claimCapture dedupes across capture paths, and is scoped per session', () => {
  const tracker = new SessionTurnTracker();
  assert.equal(tracker.claimCapture('s1', 'msg-a'), true, 'cadence claims it');
  assert.equal(tracker.claimCapture('s1', 'msg-a'), false, 'pre-compaction must not re-add the same turn');
  assert.equal(tracker.claimCapture('s2', 'msg-a'), true, 'same id in another session is a different turn');
  assert.equal(tracker.claimCapture('s1', 'msg-b'), true, 'a new turn in s1 is claimable again');
});

test('compaction cooldown clock is per-session, not global', () => {
  const tracker = new SessionTurnTracker();
  assert.equal(tracker.lastCaptureAtMs('s1'), 0);
  tracker.noteCaptureAt('s1', 12_345);
  assert.equal(tracker.lastCaptureAtMs('s1'), 12_345);
  assert.equal(tracker.lastCaptureAtMs('s2'), 0, "s1's cooldown must not gate s2");
});

test('last user prompt is remembered per session', () => {
  const tracker = new SessionTurnTracker();
  tracker.noteUserText('s1', 'question one');
  tracker.noteUserText('s2', 'question two');
  assert.equal(tracker.userText('s1'), 'question one');
  assert.equal(tracker.userText('s2'), 'question two');
  assert.equal(tracker.userText('s3'), '', 'unknown session yields empty, never undefined');
});

test('session records are LRU-bounded so a long-lived server cannot grow forever', () => {
  const tracker = new SessionTurnTracker(3, 3);
  for (const s of ['s1', 's2', 's3']) tracker.noteUserText(s, s);
  tracker.userText('s1'); // touch s1 -> s2 is now the coldest
  tracker.noteUserText('s4', 's4');

  assert.equal(tracker.trackedSessions, 3, 'capacity is enforced');
  assert.equal(tracker.userText('s1'), 's1', 'recently touched session survives');
  assert.equal(tracker.userText('s4'), 's4', 'newest session is retained');
});

test('the default cadence captures EVERY turn', () => {
  assert.equal(DEFAULT_CAPTURE_EVERY_N_TURNS, 1, 'dropping turns loses content; flush cost self-coalesces instead');

  const tracker = new SessionTurnTracker();
  for (let turn = 1; turn <= 5; turn++) {
    const first = tracker.observeTurn('s1', `msg-${turn}`);
    const duplicate = tracker.observeTurn('s1', `msg-${turn}`); // the idle pair
    assert.equal(first.shouldCapture, true, `turn ${turn} must be captured`);
    assert.equal(duplicate.shouldCapture, false, `turn ${turn} must not be captured twice`);
  }
});

// --- pending memory-context isolation (cross-session leak fix) -------------
// `pendingContext` used to be one array shared by every session on the
// server; these are the same per-session-record primitives already proven
// LRU-bounded above, extended to cover the queued injection context too.

test('pending context is queued and drained per session; a second drain sees nothing', () => {
  const tracker = new SessionTurnTracker();
  tracker.pushPendingContext('s1', 'ctx-1a');
  tracker.pushPendingContext('s1', 'ctx-1b');
  tracker.pushPendingContext('s2', 'ctx-2a');

  assert.deepEqual(tracker.takePendingContext('s1'), ['ctx-1a', 'ctx-1b'], 's1 gets its own two blocks, in order');
  assert.deepEqual(tracker.takePendingContext('s1'), [], 'draining again returns nothing — consumed once');
  assert.deepEqual(tracker.takePendingContext('s2'), ['ctx-2a'], "s2's context is untouched by s1's push/drain");
});

test('resetPendingContext clears only the named session', () => {
  const tracker = new SessionTurnTracker();
  tracker.pushPendingContext('s1', 'ctx-1');
  tracker.pushPendingContext('s2', 'ctx-2');
  tracker.resetPendingContext('s1');
  assert.deepEqual(tracker.takePendingContext('s1'), [], "s1's context was reset");
  assert.deepEqual(tracker.takePendingContext('s2'), ['ctx-2'], "s2's context survives s1's reset");
});

test('pending context is LRU-bounded together with the rest of the per-session record', () => {
  const tracker = new SessionTurnTracker(1, 2);
  tracker.pushPendingContext('s1', 'ctx-for-s1');
  tracker.pushPendingContext('s2', 'ctx-for-s2');
  tracker.pushPendingContext('s3', 'ctx-for-s3'); // capacity 2 -> evicts s1, the coldest

  assert.equal(tracker.trackedSessions, 2, 'capacity is enforced');
  assert.deepEqual(tracker.takePendingContext('s1'), [], "s1 was evicted — its unconsumed context does not resurrect");
  assert.deepEqual(tracker.takePendingContext('s3'), ['ctx-for-s3']);
});

test('transformMessagesSessionID: resolves the shared session id, or undefined if absent/disagreeing', () => {
  assert.equal(transformMessagesSessionID([]), undefined, 'empty array has no owner');
  assert.equal(
    transformMessagesSessionID([{ info: { sessionID: 's1' } }, { info: { sessionID: 's1' } }]),
    's1',
    'every message agrees -> resolved'
  );
  assert.equal(
    transformMessagesSessionID([{ info: { sessionID: 's1' } }, { info: { sessionID: 's2' } }]),
    undefined,
    'disagreement across messages -> unresolved, never guess'
  );
  assert.equal(
    transformMessagesSessionID([{ info: {} }, { info: { sessionID: 's1' } }]),
    undefined,
    'a missing sessionID anywhere in the array -> unresolved'
  );
  assert.equal(
    transformMessagesSessionID([{ info: undefined }] as any),
    undefined,
    'a message with no info at all -> unresolved'
  );
});

test('parseCaptureEveryNTurns: sane values pass, anything unusable falls back', () => {
  assert.equal(parseCaptureEveryNTurns('1'), 1);
  assert.equal(parseCaptureEveryNTurns('3'), 3, 'the old sampling cadence stays available');
  assert.equal(parseCaptureEveryNTurns('10'), 10);
  assert.equal(parseCaptureEveryNTurns(undefined), DEFAULT_CAPTURE_EVERY_N_TURNS);
  for (const bad of ['', '   ', '0', '-2', 'abc', 'NaN']) {
    assert.equal(parseCaptureEveryNTurns(bad), DEFAULT_CAPTURE_EVERY_N_TURNS, `"${bad}" must fall back`);
  }
});
