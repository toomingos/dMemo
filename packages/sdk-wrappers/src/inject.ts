// Shared request/response shape helpers for both the OpenAI-style
// (`chat/completions`) and Anthropic-style (`messages`) request bodies the
// Router (and Anthropic/OpenAI's own APIs) speak. Pure functions — no I/O —
// so they're trivially unit-testable without a mock server.

import type { MemorySearchResult } from './memorySession.js';

export const DEFAULT_TOP_K = 5;

export function renderMemoryBlock(results: readonly MemorySearchResult[]): string {
  if (results.length === 0) return '';
  const lines = results.map((r) => `- ${r.memory}`).join('\n');
  return `Relevant memory from prior sessions (dMemo):\n${lines}`;
}

/** OpenAI chat-completions style message. */
export interface OpenAIChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface OpenAIChatBody {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
      .join(' ');
  }
  return '';
}

/** Best-effort search query: the last user message's text. */
export function extractOpenAIQuery(body: OpenAIChatBody): string | undefined {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messageText(messages[i]?.content);
  }
  return undefined;
}

/** Inject a memory block as (or into) the leading system message. Mutates
 * and returns a shallow-cloned body so the caller's original object is
 * untouched. */
export function injectOpenAIMemory(body: OpenAIChatBody, memoryBlock: string): OpenAIChatBody {
  if (!memoryBlock) return body;
  const messages = [...(body.messages ?? [])];
  const firstIdx = messages.findIndex((m) => m.role === 'system');
  if (firstIdx === -1) {
    messages.unshift({ role: 'system', content: memoryBlock });
  } else {
    const existing = messages[firstIdx] as OpenAIChatMessage;
    messages[firstIdx] = {
      ...existing,
      content: `${messageText(existing.content)}\n\n${memoryBlock}`.trim(),
    };
  }
  return { ...body, messages };
}

/** Extract the final assistant text from a non-stream OpenAI chat-completion
 * response body. */
export function extractOpenAICompletionText(json: unknown): string | undefined {
  const choices = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic messages shape
// ---------------------------------------------------------------------------

export interface AnthropicMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface AnthropicBody {
  model?: string;
  system?: unknown;
  messages?: AnthropicMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export function extractAnthropicQuery(body: AnthropicBody): string | undefined {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messageText(messages[i]?.content);
  }
  return undefined;
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((part) => (part as { text?: string })?.text ?? '').join(' ');
  }
  return '';
}

/** Anthropic's `system` is a top-level string (or content-block array), not
 * a message — inject there. Mutates and returns a shallow clone. */
export function injectAnthropicMemory(body: AnthropicBody, memoryBlock: string): AnthropicBody {
  if (!memoryBlock) return body;
  const existing = systemText(body.system);
  const merged = existing ? `${existing}\n\n${memoryBlock}` : memoryBlock;
  return { ...body, system: merged };
}

export function extractAnthropicCompletionText(json: unknown): string | undefined {
  const content = (json as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  return text || undefined;
}
