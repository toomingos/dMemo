// Minimal SSE line parser for the fetch-level write-back path (`fetchWrap.ts`).
//
// This is deliberately *not* a reimplementation of either SDK's `Stream`
// class — at the `fetch` level we only have a raw `Response`, before the SDK
// wraps its body into a `Stream<Event>`. The research doc
// (`research/sdks.md` §1c/§3) recommends `response.clone()` at this layer
// (rather than `Stream.tee()`, which operates on the SDK's already-parsed
// `Stream` object) — we clone the response, hand the original untouched body
// to the caller, and drain the clone here to accumulate the final text for
// write-back.

/** Parse an SSE byte stream into `data: <payload>` JSON payloads, skipping
 * the `[DONE]` sentinel OpenAI sends. Malformed lines are skipped, never
 * thrown (fail-open — this runs on the write-back side branch and must never
 * affect the caller's own stream). */
export async function* parseSSEJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Skip malformed chunk — best-effort accumulation.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Accumulate already-parsed OpenAI chunk-shaped events (concatenated
 * `choices[0].delta.content`). Shared by the raw-bytes path (`fetchWrap.ts`,
 * fed via `parseSSEJson`) — the Anthropic `middleware` path has no OpenAI
 * equivalent since `ctx.parse` is Anthropic-SDK-only. */
export async function accumulateOpenAIEvents(events: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const event of events) {
    const delta = (event as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]
      ?.delta?.content;
    if (typeof delta === 'string') text += delta;
  }
  return text;
}

/** Accumulate already-parsed Anthropic stream events (concatenated
 * `content_block_delta` `text_delta` events) into the final assistant text.
 * Shared by both write-back paths: `fetchWrap.ts` feeds it raw-bytes-parsed
 * events via `parseSSEJson`; `anthropicMiddleware.ts` feeds it the
 * already-parsed events `ctx.parse()` yields directly (no raw bytes
 * involved there at all). */
export async function accumulateAnthropicEvents(events: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const event of events) {
    const e = event as { type?: string; delta?: { type?: string; text?: string } };
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
      text += e.delta.text;
    }
  }
  return text;
}

/** Accumulate an OpenAI `chat.completions` raw SSE byte stream (fetch-level
 * write-back path). */
export function accumulateOpenAIStream(body: ReadableStream<Uint8Array>): Promise<string> {
  return accumulateOpenAIEvents(parseSSEJson(body));
}

/** Accumulate an Anthropic `messages` raw SSE byte stream (fetch-level
 * write-back path). */
export function accumulateAnthropicStream(body: ReadableStream<Uint8Array>): Promise<string> {
  return accumulateAnthropicEvents(parseSSEJson(body));
}
