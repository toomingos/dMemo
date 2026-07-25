// Small, dependency-free helpers shared by the before_prompt_build recall
// path and the agent_end capture path. No mem0/@dmemo/core types leak in
// here — everything below deals with plain OpenClaw event shapes only.

export interface MemoryResultItem {
  id?: string;
  memory?: string;
  text?: string;
  score?: number;
  [key: string]: unknown;
}

/** Render a search-result list into a compact block for `prependContext`. */
export function renderMemoryBlock(results: MemoryResultItem[] | undefined): string {
  if (!results || results.length === 0) return "";
  const lines = results
    .map((r) => r.memory ?? r.text)
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .map((line) => `- ${line}`);
  if (lines.length === 0) return "";
  return `Relevant memories from prior sessions:\n${lines.join("\n")}`;
}

/** A loose shape covering both plain-string and content-part message forms
 * OpenClaw's `AgentMessage` may take on the plugin surface (typed `unknown[]`
 * in `PluginHookAgentEndEvent.messages` — src/plugins/hook-types.ts:393). */
interface LooseMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

function messageText(msg: LooseMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  return "";
}

/** Extract `{role, content}` turns suitable for `session.memory.add()` from
 * an `agent_end` event's raw message list. Keeps only user/assistant turns
 * with non-empty text. */
export function extractTurns(messages: unknown[] | undefined): Array<{ role: string; content: string }> {
  if (!Array.isArray(messages)) return [];
  const turns: Array<{ role: string; content: string }> = [];
  for (const raw of messages) {
    const msg = raw as LooseMessage;
    if (msg?.role !== "user" && msg?.role !== "assistant") continue;
    const text = messageText(msg).trim();
    if (!text) continue;
    turns.push({ role: msg.role, content: text });
  }
  return turns;
}

/** Guard against firing a search on empty/near-empty/system-bootstrap prompts. */
export function sanitizeQuery(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const trimmed = prompt.trim();
  if (trimmed.length < 5) return undefined;
  return trimmed;
}

// ============================================================================
// E1 — `agent_end` resends the FULL cumulative session transcript on every
// turn (openclaw 2026.7.1-2 has no delta/message-count field on this hook —
// confirmed against the real installed host source, not just the ambient
// `.d.ts`: `PluginHookAgentEndEvent` in `dist/hook-types-DQ9eTy2x.js` matches
// this repo's `openclaw-plugin-sdk.d.ts` field-for-field, and every firing
// site traced in `dist/run-attempt-CXZNKJ6y.js` / `dist/selection-
// JInn13lc.js` passes a full `messages.slice()`/`messagesSnapshot`, never a
// delta). Without slicing, `extractTurns` re-extracts every prior turn each
// time, so `index.ts`'s `capture()` persists how many messages it has
// already seen per session (see its `readCaptureState`/`updateCaptureState`)
// and slices the raw array down to just the tail before calling
// `extractTurns`.
// ============================================================================

/** Return only the messages appended since `previousCount`, given OpenClaw's
 * cumulative `agent_end` snapshot. `previousCount` is untrusted state read
 * back from disk: if it is missing, non-finite, negative, or larger than the
 * current snapshot (state was reset, or the array shrank for any reason),
 * fall back to the FULL array rather than silently dropping messages —
 * losing dedup for one turn is a far smaller failure than losing content. */
export function newMessagesSince(
  messages: unknown[] | undefined,
  previousCount: number | undefined,
): unknown[] {
  if (!Array.isArray(messages)) return [];
  if (
    previousCount === undefined ||
    !Number.isFinite(previousCount) ||
    previousCount < 0 ||
    previousCount > messages.length
  ) {
    return messages;
  }
  return messages.slice(previousCount);
}

// ============================================================================
// E5 — the host stamps a timestamp envelope onto the user's prompt BEFORE
// this plugin's `before_prompt_build` ever sees it (default ON via
// `agents.defaults.envelopeTimestamp`), and that stamped text is what later
// shows up verbatim in `agent_end`'s `messages[]`. Format and detection
// mirrored from the real installed host source (openclaw 2026.7.1-2):
//   - Shape `[<Mon> YYYY-MM-DD HH:MM[:SS] <TZ>] ` — weekday via
//     `Intl.DateTimeFormat({weekday:"short"})`, time via `hourCycle:"h23"`,
//     zone via `timeZoneName:"short"` (`dist/format-datetime-DO2rqkXr.js`,
//     `buildTimestampPrefix()` in `dist/selection-JInn13lc.js` ~L8031-8039).
//   - The host's OWN detector, `TIMESTAMP_ENVELOPE_PATTERN =
//     /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/` (same file), confirms this is the
//     canonical shape rather than a guess — matches every prefix observed in
//     `packages/integration-tests/results/openclaw-e2e-observations.jsonl`
//     (e.g. `[Sat 2026-07-25 20:21 GMT+1] `).
// The pattern below is deliberately NARROWER than the host's own detector
// (which only needs to confirm presence): it requires the exact
// weekday+date+time shape through a closing bracket, so it can never eat
// real user text that merely happens to start with a bracket.
// ============================================================================
const TIMESTAMP_PREFIX_PATTERN =
  /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?[^\]\n]*\]\s?/;

export function stripTimestampPrefix(text: string): string {
  return text.replace(TIMESTAMP_PREFIX_PATTERN, "");
}

// ============================================================================
// E2 — `before_prompt_build`'s `prependContext` gets baked into the user's
// own prompt text by the host as `${prependContext}\n\n${prompt}` (confirmed
// against `dist/selection-JInn13lc.js` ~L13674-13676), and that joined text
// is what `agent_end` later reports as the user message's content. Left
// alone, dMemo's own recall block gets captured back into memory as though
// the user typed it, compounding every turn. `index.ts` remembers the exact
// block it injected for a session (`lastInjectedContext`, cleared by
// `before_prompt_build` -> consumed once by the next `capture()`) and passes
// it in here so it can be stripped back off before storage.
// ============================================================================

/** Undo what the host does to a user prompt before this plugin ever sees it
 * on the capture path: the recall block it injected (E2, when
 * `injectedContext` is given) and the timestamp envelope (E5). Both are
 * plain string-prefix removal, no heuristics. Order matters — the recall
 * block is the OUTER wrapper (stripped first); the timestamp is baked into
 * the original prompt underneath it. */
export function sanitizeCapturedText(text: string, injectedContext: string | undefined): string {
  let out = text;
  if (injectedContext) {
    const prefix = `${injectedContext}\n\n`;
    if (out.startsWith(prefix)) out = out.slice(prefix.length);
  }
  return stripTimestampPrefix(out);
}

/** Apply `sanitizeCapturedText` to user-role turns only — the host only ever
 * stamps/prepends onto the user's own prompt, never the assistant's reply
 * (confirmed against the host source cited above), so assistant turns are
 * left untouched. Turns that strip down to nothing (e.g. a user message that
 * was purely a re-issued recall block with no other text) are dropped. */
export function sanitizeTurns(
  turns: Array<{ role: string; content: string }>,
  injectedContext: string | undefined,
): Array<{ role: string; content: string }> {
  return turns
    .map((t) =>
      t.role === "user" ? { ...t, content: sanitizeCapturedText(t.content, injectedContext).trim() } : t,
    )
    .filter((t) => t.content.length > 0);
}
