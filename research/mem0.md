# Research: Mem0 (github.com/mem0ai/mem0) as dMemo's memory engine

Sources cloned to `/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/`:
- `mem0` — main monorepo (Python engine, `mem0-ts` TS SDK, `server/` self-hosted dashboard, `openmemory/` — sunset, `integrations/` per-agent plugins, `docs/`)
- `hermes-agent` — already had `plugins/memory/mem0/` (a full, working `MemoryProvider` plugin with Platform / self-hosted-server / OSS backends)

**Headline finding:** mem0's actual memory **engine** (LLM fact-extraction pipeline, embedding, vector storage, retrieval/dedup) is genuinely open source, Apache-2.0, in `mem0/` (Python) and `mem0-ts/src/oss/` (TypeScript). Both ship an abstract `VectorStoreBase`/`VectorStore` interface with 20+ implementations — a real pluggability seam we can implement natively for 0G Storage. What's **platform-only** (api.mem0.ai) is a specific set of v3 features (temporal reasoning, memory decay, built-in graph memory, webhooks, memory export, custom categories) — not the core pipeline. LLM and embedder calls go through a standard `OpenAI(api_key, base_url=...)` client construction, so pointing the LLM call at the 0G Compute router is a one-line config change; the router has **no** `/embeddings` endpoint (`followup-0g-endpoints.md`), so the embedder runs locally instead (D6).

---

## 1. Open-source completeness and license

```
┌───────────────────────────────────────────────────────────────────┐
│  APACHE-2.0, FULLY OPEN (mem0ai/mem0, single repo, one LICENSE)     │
│                                                                       │
│  mem0/            Python engine: LLM extraction, embedding,          │
│                    vector_stores/ (23 providers), llms/ (19),        │
│                    embeddings/ (10), reranker/, memory/main.py       │
│                    (add/search pipeline), memory/storage.py          │
│                    (SQLite history — supports ":memory:")            │
│  mem0-ts/          TS/JS: npm package "mem0ai" — client (Platform)   │
│                    + oss/ (in-process engine, same pipeline shape)   │
│  server/           Self-hosted FastAPI + pgvector dashboard/API      │
│                    (Docker: `cd server && make bootstrap`)           │
│  integrations/     mem0-plugin (Claude Code/Codex/Cursor/OpenCode/   │
│                    Antigravity), openclaw, vercel-ai-sdk,            │
│                    pi-agent-plugin — all Apache-2.0                  │
│  openmemory/       ⚠️ SUNSET — README says "being sunset... use      │
│                    Mem0 self-hosted server instead"                  │
└───────────────────────────────────────────────────────────────────┘
                              │  optional: point client at
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│  HOSTED PLATFORM (api.mem0.ai) — usage-based pricing, closed         │
│  backend, same open MemoryClient talks to it over REST               │
└───────────────────────────────────────────────────────────────────┘
```

- **License**: Apache 2.0 across every subdirectory checked — root `LICENSE`, `mem0-ts/package.json` (`"license": "Apache-2.0"`), `integrations/openclaw/LICENSE`, `integrations/pi-agent-plugin/LICENSE`, all `skills/*/LICENSE`. No dual-license or "open-core with a proprietary core module" pattern.
- **What's genuinely in the repo, verified by reading the code, not just docs**: fact extraction prompt (`mem0/configs/prompts.py:15` `FACT_RETRIEVAL_PROMPT`, `:176` `DEFAULT_UPDATE_MEMORY_PROMPT`), the phased add pipeline (`mem0/memory/main.py:849` `_add_to_vector_store`), search + BM25/vector hybrid scoring, entity linking, dedup, 23 vector store adapters, 19 LLM adapters, 10 embedder adapters, reranker adapters, a SQLite history/audit log.
- **Official platform-vs-OSS matrix** (`docs/platform/platform-vs-oss.mdx`) — the authoritative source, not marketing copy:

