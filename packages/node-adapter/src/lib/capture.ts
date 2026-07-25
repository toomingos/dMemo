// Shared write-back path for `Stop` and `PreCompact` (T3.1: "PreCompact:
// capture-before-compaction (same capture path)"). Reads the new turn out
// of the hook's stdin payload (`last_assistant_message`, optionally
// `prompt`, falling back to the tail of `transcript_path`), `add()`s it
// verbatim (infer=false by default, D17) and lets the caller's
// `withSession` close() perform the flush (D4/D3). Fails open: never
// throws, silently no-ops when there's nothing worth capturing.

import fs from 'node:fs';
import { withSession, isSubagentInvocation } from './dmemo.js';
import { debugLog } from './settings.js';

function coerceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : coerceText((v as Record<string, unknown>)?.text ?? v)))
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (obj.content !== undefined) return coerceText(obj.content);
  }
  return '';
}

/** Best-effort: walk the transcript JSONL backwards for the most recent
 * `role: "user"` entry. Transcript formats vary across hosts/versions, so
 * every failure mode here (missing file, bad JSON, unknown shape) just
 * yields an empty string rather than throwing. */
function readLastUserMessage(transcriptPath: string): string {
  if (!transcriptPath) return '';
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = (entry.message as Record<string, unknown>) ?? entry;
      const role = message.role ?? entry.type;
      if (role === 'user') {
        return coerceText(message.content ?? entry.content ?? entry.text);
      }
    }
  } catch {
    // No transcript, or unreadable — not fatal.
  }
  return '';
}

export async function captureTurn(input: Record<string, unknown>, sourceHook: string): Promise<void> {
  if (isSubagentInvocation(input)) return;

  const assistantText = coerceText(input.last_assistant_message);
  if (!assistantText.trim()) {
    debugLog(`${sourceHook}: no last_assistant_message, skipping capture`);
    return;
  }

  const userText =
    typeof input.prompt === 'string' && input.prompt.trim()
      ? input.prompt
      : readLastUserMessage(typeof input.transcript_path === 'string' ? input.transcript_path : '');

  const turnText = userText ? `User: ${userText}\n\nAssistant: ${assistantText}` : `Assistant: ${assistantText}`;

  await withSession(async ({ session, scope }) => {
    await session.memory.add(turnText, { userId: scope, infer: false });
    // Fire-and-forget per D4; withSession's close() awaits this flush chain
    // to completion before the process is allowed to exit (still well
    // inside the Stop/PreCompact hook timeout budget, per T0.1 numbers).
    session.flush();
  });
}
