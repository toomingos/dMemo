// T2.2 — secondary write-back mechanism: native Anthropic SDK `middleware`
// (exported since v0.101.0 — installed here is 0.115.0, checked against
// `node_modules/@anthropic-ai/sdk/core/middleware.d.ts`). Runs inside the
// SDK's retry loop, before request signing, so injected memory survives
// retries automatically, and `ctx.parse(response)` gives an independent
// stream/JSON copy for write-back with no manual `response.clone()`
// bookkeeping (`research/sdks.md` §1b/§3/§5). Use this for any traffic going
// through `@anthropic-ai/sdk` directly — including Claude-on-0G, since the
// Router's `/v1/messages` route is a genuine Anthropic Messages
// implementation (D10) and backend adaptation runs inside `next()`, so
// middleware behaves identically regardless of backend.
//
// No SDK subclassing, no monkey-patching — `middleware` is a first-class,
// documented, exported client option (`sdks.md` §5).

import type { Middleware } from '@anthropic-ai/sdk';
import {
  extractAnthropicQuery,
  injectAnthropicMemory,
  extractAnthropicCompletionText,
  type AnthropicBody,
} from './inject.js';
import { accumulateAnthropicEvents } from './sse.js';
import type { MemoryWrapOptions } from './memorySession.js';
import { resolveFailOpen, resolveOnError, searchMemoryBlock, writeBackMemory } from './memoryOps.js';

/** Build an Anthropic `middleware` entry that injects dMemo memory into the
 * outgoing request and write-backs the exchange once the response resolves.
 * Pass in the client's `middleware` array:
 * `new Anthropic({ middleware: [createAnthropicMemoryMiddleware({ session, userId })] })`.
 *
 * D11 / fail-open: with no `session` (or a search/parse error, when
 * `failOpen` — the default — is true), this degrades to a pure passthrough:
 * `next(request)` unmodified, no write-back attempted. */
export function createAnthropicMemoryMiddleware(opts: MemoryWrapOptions = {}): Middleware {
  const failOpen = resolveFailOpen(opts);
  const onError = resolveOnError(opts);

  return async (request, next, ctx) => {
    const session = opts.session;
    if (!session) return next(request);

    let userText: string | undefined;
    let isStream = false;

    try {
      if (typeof request.body === 'string') {
        const body = JSON.parse(request.body) as AnthropicBody;
        isStream = Boolean(body.stream);
        userText = extractAnthropicQuery(body);
        if (userText) {
          const memoryBlock = await searchMemoryBlock(session, userText, opts);
          const injected = injectAnthropicMemory(body, memoryBlock);
          request.body = JSON.stringify(injected);
        }
      }
    } catch (error) {
      if (!failOpen) throw error;
      onError('search', error);
    }

    const response = await next(request);

    try {
      if (isStream) {
        // `ctx.parse` on a streaming request resolves immediately with an
        // independent `Stream` reading a copy of the body — iterating it
        // does not consume the caller's events (core/middleware.d.ts).
        ctx
          .parse<AsyncIterable<unknown>>(response)
          .then(async (events) => {
            const text = await accumulateAnthropicEvents(events);
            writeBackMemory(session, opts, onError, userText, text);
          })
          .catch((error) => onError('parse', error));
      } else {
        ctx
          .parse(response)
          .then((json) => {
            const text = extractAnthropicCompletionText(json);
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