| Feature | Platform | OSS |
|---|---|---|
| Core add/search/update/dedup | ✅ | ✅ |
| Temporal reasoning (v3) | ✅ | ❌ |
| Memory decay (v3) | ✅ | ❌ |
| Graph memory | ✅ built-in | "External graph store" (see caveat below) |
| Webhooks | ✅ | ❌ |
| Memory export | ✅ | ❌ |
| Dashboard/analytics | ✅ | ❌ (DIY) |
| Vector DB / LLM choice | Managed | 20+ / 15+ providers, your choice |

  **Caveat on graph memory**: despite the doc saying OSS gets "external graph store," a repo-wide search (`grep -rl "class.*Graph\|graph_store" mem0/`) found **no `GraphMemory` class and no `mem0/graphs/` directory** in the current codebase — the only hit is an exception message in `mem0/exceptions.py:396` referencing `pip install kuzu` for a `graph_store` feature that doesn't appear to be wired to a concrete implementation in this snapshot. Treat OSS graph memory as unimplemented/removed, not just "external" — irrelevant for dMemo anyway since we don't need graph storage.
- **Community health**: ~60k GitHub stars, ~7k forks, 389 contributors, ~2,499 commits (per live web search, July 2026); the cloned HEAD commit (`d653b63`) is dated **the same day as this research** — actively maintained, commits landing within hours. [Stargazers](https://github.com/mem0ai/mem0/stargazers) · [Contributors](https://github.com/mem0ai/mem0/graphs/contributors) · [Activity](https://github.com/mem0ai/mem0/activity)

---

## 2. Architecture: end-to-end pipeline

### `add()` — "V3 Phased Batch Pipeline" (`mem0/memory/main.py:849-1170`)

```
messages ──▶ Phase 0: pull last 10 turns from SQLite history (session context)
          ──▶ Phase 1: embed query, vector-search existing memories (top_k=10, same user/agent/run scope)
          ──▶ Phase 2: ONE LLM call — ADDITIVE_EXTRACTION_PROMPT
                        (existing memories + new messages + custom instructions → JSON {"memory": [...]})
          ──▶ Phase 3: batch-embed all extracted texts (embed_batch, one round-trip)
          ──▶ Phase 4/5: per-memory MD5 hash dedup against existing + in-batch hashes
          ──▶ Phase 6: batch insert into vector store + batch write to SQLite history table
          ──▶ Phase 7: batch entity extraction + linking (lightweight "entity_store" —
                        NOT a graph DB; just another vector-store collection with
                        linked_memory_ids in the payload, deduped by embedding similarity ≥0.95)
          ──▶ Phase 8: persist raw messages to SQLite, return {"results":[{"id","memory","event":"ADD"}]}
```

Notable: this pipeline is **additive + hash-dedup**, not the older mem0 "LLM decides ADD/UPDATE/DELETE/NONE per fact" behavior (`DEFAULT_UPDATE_MEMORY_PROMPT` in `configs/prompts.py:176` still exists as an available prompt/helper, but the default v3 path doesn't call it) — conflict resolution here is closer to "extract facts once, embed, dedup by hash + entity similarity" than a stateful LLM negotiation. Passing `infer=False` skips extraction entirely — messages stored verbatim (one embed call per message, no LLM call).

### `search()` (`mem0/memory/main.py:1349`)

```
query ──▶ validate/trim filters (must include user_id/agent_id/run_id)
       ──▶ embed query + vector_store.search(top_k, filters, threshold=0.1)
           (BM25 keyword_search available per-store as a hybrid signal;
            metadata filters support eq/ne/gt/gte/lt/lte/in/nin/contains/
            icontains + AND/OR/NOT — mem0/memory/main.py:1349-1420)
       ──▶ optional reranker.rerank(query, results, top_k) if rerank=True
       ──▶ {"results": [...]}
```

### Storage layer abstraction

- **Vector store**: `mem0/vector_stores/base.py` — a clean 10-method ABC (`create_col`, `insert`, `search`, `delete`, `update`, `get`, `list_cols`, `delete_col`, `col_info`, `list`, plus optional `keyword_search`/`search_batch` overrides). `search()` has an explicit documented contract: **higher score = more similar, normalize to [0,1]** (cosine: `1 - distance`; L2: `1/(1+distance)`; inner product: pass through). This is exactly the seam to implement for 0G Storage.
- **Supported vector stores (Python, `mem0/vector_stores/`)**: Qdrant, Pinecone, Chroma, Weaviate, Milvus, PGVector, Redis, Valkey, MongoDB, Elasticsearch, OpenSearch, Supabase, Cassandra, FAISS, Azure AI Search, Azure MySQL, Baidu, Databricks, Neptune Analytics, OracleDB, S3 Vectors, Turbopuffer, Upstash Vector, Vertex AI Vector Search, LangChain (meta-adapter to any LangChain vectorstore).
- **History/state store**: `mem0/memory/storage.py` — `SQLiteManager`, `db_path: str = ":memory:"` by default-capable — stores per-memory audit history (old/new value, event, timestamps) and a rolling window of raw messages per session, used to seed Phase 0 context on the next `add()`.
- **LLM providers** (`mem0/llms/`): OpenAI, Anthropic, AWS Bedrock, Azure OpenAI (+structured variant), DeepSeek, Gemini, Groq, LiteLLM (meta-provider → hundreds more), LM Studio, MiniMax, Ollama, Sarvam, Together, vLLM, xAI, LangChain.
- **Embedders** (`mem0/embeddings/`): OpenAI, AWS Bedrock, Azure OpenAI, FastEmbed (local, ONNX), Gemini, HuggingFace, LangChain, LM Studio, Ollama, Together, VertexAI, plus a `mock.py` for tests.
- **TS mirrors the same shape** — `mem0-ts/src/oss/src/{vector_stores,llms,embeddings,storage,rerankers}/`, 25 vector store adapters, `storage/MemoryHistoryManager.ts` (pure in-process `Map`), `storage/SQLiteManager.ts` (better-sqlite3).

---

## 3. Pluggability for 0G

### Vector/storage backend — implement `VectorStoreBase` natively

- **Feasible, and the intended extension point.** `mem0/utils/factory.py` (`VectorStoreFactory`) instantiates providers by string name from config; adding a `zerog` provider is the same shape as any of the 23 existing ones — implement the 10-method ABC, register it in the factory/config enum, done. No fork-and-patch-core-logic needed, matching the "no custom logic, use native mechanisms" constraint.
- **Two more directly relevant precedents already in-repo**:
  - Python `mem0/vector_stores/faiss.py` — a fully **in-process, no-server** vector store (FAISS index in RAM), with a `SafeUnpickler`-guarded pickle save/load path to disk. Structurally the closest existing adapter to "in-RAM index, periodically snapshotted to a blob."
  - TS `mem0-ts/src/oss/src/vector_stores/memory.ts` (`MemoryVectorStore`) — despite the name, it's a **single-file `better-sqlite3` database** (brute-force cosine similarity + inline BM25, no external server, `~/.mem0/vector_store.db` by default per the OpenClaw plugin README). Being a single SQLite file, its entire state is trivially representable as one byte blob — read the file, upload to 0G Storage; on session start, download the blob, write it to a temp path, point `dbPath` at it. This is very close to dMemo's "RAM at session start → flush snapshot → discard" model, modulo swapping the temp file for a true in-memory `:memory:` SQLite handle (untested here, but `better-sqlite3` supports `:memory:` databases directly).
- **History store**: TS `MemoryHistoryManager.ts` is a bare in-memory `Map<string, HistoryEntry>` — directly `JSON.stringify`-able, zero adapter work needed to keep it in RAM and snapshot it alongside the vector blob. Python's `SQLiteManager(":memory:")` gives the equivalent for the Python SDK.
- **Net assessment**: mem0 does **not** have a first-class "export whole engine state as one blob" API (no `dump()`/`load()` on `Memory`/`AsyncMemory`), but because both the default OSS vector store and the history store are single-file/in-process by design, dMemo can achieve the same effect *without modifying mem0* by controlling the file paths/`:memory:` handles ourselves and serializing those files — or by writing one `VectorStoreBase` implementation backed directly by 0G Storage (content-addressed writes = mem0's `insert`/`update`/`delete` map naturally onto append-only 0G Storage writes if we accept "one 0G Storage tx per mutation" or batch mutations into one snapshot write per flush cycle to match dMemo's async-flush model rather than the on-chain-tx-per-write model).

### LLM — point at 0G Compute router natively

- **Yes, no fork required.** `mem0/llms/openai.py:47-50`: `base_url = self.config.openai_base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"` → `OpenAI(api_key=api_key, base_url=base_url)`. Setting `llm.config.openai_base_url` (or `OPENAI_BASE_URL` env) to `router-api.0g.ai/v1` is sufficient, config-only. The TS SDK's OpenAI LLM adapter follows the same `openai` npm client construction pattern (confirmed via `mem0-ts/package.json` dependency on `"openai": "^4.93.0"`).
- Hermes's mem0 plugin already generalizes this exact pattern for arbitrary OpenAI-compatible endpoints — `hermes-agent/plugins/memory/mem0/_backend.py` OSS mode plus `_oss_providers.py`'s `base_url_key: "openai_base_url"` — i.e. a real-world precedent for "OSS mem0 + custom OpenAI-compatible router" already exists and works.

### Embedder — local by design (D6)

- Same `base_url` pattern exists for the embedder (`mem0/embeddings/openai.py:20-24`), but the 0G Compute router has **no** `/embeddings`-compatible endpoint: the router's full OpenAPI path list (17 routes: `/chat/completions`, `/messages`, `/images/*`, `/audio/transcriptions`, `/models`, `/providers`, `/account/*`, `/api-keys*`, `/routing/preview`, `/service-types`) has no `/embeddings` route (`followup-0g-endpoints.md`).
- **Settled (D6):** the embedder runs locally instead — Ollama auto-detected if running, else a bundled in-process model, never remote by default (this is what keeps dMemo's privacy claim intact on the embedder leg). Python side uses FastEmbed. mem0's embedder is a separate pluggable slot from the LLM (OpenAI `text-embedding-3-small`, local FastEmbed/ONNX, or Ollama `nomic-embed-text` are all drop-in options with zero engine changes), so this doesn't block the architecture — the LLM leg still points at 0G Compute (previous section); only the embedder leg runs locally.

### Running fully local/in-process

- **Yes.** `mem0.Memory` (Python) and the TS `Memory` (`mem0-ts/src/oss/src/memory/index.ts`, `class Memory`) are both plain in-process objects — no server process required for OSS mode. This is exactly the "embedded library" shape dMemo needs, confirmed further by three independent OSS-mode consumers already in the ecosystem: Hermes's `OSSBackend` (`from mem0 import Memory; Memory.from_config(config)`), the OpenClaw plugin's OSS mode (SQLite-backed, "no external database required"), and mem0's own `AsyncMemory` for async-native hosts (`docs/open-source/features/async-memory.mdx`: "keeps everything in-process for lower latency").
- TS confirms full async/await parity: "every method returns a `Promise` and must be `await`ed" — same shape as Python's `AsyncMemory`.

---

## 4. TypeScript story

- **npm package**: `mem0ai` (currently `3.1.1`), Apache-2.0, `main`/`module`/`types` all present, dual CJS/ESM build via `tsup`. Two import surfaces:
  - `mem0ai` (default) → `mem0-ts/src/client/*` — thin `MemoryClient` REST wrapper around the **Platform** API (`api.mem0.ai`).
  - `mem0ai/oss` → `mem0-ts/src/oss/*` — the **actual in-process OSS engine**, same shape as Python's `Memory`/`AsyncMemory`.
- **Feature parity with Python**: structurally very close — same phased-pipeline file layout (`memory/index.ts` `add()`/`addToVectorStore()`/`search()`, mirroring `main.py`), same provider-adapter directories (`llms/`, `embeddings/`, `vector_stores/`, `storage/`, `rerankers/`), same config shape (`{llm:{provider,config}, embedder:{...}, vectorStore:{...}}`). Not a stripped-down "client SDK only" port — it's a real second implementation of the engine, not a wrapper around the Python one.
- **Vector stores in TS OSS** (`mem0-ts/src/oss/src/vector_stores/`, 25 files): Qdrant, Pinecone, Chroma, Weaviate, Milvus, PGVector, Redis, Valkey, MongoDB, Elasticsearch, OpenSearch, Supabase, Cassandra, Azure AI Search, Azure MySQL, Baidu, Databricks, Neptune Analytics, S3 Vectors, Turbopuffer, Upstash Vector, Vertex AI Vector Search, Cloudflare Vectorize, LangChain — plus the in-process `memory.ts` (SQLite-file-backed) described above. All listed as `peerDependencies` with `peerDependenciesMeta.optional: true` in the **source tree**
— i.e. zero-cost to add a new provider without bloating the base install, at the `package.json`
level. **Caveat, verified in spike (mem0ai latest as of 2026-07)**: this is false of the
**published npm package** — the `mem0ai/oss` ESM bundle eagerly imports every backend at module
load, so a bare `npm install mem0ai` crashes on `import('mem0ai/oss')` with
`ERR_MODULE_NOT_FOUND` until `better-sqlite3` AND `pg` are also installed, regardless of which
vector store is actually configured. **Implication for dMemo**: our SDK must declare
`better-sqlite3` + `pg` as hard dependencies (or shim the eager imports) or plug-and-play install
breaks — the peer-optional pattern dMemo's own journaling wrapper (D7) registers through does not
currently hold at the published-bundle level.
- **LLM/embedder providers in TS**: OpenAI (bundled dependency), plus peer-optional Anthropic, AWS Bedrock, Azure, Google GenAI, Groq, Mistral, Ollama — same coverage story as Python, slightly smaller provider count for LLMs (no LiteLLM meta-provider equivalent, so 0G Compute is reached only via the OpenAI-compatible client construction, not via a meta-router).
- **Runtime**: Node ≥18, `better-sqlite3` for the local vector/history stores (native binding — worth checking against dMemo's target runtimes, e.g. if we ever need to run in edge/serverless environments without native module support).

---

## 5. Integration patterns for target agents

mem0 ships **first-party, actively maintained plugins for 4 of dMemo's 5 target agents** (all Apache-2.0, all in `integrations/`), plus Hermes already has a complete community-contributed one in its own repo.

| Target agent | Location | Mechanism | Memory backend modes |
|---|---|---|---|
| **Claude Code** | `integrations/mem0-plugin` (`.claude-plugin/plugin.json`) | Native Claude Code plugin: MCP server (`https://mcp.mem0.ai/mcp`) + lifecycle hooks (`hooks.json`) + Skills | Platform only via MCP (hooks call Platform API) |
| **Codex** | same `integrations/mem0-plugin`, two paths | (A) Direct MCP via `~/.codex/config.toml` `[mcp_servers.mem0]`; (B) sideload full plugin (MCP + skills + opt-in hooks via `~/.codex/hooks.json`, installed by `scripts/install_codex_hooks.py`) | Platform (MCP) |
| **OpenCode** | `integrations/mem0-plugin/.opencode-plugin/opencode-mem0.ts` | **Native OpenCode plugin, no MCP** — memory ops exposed as native OpenCode `tool()`s, calls `mem0ai`'s `MemoryClient` directly in-process | Platform (`MemoryClient`) |
| **OpenClaw** | `integrations/openclaw/` (separate published package `@mem0/openclaw-mem0`) | Native OpenClaw plugin, exclusive `memory` slot; ships 3 "skills" the agent invokes itself: **triage** (what to remember), **recall**, **dream** (periodic consolidation/cleanup) | Platform **or** OSS — OSS mode is explicitly "no Mem0 key needed... vectors stored locally in SQLite at `~/.mem0/vector_store.db`" |
| **Hermes** | `hermes-agent/plugins/memory/mem0/` (community PR #2933, adapted to Hermes's `MemoryProvider` ABC) | Formal `MemoryProvider` interface — `prefetch(query)` before each turn (backgrounded thread, `_PREFETCH_WAIT_SECS=3` hot-path budget), `sync_turn(user, assistant)` after each turn (backgrounded thread, `infer=True`), function-calling tools `mem0_search/add/update/delete`, circuit breaker (trip after 5 consecutive failures, 2-min cooldown) | Platform, self-hosted server (HTTP), **or** OSS (in-process `Memory`) — all three, operator-selectable |

**MCP server**: mem0 exposes `mcp.mem0.ai/mcp` (hosted, Platform-backed) — this is what Claude Code/Codex/Cursor consume. There is a separate `mem0ai/mem0-mcp` repo (per Context7 resolve) wrapping the same Platform API as MCP tools. **OpenMemory** (the standalone local-first MCP server + dashboard that used to live in this same monorepo, `openmemory/`) is **officially sunset** — its README states: *"OpenMemory is being sunset. For local self-hosted memory with a dashboard, please use the Mem0 self-hosted server instead (`cd server && make bootstrap`)."* Any dMemo design assuming OpenMemory as the local-first MCP path should redirect to `server/` (FastAPI + pgvector, Dockerized) instead.

### "Completion output → memory mutation" flow, and streaming

Two distinct capture strategies observed, neither taps token-level streaming for extraction (extraction always runs on the accumulated final text):

1. **Hook-driven, post-hoc transcript read** (Claude Code / Codex / Cursor via `integrations/mem0-plugin/scripts/`): the `Stop` hook (`on_stop.sh`) fires after the turn is written to the host's transcript, reads `transcript_path` from stdin JSON, backgrounds `capture_session_summary.py` (`&`, non-blocking, "fires every turn now, so avoid blocking"), which calls the mem0 API with `infer=True` for LLM extraction. `UserPromptSubmit` hook (`on_user_prompt.sh`) does the symmetric recall-injection before the next turn. Explicit guards: skip subagent sessions, skip if `auto_save=false`, skip if no API key — i.e. fail-open/no-op rather than fail-hard.
2. **In-process event callback** (Hermes, OpenCode, OpenClaw): `sync_turn(user_content, assistant_content)` called directly by the host loop once a turn completes (non-streaming, but called immediately after generation, not batched to session end) — Hermes explicitly runs this on a **daemon thread**, joins with a timeout on the *next* call to avoid duplicate ingestion, and treats `infer=True` add-latency as acceptable background cost, never blocking the user-facing response.
3. **Vercel AI SDK provider** (`integrations/vercel-ai-sdk`) is the one place resembling true request/response interception in the mem0 ecosystem: `createMem0()` wraps a Vercel AI SDK model; `addMemories`/`retrieveMemories`/`getMemories` are called explicitly around `generateText`/`streamText` calls by the application code (not an automatic transparent proxy) — the developer is responsible for wiring recall-injection and write-back around their own streaming loop.

---

## 6. Minimal subset & fit for dMemo's model

**What dMemo would actually use:**
- The `VectorStoreBase` (Python) / `VectorStore` (TS) interface — implement a thin **journaling wrapper** that delegates reads/search/writes to a native in-process store and records each mutation as a delta for the 0G flush layer (hybrid, settled as D7). Not a "pure" 0G-backed adapter: `search()` runs on every recall and 0G reads are blob downloads, not queries.
- The extraction pipeline (`add(..., infer=True)`) and its prompt (`ADDITIVE_EXTRACTION_PROMPT`/`FACT_RETRIEVAL_PROMPT`) — this is the actual "engine" value we can't easily replicate ourselves without reinventing prompt-tuned fact extraction.
- `search()` with hybrid vector+BM25 scoring and metadata filters — directly maps to "fetch memory at session start, inject into inference calls."
- The in-process/embedded run mode (`Memory`/`AsyncMemory`, no server) — matches "state lives in RAM during session."
- Possibly the SQLite history table, repurposed as the append-only audit trail that we then batch-flush to 0G Storage instead of leaving on local disk.

**What dMemo would NOT need:**
- The hosted Platform / MCP server / dashboard / webhooks / memory export (all platform-only, and dMemo replaces the "hosted" role with 0G Storage anyway).
- Most of the 23/25 vector store adapters — only the native in-process store (better-sqlite3 `memory.ts` / FAISS / `:memory:` SQLite) wrapped by dMemo's journaling `VectorStore` wrapper (hybrid, D7) matters.
- Reranker adapters (nice-to-have, not core).
- Graph memory (appears unimplemented in OSS regardless).
- The self-hosted `server/` FastAPI+pgvector dashboard — that's a full standalone deployment target, not a library we'd embed.
- Per-agent plugin *products* (Claude Code plugin, Codex plugin, etc.) — dMemo is building its own cross-agent SDK, but their **hook lifecycle names and patterns** (`SessionStart`/`UserPromptSubmit`/`Stop`, `prefetch`/`sync_turn`, daemon-thread non-blocking writes, circuit breaker on repeated failures) are directly reusable design references, not code to fork.

**Latency characteristics — important for the write-back hook design:**
- `add(..., infer=True)` makes **one synchronous LLM call** (Phase 2, JSON-mode extraction) plus **one batch-embed call** (Phase 3) plus **one batch-embed call for entities** (Phase 7) — i.e. up to 3 network round-trips per `add()`, before the local vector-store writes. This is not fast enough to sit in the hot path of a response.
- Every first-party integration treats this as background work: Hermes explicitly documents `sync_turn()` "must be non-blocking — spawn a daemon thread"; the Claude Code plugin's `Stop` hook backgrounds capture with `&` and a 30s timeout; mem0's own docs note Platform-mode `add` is async server-side ("event_id" returned, not the final result).
- **Implication for dMemo**: the "apply completion outputs as in-memory mutations, asynchronously flush to 0G Storage" model is a *very close match* to how every mem0 integration already treats writes — but note mem0's `infer=True` extraction call happens **before** the vector-store mutation (it's what decides what to write), whereas dMemo's "mutation" already exists in-memory from the completion output. If dMemo wants LLM-based fact extraction (vs. raw verbatim storage), that extraction step is the same unavoidable async LLM round-trip mem0 already isolates to a background thread — reuse that pattern rather than inventing a new one. If dMemo doesn't want a second LLM call per turn (cost/latency), `infer=False` (verbatim storage, embed-only, no LLM call) is a first-class mem0 mode — faster, cheaper, no fact-extraction quality but avoids double LLM calls when the assistant's own completion already *is* the distilled content.

---

## 7. Fit assessment

| Property | Status |
|---|---|
| Engine open source | ✅ Apache-2.0, full pipeline in `mem0/` + `mem0-ts/src/oss/` |
| Storage pluggable | ✅ formal `VectorStoreBase`/`VectorStore` ABC, 23-25 implementations, clear scoring contract |
| LLM → OpenAI-compatible endpoint | ✅ (`openai_base_url` config, code-verified in both langs) |
| Embedded/in-process run mode | ✅ genuinely in-process (`Memory`/`AsyncMemory`, no server) |
| GitHub stars / activity | ~60k stars, 389 contributors, commits same-day as this research |
| What we'd fork | The **engine itself** (extraction pipeline, vector-store abstraction, provider adapters) — the same per-agent plugin patterns are available as reference (Hermes, OpenClaw, Claude Code plugin) |

We inherit a real, actively-maintained, Apache-2.0 extraction/retrieval engine with a genuine storage abstraction seam — a small build (implement one `VectorStoreBase` adapter + point LLM/embedder `base_url` at 0G Compute) — at the cost of coupling to mem0's data model, prompts, and release cadence, and inheriting whatever's *not* pluggable (e.g. the SQLite history table isn't behind the same clean interface as the vector store — handled via D5's swept-into-blob approach rather than a separate adapter). Community health (60k stars, 389 contributors, same-day commits) gives confidence the OSS path stays maintained rather than starved in favor of the hosted product — reinforced by the fact that mem0's own team builds and ships first-party OSS-mode integrations (OpenClaw's "no Mem0 key needed... local SQLite" is explicitly marketed, not an afterthought).

**Open items to verify before committing:**
1. Whether the 0G Compute router (`router-api.0g.ai/v1`) serves an OpenAI-compatible `/embeddings` endpoint — not confirmed from the cloned 0G repos; if absent, plan for a secondary embedder provider (OpenAI, local FastEmbed, or Ollama).
2. Whether dMemo wants to reuse mem0's `infer=True` LLM-based extraction (extra LLM round-trip, higher quality) or treat the agent's own completion as the memory content directly (`infer=False`, faster/cheaper) — both are native, zero-fork mem0 modes.
3. Whether a custom `VectorStoreBase`/`VectorStore` implementation should also assume responsibility for the history/audit table, or whether dMemo is fine leaving that as a local SQLite file that gets swept into the same 0G Storage snapshot blob as the vector data.

---

## Decisions (settled)

Resolves this report's open items 1–3 (embeddings endpoint: absent on Router; infer mode: user toggle; history table: swept into same blob).

| # | Decision | Detail |
|---|---|---|
| D1 | Memory engine: **mem0 OSS**, in-process | `mem0ai/oss` (TS) / `mem0` (Python). Not supermemory (engine closed), not custom-built |
| D5 | History table: in-RAM, same blob | TS `MemoryHistoryManager` (Map) / Python `SQLiteManager(":memory:")`. Serialized into the same delta/checkpoint blob. No adapter, no patch |
| D6 | Embedder: local, dual option | Auto-detect: Ollama if running, else bundled in-process ONNX. Explicit config override. Embedder identity pinned in state metadata; switch → auto re-embed migration. Remote embeddings never by default (breaks privacy claim). Python side: FastEmbed. 0G Router has **no** `/embeddings` (verified) |
| D7 | **Hybrid store: journaling `VectorStore` wrapper around mem0's native stores** | Native in-process stores (better-sqlite3 `memory.ts` / FAISS / `:memory:` SQLite) serve reads/search untouched; a thin wrapper implementing the same `VectorStore`/`VectorStoreBase` interface delegates to them and journals each insert/update/delete as a delta for the 0G flush layer (D3). Deltas use dMemo's canonical cross-language blob format (D16), never raw engine files; history swept from RAM into the same delta (D5). All hosts are Node/Python desktop-CLI. Flow sketch: `SYNTHESIS.md` §3a |
| D16 | Dual-native SDKs, staged; no bridge | TS (`mem0ai/oss`) in v1.0, Python (`mem0` + FastEmbed) in v1.1. Sidecar/RPC bridge rejected as custom glue. Single cross-language contract = the **encrypted blob spec** (delta/checkpoint serialization), designed in v1.0 with Python compat in mind |
| D17 | `infer` = user toggle | Exposed per memory instance. Default `false` (verbatim; no 2nd LLM call — right for coding agents). Phase-0 C3 validates the default |
