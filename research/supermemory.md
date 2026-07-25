# Research: Supermemory (github.com/supermemoryai/supermemory)

Sources cloned to `/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/`:
- `supermemory` — main monorepo (web app, docs, MCP server, `@supermemory/tools` SDK wrappers, memory-graph viewer)
- `claude-supermemory` — Claude Code plugin
- `opencode-supermemory` — OpenCode plugin
- `openclaw-supermemory` — OpenClaw plugin
- `hermes-agent` — NousResearch Hermes, contains `plugins/memory/supermemory/`

**Headline finding:** the open-source monorepo does **not** contain the ingestion/chunking/embedding/graph engine. That engine ships only as a closed/compiled binary (`supermemory-server`, "Supermemory local", installed via `curl .../install | bash`). What's open source, and what we should actually fork, is the **orchestration layer**: the TS/Python client SDKs, the per-agent integration plugins, and the `@supermemory/tools` wrappers that do recall-injection and write-back around a model call. This matches the "port at a higher level" branch of the research question.

---

## (a) High-level overview

### 1. Where state actually lives

```
┌─────────────────────────────────────────────────────────┐
│  OPEN SOURCE (supermemoryai/supermemory monorepo)        │
│  - apps/web (dashboard), apps/mcp (hosted MCP server)     │
│  - packages/tools (@supermemory/tools: ai-sdk/openai/     │
│    mastra/voltagent wrappers)                             │
│  - packages/memory-graph (React graph *viewer* only)      │
│  - npm/pip client SDKs (thin REST wrappers)                │
└─────────────────────────────────────────────────────────┘
                        │  REST (/v3/documents, /v4/search,
                        │        /v4/profile, /v4/conversations)
                        ▼
┌─────────────────────────────────────────────────────────┐
│  CLOSED / BINARY-ONLY  ("Supermemory graph engine")       │
│  Pipeline: Queued → Extract → Chunk → Embed → Index →     │
│            Done  (docs: skills/supermemory/references/    │
│            architecture.md:39-169)                        │
│  Storage: embedded graph engine + local disk               │
│  (self-hosted: everything under $SUPERMEMORY_DATA_DIR,     │
│   default ./.supermemory — apps/docs/self-hosting/         │
│   configuration.mdx:12-17, 60-62)                          │
│  Embeddings: local Xenova/bge-base-en-v1.5 (768d) by       │
│  default, or OpenAI/Gemini/Ollama (configuration.mdx:64-75)│
│  Vector index: HNSW, claimed (architecture.md:360-364,     │
│  not verifiable — engine source not published)             │
└─────────────────────────────────────────────────────────┘
```

`apps/docs/self-hosting/overview.mdx:8,20` calls the local binary "open source," but the actual monorepo has no server/ingestion/chunking/embedding/vector-index code — `packages/memory-graph` is a **React canvas visualization** of the graph (`src/canvas`, `src/components`, `src/hooks`), not the graph engine itself. Confirmed by repo-wide search: no `hnsw`, chunking, or embedding implementation files anywhere in `packages/` or `apps/mcp` outside type defs (`packages/memory-graph/src/api-types.ts`, `packages/lib/similarity.ts`).

### 2. Pluggability answer

