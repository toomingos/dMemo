# @dmemo/sdk-wrappers

dMemo's inference leg for raw OpenAI/Anthropic SDK users: a preconfigured
0G Compute Router client factory, plus memory-injection wrappers built on
each SDK's own native `fetch`/`middleware` extension points — no
subclassing, no monkey-patching.

This package is dependency-light on purpose: it does **not** depend on
`@dmemo/core`. It types against a small structural `DmemoMemorySession`
interface, satisfied by `@dmemo/core`'s `DmemoSession` public surface.

## Install

```bash
npm install @dmemo/sdk-wrappers
```

## Router client preset (T2.1)

```ts
import { createRouterClients, listPrivateModels } from '@dmemo/sdk-wrappers';

const { openai, anthropic } = createRouterClients({
  network: 'testnet',
  apiKey: process.env.ZEROG_API_KEY!, // a Router sk-... key, minted at pc.0g.ai
});

// Filters GET /v1/models for verifiability === "TeeML" (private inference).
const models = await listPrivateModels({ network: 'testnet' });
```

Every request carries `X-0G-Provider-Trust-Mode: private` (TeeML-only
routing) by default — this is what makes "private inference" true. As of
2026-07-25 there is no TeeML **chat** model live on testnet (catalog
drift — see `docs/disclosure.md`); `listPrivateModels()` will reflect
whatever the Router currently advertises.

## SDK memory wrappers (T2.2)

```ts
import OpenAI from 'openai';
import { createOpenAIMemoryFetch } from '@dmemo/sdk-wrappers';

const client = new OpenAI({
  baseURL: '<router-url>/v1',
  apiKey: 'sk-...',
  fetch: createOpenAIMemoryFetch(dmemoSession, { topK: 5 }),
});
```

The custom `fetch` injects `session.search()` results into the request body
before the call, and writes the assistant's reply back via `session.add()`
+ `session.flush()` after — handling both non-streaming responses and
streamed responses (`Stream.tee()`) transparently.

For Anthropic/Claude traffic, `createAnthropicMemoryMiddleware` (built on
the SDK's exported `middleware` extension point, v0.101.0+) is the
preferred alternative to custom-fetch — it runs inside the retry loop and
gives an independent stream copy via `ctx.parse(response)`.

## What this package does not do

- No retry/failover/provider pooling (the Router does this).
- No support for the deprecated `@0glabs/0g-serving-broker`.
- No `/v1/responses` support (Codex inference through 0G is out of scope —
  the Router has no such endpoint).
