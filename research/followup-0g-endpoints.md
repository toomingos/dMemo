# Follow-up: 0G Router endpoint shapes — /v1/messages, /v1/responses, headless auth, /v1/models.verifiability

Scope: settle the 4 blocking API-shape questions from `0g-compute.md`'s Open Questions, using
live unauthenticated probing of `router-api.0g.ai` / `router-api-testnet.integratenetwork.work`,
the published OpenAPI spec, the open-source `0g-serving-broker` Go source, and `docs.0g.ai`.

Researched 2026-07-24. All claims below are sourced inline (`file:line`, doc URL, or literal curl
output). No API key was used or required.

---

## (a) High-level overview

```
                         router-api.0g.ai/v1  (formal spec: 0gfoundation.github.io/0g-router/openapi.yaml)
                         ┌─────────────────────────────────────────────────────────┐
 OpenAI SDK ───POST──────▶ /v1/chat/completions   ── 200/401 (auth-gated) ─────────▶ EXISTS
 Claude Code ───POST─────▶ /v1/messages           ── 200/401 (auth-gated) ─────────▶ EXISTS
 Codex CLI ─────POST─────▶ /v1/responses          ── 404 "page not found" ─────────▶ DOES NOT EXIST
 anything ──────GET──────▶ /v1/models             ── 200, no auth, verifiability ───▶ EXISTS
                         └─────────────────────────────────────────────────────────┘
```

`/v1/messages` is not a documentation artifact or alias — it is a fully modeled, independently
tested Anthropic Messages surface inside the router's Go source (`0g-serving-broker`), with its
own request/response schemas, its own reasoning/`thinking` translation rules, its own
`anthropic-ratelimit-*` response headers, and a code comment stating its purpose outright:

```go
// api/inference/const/const.go:99-100
"/messages":             {}, // LiteLLM/Claude API format
"/v1/messages":          {}, // For Claude Code client compatibility
```

`/v1/responses` has **zero** occurrences anywhere in the router's OpenAPI spec, the open-source
broker's Go code, or `docs.0g.ai` — and returns the platform's generic 404, identical byte-for-byte
to a nonsense path, unlike `/v1/messages`/`/v1/chat/completions` which both 401 with a structured
JSON auth error.

---

## (b) Verdicts