**Storage is not pluggable at the swap-in level** — there's no adapter interface for "bring your own vector store / bring your own blob store" in the open source. The only two integration points are:
1. **`baseURL`** on the client SDK (`apps/docs/self-hosting/overview.mdx:50-57`) — point the SDK at a different HTTP server that implements the same `/v3`, `/v4` REST surface (hosted Supermemory, self-hosted binary, or — for us — our own 0G-backed API).
2. **Self-hosting env vars** for the *model* used during extraction/chunking (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL` for any OpenAI-compatible endpoint) and for *embeddings* (`SUPERMEMORY_EMBEDDING_PROVIDER=local|openai|gemini|<openai-compatible>`) — `apps/docs/self-hosting/configuration.mdx:19-51,64-75`. This lets you point extraction/embedding at 0G Compute (OpenAI-compatible) without touching storage.

**Conclusion for dMemo:** we cannot fork the "engine" (it isn't public). We port at the **client/integration layer**: reimplement a small REST-compatible surface (`add`/`search`/`profile`, or our own equivalent) backed by 0G Storage, and reuse/adapt the *pattern* of their per-agent plugins (hooks, prefetch/sync_turn lifecycle, middleware wrapping) which are fully open source and agent-agnostic.

### 3. Retrieval flow (as documented)

```
Query → embed query → cosine-similarity search in container →
threshold filter → relationship expansion (Updates/Extends/Derives) →
rank (similarity, recency, static>dynamic, metadata) → top-k
```
(`skills/supermemory/references/architecture.md:203-259`) — again, this is the closed engine's documented behavior, not something we can inspect/fork.

---

## (b) Integration patterns per target agent

Every one of Supermemory's own agent integrations uses the **host agent's native extensibility mechanism** — none of them proxy the LLM endpoint or run a man-in-the-middle chat completions wrapper for the coding agents. The one place a literal proxy/middleware pattern exists is the **generic SDK wrapper family** (`@supermemory/tools`), meant for developers building their own agent, not for wrapping Claude Code/Codex/OpenCode/Hermes/OpenClaw themselves.

| Target agent | Repo | Pattern | Mechanism |
|---|---|---|---|
| **Claude Code** | `claude-supermemory` | Native hooks + Skills (function-calling) | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop` hooks (`plugin/hooks/hooks.json`) + two Agent Skills (`supermemory-search`, `supermemory-save`) that the model invokes as tools |
| **OpenCode** | `opencode-supermemory` | Native OpenCode plugin API (SDK middleware, in-process) | `chat.message` lifecycle hook to inject context + a `supermemory` function-calling `tool` + `event` hook for compaction/write-back (`src/index.ts:46-534`) |
| **OpenClaw** | `openclaw-supermemory` | Native OpenClaw plugin SDK (event hooks) + function-calling tools | `api.on("before_prompt_build", …)` for recall, `api.on("agent_end", …)` for capture, plus 4 registered tools (search/store/forget/profile) (`index.ts:75-90`) |
| **Hermes** (personal agent, NousResearch) | `hermes-agent/plugins/memory/supermemory` | Formal `MemoryProvider` ABC plugin — closest to a "memory SDK interface" | `prefetch(query)` before each LLM call, `sync_turn(user, assistant)` after each turn, `on_session_end(messages)` for full-session ingest, `on_memory_write` mirror hook, `shutdown()` (`__init__.py:714-843`) |
| **Any MCP client** (Claude Desktop, Cursor, VS Code — not our target list, but a live alt-pattern) | `apps/mcp/src/server.ts` | MCP server | Tools: `memory`, `recall`, `list`, plus `context` prompt and a `memory-graph` MCP-UI resource (`server.ts:144-244, 495-565`) |
| **Generic dev SDK** (not agent-specific) | `packages/tools/src/{vercel,openai,mastra,voltagent}` | **True proxy/middleware** — "infinite chat"-style wrapping of the model/client | `withSupermemory(model)` wraps AI SDK `doGenerate`/`doStream` via `Proxy`; `createOpenAIMiddleware(openaiClient, ...)` monkey-patches `chat.completions.create` |

Key takeaway: **there is no MCP usage and no LLM-endpoint proxy in the Claude Code / OpenCode / OpenClaw plugins.** They all attach to the host's own plugin/hook lifecycle and let the *agent* call memory as a tool (function-calling), or inject context directly into the transcript/message list. The literal "wrap the model call" proxy pattern exists only in the generic `@supermemory/tools` SDK wrappers, which is the closest analog to what dMemo needs for the 0G Compute (OpenAI-compatible / Anthropic SDK) leg, since dMemo's agents may not all expose a native hook system the way Claude Code does.

---

## (c) Completion output → automatic memory mutation (including streaming)

Three distinct write-back strategies observed, none of them intercept token-level streaming for *extraction* — extraction always happens on the accumulated final text, but the *point of capture* differs:

**1. Post-hoc transcript read (Claude Code)** — not streaming-aware at all. The `Stop` hook fires after Claude Code's own turn is fully written to its on-disk JSONL transcript; the plugin re-reads the transcript file, diffs against a saved "last captured UUID" per session, formats new entries, and calls `client.add()`.
`claude-supermemory/src/summary-hook.js:57-90`, formatter: `src/lib/transcript-formatter.js:459-495` (`formatNewEntries`).

**2. Event-driven, in-process accumulation (Hermes, OpenClaw)** — `sync_turn(user, assistant)` fires once per completed turn from the host loop (non-streaming callback, called after generation finishes); Hermes buffers turns in memory and writes once via `/v4/conversations` at `on_session_end` (session end / reset / compression / shutdown) rather than per turn — explicitly to get better entity extraction/profile quality from a full session:
`hermes-agent/plugins/memory/supermemory/__init__.py:731-775`.
OpenClaw's `agent_end` handler does the equivalent per-turn, immediately, in `hooks/capture.ts:25-127`.
Threading contract is explicit and important: `sync_turn()` **must be non-blocking** — spawn a daemon thread (`hermes-agent/website/docs/developer-guide/memory-provider-plugin.md:152-168`).

**3. True streaming interception (AI SDK / OpenAI middleware — the generic wrappers)** — this is the only place that actually taps a token stream:
- `packages/tools/src/vercel/index.ts:217-296` — wraps `doStream`, pipes the model's stream through a `TransformStream` that accumulates `text-delta` chunks into `generatedText`, and on stream `flush()` fires `saveMemoryAfterResponse(...)` (fire-and-forget, not awaited before the stream closes to the caller).
- Non-streaming path (`doGenerate`, same file, lines 153-214) does the equivalent synchronously after `target.doGenerate()` resolves.
- `saveMemoryAfterResponse` (`packages/tools/src/claude-memory.ts` is a different file — see below; actual save fn is `packages/tools/src/vercel/middleware.ts:151-188`) converts the full param + response into a structured message array and POSTs to `/v4/conversations` (`packages/tools/src/conversations-client.ts:73-102`), which the docs say "supports smart diffing and append detection on the backend" — i.e., the backend, not the client, does incremental dedup.
- The OpenAI-client variant (`packages/tools/src/openai/middleware.ts:417-648`) is the most directly relevant to dMemo/0G Compute: it monkey-patches `openaiClient.chat.completions.create` (and `.responses.create`) to run memory-search + system-prompt injection **before** the call and `addMemoryTool(...)` (persist) **after/alongside** it, entirely client-side, zero server changes required — exactly the shape you'd want for an OpenAI-compatible endpoint like `pc.0g.ai`.

There is also a **native Anthropic memory-tool bridge** (`packages/tools/src/claude-memory.ts:1-634`): implements Anthropic's "memory tool" filesystem-command protocol (`view`/`create`/`str_replace`/`insert`/`delete`/`rename` under a virtual `/memories/` path) by mapping each command 1:1 onto `client.add()` / `client.search.execute()` / `client.documents.delete()`, using `customId` derived from the path. This is a **direct precedent for wiring dMemo into Claude's own native context-management memory tool** if we want Claude Code / Anthropic-SDK agents to manage memory via that channel instead of a custom tool.

---

## (d) Minimal subset to port for fetch-at-runtime + write-back

Given the engine itself is closed, "porting Supermemory" concretely means porting **patterns and thin glue code**, not a storage/ingestion stack. Recommended minimal surface, mapped to what we found:

| Piece | What to take | Where it lives in supermemory | Why |
|---|---|---|---|
| Client wrapper | Thin REST client (`add`, `search`, `profile`) over our own 0G-Storage-backed API | `claude-supermemory/src/lib/supermemory-client.js:58-254` (simplest, cleanest version) | Small, dependency-light, already handles container-tag scoping, dedup, and multi-container merge — good shape to imitate for a 0G-backed equivalent |
| Fetch-at-runtime hook | `prefetch(query)` — synchronous-before-call, timeout-bounded, fails open to empty context | Hermes `MemoryProvider.prefetch` (`__init__.py:714-729`) + AI-SDK `transformParamsWithMemory` (`vercel/middleware.ts:316-382`, has `memoryRetrievalTimeoutMs` + `skipMemoryOnError`) | This is literally dMemo's "fetch ephemerally at runtime, inject, discard" requirement — both already implement timeout + fail-open |
| Write-back hook (non-streaming) | Call after `doGenerate`-equivalent resolves; fire-and-forget | `vercel/index.ts:181-214` | Matches "completion output → automatic memory mutation" |
| Write-back hook (streaming) | `TransformStream` tap on the model's SSE/stream, accumulate text, flush on stream end | `vercel/index.ts:217-296` | Directly portable pattern for wrapping 0G Compute's OpenAI-compatible streaming endpoint |
| OpenAI-compatible client patch | Monkey-patch `chat.completions.create`/`.responses.create` | `packages/tools/src/openai/middleware.ts:417-648` | Best template for wrapping calls to `pc.0g.ai` (OpenAI-compatible) with zero changes to caller code |
| Anthropic-native path | Anthropic memory-tool bridge (`view/create/str_replace/insert/delete/rename` → backend ops) | `packages/tools/src/claude-memory.ts` | Lets Claude-SDK agents (Claude Code) use Anthropic's own memory tool contract instead of a bespoke tool — reduces custom logic per the "prefer native SDK features" constraint |
| Per-agent attach points (reference only, not to copy verbatim) | Claude Code hooks/skills, OpenCode plugin, OpenClaw plugin, Hermes `MemoryProvider` ABC | respective repos | Confirms each host already has a native, non-proxy extension point; dMemo should write one adapter per host using its *own* hook system rather than a universal proxy, mirroring this precedent |

**What NOT to port:** chunking, embedding, HNSW indexing, relationship graph (Updates/Extends/Derives), user-profile synthesis, connectors (Gmail/Drive/Notion), MCP server, memory-graph visualizer, benchmarking tooling (MemoryBench). None of these are needed for "fetch relevant context → inject → discard → write mutation," and the semantic/graph layer isn't available to fork anyway.

**Open gaps / unresolved:**
- Could not verify the actual chunking/embedding/indexing implementation (closed binary) — everything in `skills/supermemory/references/architecture.md` is product-doc description, not code, so specifics (e.g. true chunk boundaries, exact HNSW params) are unverifiable and irrelevant to our fork-at-the-glue-layer approach.
- Did not find a Codex integration in this pass (README lists Claude Code/OpenCode/OpenClaw/Hermes plugins only); Codex coverage should be confirmed by whichever research thread covers Codex specifically.
- `/v4/conversations`' server-side "smart diffing and append detection" is asserted in comments (`conversations-client.ts:6`) but its algorithm is naturally not inspectable (closed engine) — if we build our own write-back mutation logic on 0G Storage we'll need to design diffing ourselves rather than port it.
