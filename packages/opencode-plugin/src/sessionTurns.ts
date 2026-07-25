// Turn-boundary detection and per-session capture bookkeeping (F5).
//
// WHY THIS EXISTS. The capture cadence originally keyed off `message.updated`
// with `info.finish` set, tallied in one global counter. Measured against
// OpenCode 1.18.5 that is wrong three separate ways:
//
//   1. DOUBLE-FIRE. Every assistant message emits `message.updated` with
//      `finish` set TWICE — once before `time.completed` is stamped, once
//      after. OpenCode's own app reducer binary-searches by message id and
//      reconciles in place precisely because a message id receives many
//      `message.updated` events, so this is by design, not a glitch.
//   2. STEPS ARE NOT TURNS. One user turn produces one assistant message per
//      step. A turn containing a single tool call emits `finish:"tool-calls"`
//      for the tool step and `finish:"stop"` for the answer — 2 messages,
//      4 events, for ONE turn. `finish` is a step boundary. Worse, capturing
//      on the tool step reads back an assistant message whose text parts are
//      empty, storing the user prompt with no answer and burning the cadence
//      slot that the real answer needed.
//   3. ONE COUNTER, MANY SESSIONS. A single plugin instance serves every
//      session on the server, so one global counter interleaves unrelated
//      sessions. (The old code already keyed `lastUserText` by session id —
//      the counter simply hadn't followed.)
//
// Measured on OpenCode 1.18.5: 3 assistant messages -> 6 finish events; a
// one-tool-call turn -> 2 messages / 4 events; 2 concurrent sessions -> 1
// shared counter. Net effect: "every 3rd turn" actually fired on 2 of every
// 3 tool-free turns, and drifted arbitrarily once tools were involved.
//
// THE FIX. The real turn boundary is the session going idle, which OpenCode
// emits exactly once per turn, after the runner drains every queued step
// (verified: the 2-message tool turn above produced exactly one idle). It is
// published under two names — `session.status` with `status.type === "idle"`
// (current) and `session.idle` (deprecated but still emitted). We accept
// BOTH, because older servers only send the latter and newer ones may drop
// it; the per-session idempotency below is what keeps the overlapping pair
// from double-counting a single turn.

/**
 * Turns between cadence captures; 1 = capture every turn. Overridable via
 * `DMEMO_OPENCODE_CAPTURE_EVERY`.
 *
 * The fork base sampled every 3rd turn to limit cost. That tradeoff doesn't
 * apply here: `memory.add` is local (verbatim, `infer: false` — a fastembed
 * embedding plus a SQLite write, no LLM call), and the on-chain spend comes
 * from `flush()`, which **self-coalesces**. Flushes are chained sequentially
 * and `runFlush` drains the journal up front, so every flush queued behind an
 * in-flight upload finds an empty journal and returns without uploading
 * (`core/src/session.ts:644`, `core/src/store/journal.ts:118`). Cost is
 * therefore bounded by roughly one blob per upload round-trip (measured
 * 10–13.5s), not one blob per turn — sampling turns was never what bounded it.
 *
 * Dropping 2 of every 3 turns, by contrast, loses content unconditionally and
 * unrecoverably. Default to keeping it.
 */
export const DEFAULT_CAPTURE_EVERY_N_TURNS = 1;

/** LRU ceiling on tracked sessions — a long-lived server must not grow a
 * per-session record for every session it has ever seen. */
export const MAX_TRACKED_SESSIONS = 64;

interface EventLike {
  type?: string;
  properties?: { sessionID?: string; status?: { type?: string } };
}

/**
 * Return the session id if this event marks the end of an assistant turn,
 * else `undefined`. Both spellings of "idle" are accepted; see the header.
 */
export function turnBoundarySessionID(event: EventLike | undefined): string | undefined {
  if (!event) return undefined;
  if (event.type === 'session.status') {
    return event.properties?.status?.type === 'idle' ? event.properties?.sessionID : undefined;
  }
  if (event.type === 'session.idle') return event.properties?.sessionID;
  return undefined;
}

/** Parse `DMEMO_OPENCODE_CAPTURE_EVERY`; anything unusable falls back to the
 * default rather than throwing — config must never break the host. */
export function parseCaptureEveryNTurns(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CAPTURE_EVERY_N_TURNS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CAPTURE_EVERY_N_TURNS;
  return n;
}

/**
 * Resolve the single owning session for one `experimental.chat.messages.
 * transform` call's `output.messages[]`, or `undefined` if it can't be
 * determined safely.
 *
 * `input` on this hook carries no `sessionID` (`packages/plugin/src/
 * index.ts` in anomalyco/opencode: `(input: {}, output: { messages: ... })`),
 * but every `Message` (`UserMessage | AssistantMessage`) has a non-optional
 * `sessionID`. Verified against the server, not assumed: the hook is
 * triggered from exactly two call sites
 * (`packages/opencode/src/session/prompt.ts` and `.../session/
 * compaction.ts`), and in both, `messages` is built from a single session's
 * transcript scoped by that call's own `sessionID` — `prompt.ts`'s
 * `runLoop(sessionID)` derives `msgs` from
 * `MessageV2.filterCompactedEffect(sessionID)`, and `compaction.ts` derives
 * its `msgs` from `input.messages`/`selected.head` for its own
 * `input.sessionID`. One call is always one session's messages. But this
 * plugin does not get to assume its host is bug-free forever, so it does not
 * trust that structurally: it re-derives the session id from the data
 * itself and refuses to guess if the data ever disagrees.
 *
 * Trust nothing that isn't structurally guaranteed: if any message is
 * missing `sessionID`, or two messages disagree, there is no single safe
 * owner. Returning `undefined` here is what makes the caller DROP the
 * pending context rather than deliver it to a guessed (possibly wrong)
 * session — a missed injection degrades one answer, a misdelivered one
 * leaks another session's memory.
 */
