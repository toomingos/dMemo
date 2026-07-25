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
