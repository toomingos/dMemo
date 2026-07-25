# OpenAI SDK & Anthropic SDK — Native Extension Points for dMemo

Research date: 2026-07-24. Sources: cloned `openai/openai-node` (v6.49.0) and
`anthropics/anthropic-sdk-typescript` (v0.115.0) at
`/private/tmp/claude-501/.../scratchpad/repos/`, official docs
(platform.claude.com, platform.openai.com/developers.openai.com), and 0G docs
(docs.0g.ai, pc.0g.ai).

## TL;DR

| Capability | OpenAI Node SDK | Anthropic TS SDK |
|---|---|---|
| Inject memory into request | custom `fetch` (global or client option) or `fetchOptions` (headers/body only via full fetch override) | Same, **plus** a native `middleware` array — request-level intercept without touching `fetch` |
| Intercept completion output (non-stream) | `.asResponse()` / `.withResponse()` on `APIPromise`, or just read the awaited return value | Same (`APIPromise.asResponse/withResponse`), **plus** middleware's `ctx.parse(response)` |
| Intercept streamed output non-destructively | `Stream.tee()` (native, both SDKs) | `Stream.tee()`, **plus** middleware auto-clones via `ctx.parse` |
| Event-based "final answer" hook | `AbstractChatCompletionRunnerEvents.finalChatCompletion` / `finalContent` (via `client.chat.completions.stream()`) | `MessageStreamEvents.finalMessage` (via `client.messages.stream()`) |
| `baseURL` override | Yes, constructor option | Yes, constructor option |
| Default/custom headers | `defaultHeaders`, per-request `headers` | Same |
| 0G Compute (`pc.0g.ai` / `router-api.0g.ai`) compatibility | **Confirmed** — documented drop-in (`baseURL` + `apiKey`) | **Confirmed** — router exposes a genuine Anthropic-compatible `/v1/messages` route (D10, `followup-0g-endpoints.md`) |

The single biggest asymmetry: **Anthropic's SDK has a first-class, exported `middleware` system** (added v0.101.0, 2026-06-05) that is purpose-built for exactly what dMemo needs — observe/mutate the request, observe the response (streaming or not) without consuming it for the caller. **OpenAI's SDK has no equivalent**; the only native mechanism is `fetch` override, which requires you to manually replicate what Anthropic's middleware gives for free (response cloning to keep the body readable for both dMemo and the caller).

---

## 1. High-level flow

### 1a. Memory injection (both SDKs, custom `fetch` path — the portable option)

```
Agent code                dMemo (custom fetch)              0G Storage / Compute
    │                             │                                  │
    │ client.chat.completions     │                                  │
    │ .create({...})  ───────────►│                                  │
    │                             │ 1. fetch encrypted memory blob    │
    │                             │    from 0G Storage, decrypt       │
    │                             │    locally                        │
    │                             │ 2. mutate `init.body` (inject     │
    │                             │    memory into messages/system)   │
    │                             │ 3. call real fetch(url, init) ───►│ POST /v1/chat/completions
    │                             │                                  │  (pc.0g.ai / router-api.0g.ai)
    │◄─────────── response ───────┤◄─────────────────────────────────┤
```

### 1b. Memory injection — Anthropic-only middleware path (preferred when talking to Anthropic directly)

```
Agent code          Anthropic SDK core          dMemo Middleware           network
    │ client.messages    │                            │                       │
    │ .create({...}) ───►│ per-attempt, per-retry ───►│ (request, next, ctx)  │
    │                     │                            │  - mutate request     │
    │                     │                            │    (inject memory)    │
    │                     │                            │  - await next(req) ──►│
    │                     │◄───────────────────────────┤◄── response ──────────┤
    │◄─── parsed result ──┤                            │                       │
```
Anthropic runs middleware **inside the retry loop, before request signing**, so injected content survives retries automatically.
Ref: `anthropic-sdk-typescript/src/client.ts:1321-1327`, CHANGELOG `client: run middleware before request signing (#45)`.

### 1c. Write-back capture (streaming) — the `tee()` pattern (both SDKs, native)

```
                 ┌────────────► branch A → caller / agent loop (unaffected)
Stream<Event> ───┤ .tee()
                 └────────────► branch B → dMemo accumulator → on stream end,
                                            build mutation → write to 0G Storage
```
`Stream.tee()` is defined identically in both codebases (`openai-node/src/core/streaming.ts:220`, `anthropic-sdk-typescript/src/core/streaming.ts:220`) — "Splits the stream into two streams which can be independently read from at different speeds." This is the correct native primitive for a transparent write-back hook: dMemo can wrap the returned `Stream` from `create({stream:true})`, tee it, hand one branch back to the caller unchanged, and drain the other branch internally to accumulate the final message/completion before persisting the mutation.

---

## 2. Injecting memory into requests