export function transformMessagesSessionID(messages: readonly TransformMessageLike[]): string | undefined {
  if (messages.length === 0) return undefined;
  const first = messages[0]?.info?.sessionID;
  if (!first) return undefined;
  for (const m of messages) {
    if (m.info?.sessionID !== first) return undefined;
  }
  return first;
}

export interface TurnObservation {
  /** False when this boundary resolves to an assistant message already
   * counted — e.g. the `session.status`/`session.idle` pair for one turn. */
  newTurn: boolean;
  /** 1-based index of this session's completed turns. */
  turnIndex: number;
  /** True when `turnIndex` lands on the cadence. */
  shouldCapture: boolean;
}

interface SessionRecord {
  turns: number;
  lastCountedAssistantId?: string;
  lastCapturedAssistantId?: string;
  lastCaptureAtMs: number;
  lastUserText: string;
  /** Memory context queued by `chat.message`, consumed by
   * `experimental.chat.messages.transform` on the SAME session — see the
   * cross-session leak note above `SessionTurnTracker`. */
  pendingContext: string[];
}

/** Structural shape of one `experimental.chat.messages.transform`
 * `output.messages[]` entry — just enough to resolve the owning session,
 * without depending on `@opencode-ai/plugin`'s `Message`/`Part` types here. */
interface TransformMessageLike {
  info?: { sessionID?: string };
}

/**
 * Per-session bookkeeping for the capture path: turn counting, capture
 * dedupe, the compaction cooldown clock, and the last user prompt. All of it
 * used to be global; every field here is per-session because one plugin
 * instance serves the whole server.
 */
export class SessionTurnTracker {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly captureEveryNTurns: number = DEFAULT_CAPTURE_EVERY_N_TURNS,
    private readonly maxSessions: number = MAX_TRACKED_SESSIONS
  ) {}

  /**
   * Record that `assistantMessageId` completed a turn for this session.
   * Idempotent: replaying the same assistant message (the idle event pair,
   * or an idle with no new assistant reply) counts once.
   */
  observeTurn(sessionID: string, assistantMessageId: string): TurnObservation {
    const rec = this.touch(sessionID);
    if (rec.lastCountedAssistantId === assistantMessageId) {
      return { newTurn: false, turnIndex: rec.turns, shouldCapture: false };
    }
    rec.lastCountedAssistantId = assistantMessageId;
    rec.turns += 1;
    return {
      newTurn: true,
      turnIndex: rec.turns,
      shouldCapture: rec.turns % this.captureEveryNTurns === 0,
    };
  }

  /**
   * Claim `assistantMessageId` for capture. Returns false if some other path
   * (cadence, compaction-proactive, pre-compaction) already captured it, so
   * the three cannot double-add the same turn.
   */
  claimCapture(sessionID: string, assistantMessageId: string): boolean {
    const rec = this.touch(sessionID);
    if (rec.lastCapturedAssistantId === assistantMessageId) return false;
    rec.lastCapturedAssistantId = assistantMessageId;
    return true;
  }

  lastCaptureAtMs(sessionID: string): number {
    return this.touch(sessionID).lastCaptureAtMs;
  }

  noteCaptureAt(sessionID: string, atMs: number): void {
    this.touch(sessionID).lastCaptureAtMs = atMs;
  }

  noteUserText(sessionID: string, text: string): void {
    this.touch(sessionID).lastUserText = text;
  }

  userText(sessionID: string): string {
    return this.touch(sessionID).lastUserText;
  }

  /** Clear this session's queued memory context. Called at the start of a
   * new `chat.message` turn, mirroring the old global `pendingContext = []`
   * reset — but scoped to one session instead of every session on the
   * server. */
  resetPendingContext(sessionID: string): void {
    this.touch(sessionID).pendingContext = [];
  }

  /** Queue a memory-context block for this session, to be injected into
   * this session's next `experimental.chat.messages.transform` call. */
  pushPendingContext(sessionID: string, text: string): void {
    this.touch(sessionID).pendingContext.push(text);
  }

  /** Drain and return this session's queued memory context, clearing it so
   * a second `transform` call for the same turn (e.g. the compaction path's
   * own `experimental.chat.messages.transform` trigger) can't re-inject it. */
  takePendingContext(sessionID: string): string[] {
    const rec = this.touch(sessionID);
    const ctx = rec.pendingContext;
    rec.pendingContext = [];
    return ctx;
  }

  /** Test/observability seam. */
  get trackedSessions(): number {
    return this.sessions.size;
  }

  /** Fetch-or-create, moving the record to the LRU tail and evicting the
   * coldest session once the ceiling is exceeded. */
  private touch(sessionID: string): SessionRecord {
    const existing = this.sessions.get(sessionID);
    if (existing) {
      this.sessions.delete(sessionID);
      this.sessions.set(sessionID, existing);
      return existing;
    }
    const created: SessionRecord = { turns: 0, lastCaptureAtMs: 0, lastUserText: '', pendingContext: [] };
    this.sessions.set(sessionID, created);
    if (this.sessions.size > this.maxSessions) {
      const coldest = this.sessions.keys().next();
      if (!coldest.done) this.sessions.delete(coldest.value);
    }
    return created;
  }
}