| # | Question | Verdict |
|---|---|---|
| 1 | `/v1/messages` Anthropic-compatible endpoint (SSE, `anthropic-version`) | **CONFIRMED YES** (route + schema + streaming confirmed; `anthropic-version` header is accepted/ignored, not validated) |
| 2 | `/v1/responses` OpenAI Responses-API-shaped endpoint | **CONFIRMED NO** |
| 3 | Headless/scriptable flow for the *first* wallet JWT / `mk-`/`sk-` key (no browser) | **UNRESOLVED → leans NO** (no documented or coded flow found; router auth source itself is closed-source, so absence isn't 100% provable) |
| 4 | `GET /v1/models` exposes `verifiability` for TEE filtering | **CONFIRMED YES** |

---

## Q1 — `/v1/messages`: CONFIRMED YES

| Evidence | Detail | Source |
|---|---|---|
| Formal OpenAPI spec | `POST /messages` (server base `/v1`), summary **"Anthropic Messages API"**, description: *"Send chat request using Anthropic Messages API format. Routes to providers that support the Anthropic format."* Request schema `AnthropicRequest`: `model, messages, system, max_tokens, stop_sequences, stream, temperature, top_p, top_k, tools, tool_choice, metadata, attachments, plugins, provider`. Response schema `AnthropicResponse`: `id, type, role, model, content, stop_reason, usage`. | `https://0gfoundation.github.io/0g-router/openapi.yaml` (fetched live; `openapi: 3.0.0`, `info.title: "0G Router API 1.0"`, Go pkg path `github.com/0glabs/0g-router/pkg/inference`) |
| Live probe: route exists & is auth-gated (not a 404) | `POST /v1/messages` (no auth) → `HTTP 401 {"error":{"message":"Missing authorization header","code":"missing_authorization"}}` — structurally identical to `/v1/chat/completions`'s 401, and distinct from the generic `404 page not found` returned by `/v1/responses` and a bogus path. Reproduced on **both** mainnet (`router-api.0g.ai`) and testnet (`router-api-testnet.integratenetwork.work`). | curl, this session |
| Live probe: Anthropic-style `x-api-key` auth recognized | Sending `x-api-key: sk-fake` instead of `Authorization` flips the error from `missing_authorization` → `invalid_api_key` (i.e. the header was read and rejected as *wrong*, not ignored). Note: the **same** behavior occurs on `/v1/chat/completions` too, so this is global gateway middleware, not an Anthropic-only special case — and it is **not** in the formal OpenAPI `securitySchemes` (spec only documents `Authorization: Bearer sk-/mk-`, `ApiKeyAuth`/`ManagementKeyAuth`, both `type: apiKey, in: header, name: Authorization`). Treat `x-api-key` support as real-but-undocumented. | curl, this session; `openapi.yaml components.securitySchemes` |
| Source: dedicated route table, explicit purpose comment | `TargetRoute` map includes `"/messages"` (comment: *"LiteLLM/Claude API format"`) and `"/v1/messages"` (comment: *"For Claude Code client compatibility"`). | `0g-serving-broker/api/inference/const/const.go:99-100` |
| Source: request-surface detection & format enforcement | `apiFormatForPath` maps any path ending in `/messages` → `config.APIFormatAnthropic` (vs `/chat/completions` → `APIFormatOpenAI`); `enforceRequestFormat` rejects a model not declaring the surface in `supportedFormats`. Unit-tested: `{"/v1/messages", config.APIFormatAnthropic}`, `{"/v1/proxy/v1/messages", config.APIFormatAnthropic}`. | `api/inference/internal/ctrl/proxy.go:1216-1229`; `api/inference/internal/ctrl/format_enforcement_test.go:18-26,89-92` |
| Source: genuine Anthropic-dialect reasoning translation | Anthropic's native `thinking` control (`{"type":"enabled","budget_tokens":N}`, `budget_tokens` **mandatory**) is explicitly excluded from the broker's generic `reasoning_effort → thinking` translation *specifically because* it can't compute `budget_tokens` — this is dialect-aware, not a generic passthrough. | `api/inference/internal/ctrl/reasoning.go:70-93`; `docs/design/request-translation.md:43-49` |
| Source: full-fidelity Anthropic SSE streaming, billed correctly | `LiteLLMStreamEvent`/`LiteLLMStreamMessage`/`LiteLLMContentBlock`/`LiteLLMDelta` structs mirror Anthropic's real stream event shapes (`message_start`, `content_block_delta`, `message_delta`); usage merging follows Anthropic's actual three-bucket accounting (`input_tokens` excludes cache, separate `cache_creation_input_tokens`/`cache_read_input_tokens`, split by 5m/1h TTL) — code that could only be written against the real Anthropic streaming contract. | `api/inference/internal/ctrl/chatbot_litellm.go:14-150` |
| Source: Anthropic-shaped rate-limit headers | `SetRateLimitHeaders` branches on `IsAnthropicEndpoint(path)`: `/messages` gets `anthropic-ratelimit-requests-limit/remaining/reset` (RFC3339 reset time) instead of OpenAI's `x-ratelimit-limit-requests` (seconds-until-reset). | `api/common/middleware/ratelimit_headers.go:20-58` |
| `anthropic-version` header | **Not** in the OpenAPI `parameters` list for `/messages` (only routing headers: `X-0G-Provider-Address/Sort/Trust-Mode/Allow-Fallbacks`), and zero hits for the literal string `anthropic-version` anywhere in the broker source. Conclusion: the header is **not read/validated** by the router — Claude Code can send it as always, but it has no effect server-side (no version negotiation). | `openapi.yaml` `paths./messages.post.parameters`; `grep -rn anthropic-version` (0 hits) |
| docs.0g.ai | Only appears in the routing-header applicability table (`Chat` service type, grouped with `/v1/chat/completions`, both are "JSON endpoints" for body-level `provider` routing) — no dedicated schema page. The OpenAPI spec (above) is the actual authoritative source; `authentication.md` explicitly points there: *"For the full request / response shape of every endpoint, see the Router API reference: https://0gfoundation.github.io/0g-router/"* | `docs.0g.ai/.../router/routing`; `0g-doc` repo `docs/.../router/authentication.md` (fetched raw via `gh api`) |

**Net:** this is not a thin alias — it's a first-class, independently tested Anthropic Messages
implementation with correct auth-header recognition, dialect-aware parameter translation, and
Anthropic-shaped streaming/rate-limit semantics. Routing Claude Code through
`ANTHROPIC_BASE_URL=https://router-api.0g.ai/v1` + `ANTHROPIC_AUTH_TOKEN=sk-...` should work
as a drop-in, same posture as `/v1/chat/completions` for OpenAI clients.

---

## Q2 — `/v1/responses`: CONFIRMED NO

| Evidence | Detail |
|---|---|
| OpenAPI spec | 17 paths enumerated in `openapi.yaml`; `/responses` is **absent**. Full list: `/account/funds`, `/account/usage/{daily,history,stats}`, `/api-keys`, `/api-keys/{keyId}`, `/async/images/{edits,generations}`, `/audio/transcriptions`, `/chat/completions`, `/images/{edits,generations}`, `/messages`, `/models`, `/providers`, `/routing/preview`, `/service-types`. |
| Live probe | `POST /v1/responses` (mainnet, no auth) → `HTTP 404`, body `404 page not found`, `content-type: text/plain` — identical shape to a deliberately bogus path (`/v1/totally-bogus-path-xyz`) and to `GET`/`OPTIONS` on real routes that don't support that method. This is Go's default `http.NotFound`, i.e. **no handler is registered** for this path at all (contrast with `/v1/messages`'s structured 401 JSON). Reproduced identically on testnet. |
| Source | Zero occurrences of `v1/responses`, `wire_api`, `ResponsesAPI`, or `responses_api` anywhere in `0g-serving-broker` (the open-source per-provider broker that implements the `/v1/messages` and `/v1/chat/completions` translation layers). |
| Web search | No announcement, changelog, blog post, GitHub issue, or PR anywhere referencing 0G + OpenAI Responses API / Codex CLI compatibility. |

**Net:** Codex CLI (`wire_api = "responses"`-only since Feb 2026) **cannot** be pointed at 0G's
Router today. No workaround exists short of a local translating proxy (out of scope for dMemo, and
explicitly against the "no custom logic" principle) or 0G shipping the endpoint themselves.

---

## Q3 — Headless first-credential issuance (SIWE / non-browser): UNRESOLVED, leans NO

| Evidence | Detail |
|---|---|
| `authentication.md` (raw source, fetched from `0gfoundation/0g-doc`, current as of today) | *"Created at **pc.0g.ai** → Dashboard → API Keys"* / *"Created at **pc.0g.ai** → Settings → Management Keys"*. No OAuth, no CLI, no SIWE flow described anywhere on the page. Explicit guardrail: *"**ANY** `/v1/management-keys/*` requires the wallet JWT (sign-in session)."* — i.e. the wallet-JWT sign-in is a documented **prerequisite**, but how to obtain that JWT outside the browser is never specified. |
| docs.0g.ai FAQ | No mention of SIWE, headless setup, scripted/CLI onboarding, or sign-in without a browser (checked directly). |
| GitHub code/issue search | `gh search code "SIWE"` / `"sign-in with ethereum"` / `/auth/login` across `org:0gfoundation` and `org:0glabs`: **0 hits**. `gh search issues "SIWE OR headless..."`: **0 hits**. |
| Source-code gap | The actual router gateway (Go module `github.com/0glabs/0g-router`, implied by the OpenAPI spec's schema namespace) is **not** a public repo — `gh repo view 0gfoundation/0g-router` / `0glabs/0g-router` both 404. The only public wallet-signature auth code found (`0g-serving-broker`'s `api/controller/internal/middleware/auth.go`, EIP-191 `Bearer app-sk-<base64(rawMessage\|signature)>`) is the **Direct/per-provider** admin-session mechanism, not the Router's pc.0g.ai wallet-JWT sign-in — different subsystem, doesn't settle the question either way. |

**Net:** nothing publicly documented or coded describes a non-browser path to the *first*
credential. This is an absence-of-evidence finding, not a code-level proof of impossibility — the
component that would contain the answer (the router's own auth service) is closed-source. **What
would settle it:** either (a) ask 0G Labs directly / file a doc issue on `0gfoundation/0g-doc`, or
(b) inspect `pc.0g.ai`'s network traffic during sign-in for a SIWE (`personal_sign` over an
EIP-4361 message) request to a discoverable `/auth/*` endpoint, then test that endpoint
programmatically with a scripted wallet.

---

## Q4 — `GET /v1/models` → `verifiability` field: CONFIRMED YES

Live, unauthenticated `GET https://router-api.0g.ai/v1/models` (23 models, fetched this session):

| `verifiability` value | Meaning | Example models |
|---|---|---|
| `"TeeML"` | Model itself runs inside the TEE (strongest privacy tier) | `0gm-1.0-35b-a3b`, `glm-5.2`, `whisper-large-v3`, `z-image-turbo` |
| `"TeeTLS"` | Broker/proxy runs in TEE, forwards to a centralized upstream (e.g. OpenAI/Anthropic) over TLS — upstream itself not attested | `deepseek-v4-pro`, `glm-5`, `kimi-k3`, `qwen3.7-max` |
| absent (`null`) | No TEE attestation at all | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `gpt-5.6-luna/sol/terra` |

Each entry also carries `tee_attested: bool`, `tee_type` (e.g. `"TDX"`), `tee_verifier` (e.g.
`"dstack"`), and `provider_count`. A client can filter to model-in-TEE providers with:

```
curl -s https://router-api.0g.ai/v1/models | jq '.data[] | select(.verifiability == "TeeML") | .id'
```

Additionally, each model declares `supported_formats: ["openai"] | ["anthropic"] | ["openai","anthropic"]`
— e.g. `glm-5` and `glm-5.2` support **both** surfaces, `claude-*` models are `["anthropic"]`-only.
This field is itself corroborating evidence for Q1: the router only advertises `"anthropic"` as a
supported format because `/v1/messages` genuinely exists to serve it.

---

## Key decisions for dMemo (with references)

| Decision | Recommendation | Why |
|---|---|---|
| Claude Code integration | **Go ahead** — point `ANTHROPIC_BASE_URL` at `https://router-api.0g.ai/v1`, `ANTHROPIC_AUTH_TOKEN=sk-...` | `/v1/messages` is a real, tested, spec'd endpoint (Q1 evidence above). Don't build a translation shim — 0G already did it (`request-translation.md`, `chatbot_litellm.go`). |
| Codex CLI integration | **Blocked, do not build a workaround proxy** | `/v1/responses` genuinely does not exist (Q2). A homemade Responses-API→Chat-Completions/Messages translation layer would violate the "no custom logic, use native SDK/router features" principle and would need to be maintained indefinitely. Track 0G's `0g-doc` repo / router changelog for when they add it, or file a feature request rather than build around it. |
| "Fully scripted setup" marketing claim | **Soften it** — first credential still needs one interactive `pc.0g.ai` sign-in | No documented headless path (Q3). Everything *after* the first `mk-`/`sk-` key is scriptable (`POST /v1/api-keys`, deposits via raw `ethers` tx) — say "one-time interactive sign-in, then fully scripted" rather than "zero-UI." |
| Privacy-tier model selection | Filter `GET /v1/models` on `verifiability == "TeeML"` for the strict "runs inside enclave" guarantee; treat `"TeeTLS"` as weaker (broker-in-TEE only) | Confirmed field shape and values (Q4). Matches the `X-0G-Provider-Trust-Mode: private` semantics already documented in `0g-compute.md`. |

---

## Key files / URLs referenced

- OpenAPI spec (authoritative endpoint list + schemas): `https://0gfoundation.github.io/0g-router/openapi.yaml`
- `docs.0g.ai/developer-hub/building-on-0g/compute-network/router/{routing,authentication,faq,features/chat-completions}`
- `0gfoundation/0g-doc` (raw source of authentication.md, fetched via `gh api repos/.../contents/...`)
- `0g-serving-broker` clone: `/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/0g-serving-broker`
  - `api/inference/const/const.go:99-100` — route table, "Claude Code client compatibility" comment
  - `api/inference/internal/ctrl/proxy.go:1216-1229` — `apiFormatForPath`
  - `api/inference/internal/ctrl/format_enforcement_test.go:18-26,89-92` — route→format unit tests
  - `api/inference/internal/ctrl/reasoning.go:70-93` — Anthropic `budget_tokens` exclusion rule
  - `api/inference/internal/ctrl/chatbot_litellm.go:14-150` — Anthropic SSE stream event structs, usage accounting
  - `api/common/middleware/ratelimit_headers.go:20-58` — `anthropic-ratelimit-*` vs `x-ratelimit-*` headers
  - `docs/design/request-translation.md` — translation contract, cites the genuine `/v1/messages` surface
- Live probes (this session, mainnet `router-api.0g.ai` + testnet `router-api-testnet.integratenetwork.work`): `GET /v1/models`, `POST /v1/messages`, `POST /v1/responses`, `POST /v1/chat/completions`, `OPTIONS`/`GET` variants — raw responses captured, not reproduced verbatim here for brevity.