| Mechanism | OpenAI | Anthropic | Notes |
|---|---|---|---|
| `baseURL` client option | `openai-node/src/client.ts:292,385,407,452` | `anthropic-sdk-typescript/src/client.ts:375,492,521` | Both read `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` env vars as fallback |
| `defaultHeaders` / per-request `headers` | `openai-node/src/client.ts:332` | `anthropic-sdk-typescript/src/client.ts:426` | Good for static auth headers (0G API key), not per-request dynamic memory payloads |
| `fetch` client option (full override) | `openai-node/src/client.ts:312-316`, assigned `483` | `anthropic-sdk-typescript/src/client.ts:394-398`, assigned `570` | Works identically in both — a function replacing `fetch` globally or per-client. This is the SDK-agnostic injection point: inspect/rewrite `init.body` before the real network call. Confirmed via context7 doc snippet (`tests/lib/helper-client.test.ts`) showing a custom `fetch` used to intercept `messages.create()` calls and read headers. |
| `fetchOptions` (merged `RequestInit`, e.g. proxy `dispatcher`) | `openai-node/src/client.ts:306-309` | `anthropic-sdk-typescript/src/client.ts:388-391` | Only for static `RequestInit` fields (dispatcher, credentials, etc.) — cannot see/mutate the per-call body |
| **`middleware` array** (Anthropic only) | — not present anywhere in `openai-node/src` (`grep -rn middleware openai-node/src` → zero hits) | `anthropic-sdk-typescript/src/client.ts:401-410` (option), `src/core/middleware.ts` (implementation), exported from `src/index.ts:7-13` | `Middleware = (request, next, ctx) => Promise<Response>` — can mutate the request, short-circuit, retry, or replace the response. Runs **inside** the retry loop and **before** request signing for third-party backends (Bedrock/Vertex/Foundry adapters run inside `next()`), so it behaves identically across backends. |

**Decision for dMemo:** build the injection layer as a `fetch` wrapper (works for both SDKs uniformly, and for any other OpenAI-compatible client a user might already have). Layer an *optional* Anthropic `middleware` adapter on top for users on `@anthropic-ai/sdk` directly (non-0G, e.g. talking to Anthropic's own API through 0G Compute's private-inference wrapper) since it gives retry-safe injection and built-in response-body access (`ctx.parse`) for free — no manual `response.clone()` bookkeeping.

---

## 3. Capturing completion output → write-back trigger

### Non-streaming
Both SDKs return `APIPromise<T>` from every method. It exposes:
- `.asResponse()` — raw `Response`, body **not consumed**, resolves as soon as headers arrive (`openai-node/src/core/api-promise.ts:55`, `anthropic-sdk-typescript` equivalent per context7 snippet from `src/core/api-promise.ts`).
- `.withResponse()` — `{ data, response, request_id }`, consumes and parses the body once (`openai-node/src/core/api-promise.ts:71-73`).

Simplest native hook: just `await` the call normally in a thin wrapper and pass the parsed object to the write-back mutation — no special API needed since these are plain promises. `.withResponse()` is only useful if dMemo also wants response headers (rate-limit info, request-id) for telemetry.

### Streaming
| Mechanism | OpenAI | Anthropic |
|---|---|---|
| Raw async-iterable (`create({stream:true})`) | `Stream<ChatCompletionChunk>` (`openai-node/src/resources/chat/completions/completions.ts:72`) | `Stream<RawMessageStreamEvent>` (`anthropic-sdk-typescript/src/resources/messages/messages.ts:62`) |
| Native split | `Stream.tee()` (`openai-node/src/core/streaming.ts:220`) | `Stream.tee()` (`anthropic-sdk-typescript/src/core/streaming.ts:220`) |
| High-level accumulating helper w/ events | `client.chat.completions.stream()` → `ChatCompletionStream` (`openai-node/src/lib/ChatCompletionStream.ts`), events incl. `content`, `chunk`, and (inherited from `AbstractChatCompletionRunnerEvents`, `openai-node/src/lib/AbstractChatCompletionRunner.ts:514-524`) `finalContent`, `finalMessage`, `finalChatCompletion`, `totalUsage` | `client.messages.stream()` → `MessageStream` (`anthropic-sdk-typescript/src/lib/MessageStream.ts`), events `text`, `contentBlock`, `message`, **`finalMessage`**, `end` (`src/lib/MessageStream.ts:23-36`) |
| Doc-confirmed usage | — (see OpenAI streaming helpers, `helpers.md`) | ```anthropic.messages.stream({...}).on("text", cb)``` then `await stream.finalMessage()` — from platform.claude.com/docs/en/api/sdks/typescript §"Streaming helpers" |

