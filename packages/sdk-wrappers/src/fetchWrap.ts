// T2.2 — primary write-back mechanism: a custom `fetch` passed as the
// client's `fetch` option (native extension point, both SDKs — see
// `research/sdks.md` §2, "Decision for dMemo"). Works for the OpenAI SDK,
// the Anthropic SDK, and any other OpenAI/Anthropic-compatible client that
// accepts a `fetch` override (e.g. pointed at the 0G Router).
//
// Flow per TASKS.md T2.2:
//   1. before the real fetch: `session.memory.search(query)` -> inject into
//      `init.body` (messages/system).
//   2. call the real fetch.
//   3. after: non-stream -> read the awaited JSON return value directly;
//      stream -> `response.clone()` a branch to accumulate the final text
//      while handing the *original* response back to the SDK untouched.
//   4. `session.memory.add(...)` the exchange + `session.flush()`
//      (fire-and-forget, D4 — never awaited here).
//
// No SDK subclassing, no monkey-patching (`sdks.md` §5) — this is a plain
// function conforming to the `Fetch` type both SDKs already accept.

import {
  extractOpenAIQuery,
  injectOpenAIMemory,
  extractOpenAICompletionText,
  extractAnthropicQuery,
  injectAnthropicMemory,
  extractAnthropicCompletionText,
  type OpenAIChatBody,
  type AnthropicBody,
} from './inject.js';
import { accumulateOpenAIStream, accumulateAnthropicStream } from './sse.js';
import type { MemoryWrapOptions } from './memorySession.js';
import { resolveFailOpen, resolveOnError, searchMemoryBlock, writeBackMemory } from './memoryOps.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Dialect {
  name: 'openai' | 'anthropic';
  extractQuery(body: any): string | undefined;
  inject(body: any, memoryBlock: string): any;
  extractCompletionText(json: unknown): string | undefined;
  accumulateStream(body: ReadableStream<Uint8Array>): Promise<string>;
}

const openaiDialect: Dialect = {
  name: 'openai',
  extractQuery: (body: OpenAIChatBody) => extractOpenAIQuery(body),
  inject: (body: OpenAIChatBody, block: string) => injectOpenAIMemory(body, block),
  extractCompletionText: extractOpenAICompletionText,
  accumulateStream: accumulateOpenAIStream,
};

const anthropicDialect: Dialect = {
  name: 'anthropic',
  extractQuery: (body: AnthropicBody) => extractAnthropicQuery(body),
  inject: (body: AnthropicBody, block: string) => injectAnthropicMemory(body, block),
  extractCompletionText: extractAnthropicCompletionText,
  accumulateStream: accumulateAnthropicStream,
};

function buildDialectFetch(dialect: Dialect, baseFetch: FetchLike, opts: MemoryWrapOptions): FetchLike {
  const failOpen = resolveFailOpen(opts);
  const onError = resolveOnError(opts);

  return async (input: string | URL | Request, init?: RequestInit) => {
    const session = opts.session;

    // D11 / fail-open: no session at all -> pure passthrough, zero overhead.
    if (!session) return baseFetch(input, init);

    let body: any = undefined;
    let userText: string | undefined;
    let finalInit = init;

    try {
      if (init?.body && typeof init.body === 'string') {
        body = JSON.parse(init.body);
        userText = dialect.extractQuery(body);
        if (userText) {
          const memoryBlock = await searchMemoryBlock(session, userText, opts);
          const injected = dialect.inject(body, memoryBlock);
          finalInit = { ...init, body: JSON.stringify(injected) };
        }
      }
    } catch (error) {
      if (!failOpen) throw error;
      onError('search', error);
      finalInit = init; // fall back to the unmodified request
    }

    const response = await baseFetch(input, finalInit);

    if (!response.ok || !body) return response;

    try {
      if (body.stream && response.body) {
        // Clone so the SDK's own consumption of `response` is untouched;
        // drain the clone in the background to accumulate write-back text.
        const clone = response.clone();
        dialect
          .accumulateStream(clone.body as ReadableStream<Uint8Array>)
          .then((text) => writeBackMemory(session, opts, onError, userText, text))
          .catch((error) => onError('parse', error));
      } else {
        response
          .clone()
          .json()
          .then((json) => {
            const text = dialect.extractCompletionText(json);
            writeBackMemory(session, opts, onError, userText, text);
          })
          .catch((error) => onError('parse', error));
      }
    } catch (error) {
      if (!failOpen) throw error;
      onError('writeback', error);
    }

    return response;
  };
}

/** Build a memory-injecting `fetch` for an OpenAI (or OpenAI-compatible,
 * e.g. 0G Router) `chat/completions` client. Pass as the client's `fetch`
 * option: `new OpenAI({ fetch: createOpenAIMemoryFetch({ session, userId }) })`. */
export function createOpenAIMemoryFetch(opts: MemoryWrapOptions = {}, baseFetch: FetchLike = fetch): FetchLike {
  return buildDialectFetch(openaiDialect, baseFetch, opts);
}

/** Build a memory-injecting `fetch` for an Anthropic (or Anthropic-shaped,
 * e.g. 0G Router `/v1/messages`) `messages` client. Prefer the `middleware`
 * path (`anthropicMiddleware.ts`) for Anthropic traffic when the installed
 * SDK version exports it — this exists for parity / non-Anthropic-SDK
 * consumers of the Anthropic-shaped route. */
export function createAnthropicMemoryFetch(opts: MemoryWrapOptions = {}, baseFetch: FetchLike = fetch): FetchLike {
  return buildDialectFetch(anthropicDialect, baseFetch, opts);
}