**Decision for dMemo:** the `finalChatCompletion` (OpenAI) / `finalMessage` (Anthropic) events are the cleanest native write-back trigger *if* dMemo owns the call site (e.g., dMemo's own thin client wraps `.stream()` and re-exposes it). If dMemo must stay non-invasive to an existing `create({stream:true})` call, use `Stream.tee()`: return one branch to the caller untouched, drain the other internally, and fire the mutation write when the internal consumer completes (`content_block_stop`/`message_stop` for Anthropic, `[DONE]`/final chunk for OpenAI). This avoids re-implementing the SDKs' own SSE accumulation logic.

For Anthropic middleware users specifically, `ctx.parse(response)` already returns an independent `Stream` "reading an independent copy of the response body — iterating it doesn't consume the client's events" (`anthropic-sdk-typescript/src/core/middleware.ts:58-64`), so no manual `tee()`/`clone()` is needed inside middleware — this is strictly less plumbing than the `fetch`-based approach.

---

## 4. 0G Compute endpoint compatibility (verified)

| Item | Finding | Source |
|---|---|---|
| Endpoint | `https://router-api.0g.ai/v1` (mainnet), `https://router-api-testnet.integratenetwork.work/v1` (testnet) | docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview |
| Auth | API key as standard HTTP header, "OpenAI convention" (i.e. `Authorization: Bearer <key>`) | same |
| SDK compatibility claim | Explicit: *"Any OpenAI client library — openai-python, openai-node, LangChain, LlamaIndex, Vercel AI SDK, etc. — works by changing `base_url` to `https://router-api.0g.ai/v1`"* | docs.0g.ai router FAQ |
| Surface | `/v1/chat/completions` with streaming, tool calling, reasoning tokens — OpenAI shape only | same |
| Claude models on 0G | Available (Claude Fable 5, Claude Opus 4.8, Claude Sonnet 5 listed at pc.0g.ai/models) **but served through the same OpenAI-compatible surface** | pc.0g.ai/models |
| Anthropic `/v1/messages` support on 0G | **Confirmed** — genuine Anthropic Messages-compatible route (own request/response schema, Anthropic-dialect reasoning translation, Anthropic-shaped SSE streaming and rate-limit headers), verified against the router's OpenAPI spec, Go source, and live probes (D10) | `followup-0g-endpoints.md` |

**Implication for the dMemo architecture assumption** ("Anthropic SDK for Claude" against 0G Compute): **resolved (D10)** — the router exposes a genuine Anthropic-compatible `/v1/messages` route, verified in `followup-0g-endpoints.md` (router OpenAPI spec, Go source, and live probes). Practically this means:
- Calling Claude models *through 0G* can use **`@anthropic-ai/sdk`** directly, pointed at the router (`baseURL: 'https://router-api.0g.ai/v1'`, `apiKey`/`ANTHROPIC_AUTH_TOKEN: sk-...`) — the Anthropic-shaped route is real, not an alias. The **OpenAI SDK** path (`baseURL` + `apiKey`) remains available and covers the rest of 0G's model list (non-Claude models are OpenAI-format-only per each model's declared `supported_formats`).
- The Anthropic SDK's `middleware`/native-fetch advantages therefore apply directly against 0G Compute, not only when calling Anthropic's own API — middleware runs inside the retry loop, before request signing, regardless of backend.
- **Recommendation:** use `@anthropic-ai/sdk` + `middleware` for Claude-on-0G traffic (retry-safe injection, built-in response-body access via `ctx.parse`, no manual response-cloning); use the `fetch`-override + `tee()` pattern for any non-Claude model on the router, since that path works identically on both SDKs.

---

## 5. Recommendation summary for dMemo

1. **Primary mechanism (works everywhere, including 0G today):** custom `fetch` passed to the client (`{ fetch: dMemoFetch }`), which:
   - reads/decrypts memory from 0G Storage and injects into `init.body` before calling the real `fetch`.
   - for streaming responses, `response.clone()`s (or relies on the SDK's own `Stream.tee()` after construction) to read a parallel copy for write-back accumulation, then forwards the original untouched response to the SDK.
2. **For Claude models (including through 0G):** the native Anthropic `middleware` option — less boilerplate (`ctx.parse` handles streaming clone automatically), retry-safe, and works uniformly across backends (Anthropic's own API, Bedrock/Vertex/Foundry, and now 0G's router) since backend adaptation runs inside `next()`. The router's `/v1/messages` route is genuinely Anthropic-Messages-compatible (D10), so this is not limited to direct-to-Anthropic scenarios.
3. Do **not** build a custom SDK subclass or monkey-patch internals — both `fetch` override and (for Anthropic) `middleware` are fully public, documented, exported extension points, satisfying the "native mechanism only" constraint.
4. **Confirmed (D10, `followup-0g-endpoints.md`):** 0G's router supports the Anthropic-format route, so the Anthropic SDK's `middleware` path is reachable in the 0G deployment target for Claude models.

---

## Unresolved / needs follow-up

- Whether 0G's OpenAI-compatible endpoint sets `stream_options.include_usage` or otherwise matches OpenAI's chunk shape closely enough for `Stream.tee()`/`ChatCompletionStream` helpers to parse cleanly (not verified against a live endpoint in this research; recommend a smoke test against `router-api.0g.ai/v1/chat/completions`).
- Python SDK equivalents were not separately verified in this pass (task scope was TS-primary); both `openai-python` and Anthropic's Python SDK are Stainless-generated siblings of the TS SDKs and are very likely to mirror `fetch`→`http_client`, `base_url`, and (for Anthropic) `middleware` 1:1, but this should be spot-checked before documenting Python guidance.
