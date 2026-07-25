# dMemo — Research Synthesis & Map

Synthesized from the 10 reports in `/research` (2026-07-24). Each claim below is backed by the
referenced report; see those files for doc/code citations.

---

## 1. The big picture

```
                        ┌──────────────────────────────────────────────┐
                        │                dMemo core SDK (TS)            │
                        │                                               │
   per-host adapters    │  ┌─────────────┐   ┌───────────────────────┐  │
  ┌──────────────────┐  │  │ Session      │   │ 0G clients            │  │
  │ Hermes plugin     │──┼─▶│ memory state │   │  storage: MemData +   │  │
  │ (MemoryProvider)  │  │  │ (in-memory,  │   │   indexer.upload/     │  │
  ├──────────────────┤  │  │  ephemeral)  │   │   downloadToBlob      │  │
  │ OpenClaw plugin   │──┼─▶│              │   │   + ECIES encryption  │  │
  │ (memory slot)     │  │  │ fetch ─────▶ │   │  compute: OpenAI SDK  │  │
  ├──────────────────┤  │  │ inject       │◀──┤   baseURL=router-api  │  │
  │ OpenCode plugin   │──┼─▶│ accumulate   │   │   .0g.ai/v1           │  │
  │ (chat.message/    │  │  │ write-back ─▶│   └───────────────────────┘  │
  │  event hooks)     │  │  └─────────────┘                              │
  ├──────────────────┤  └──────────────────────────────────────────────┘
  │ Claude Code hooks │            │                      │
  │ (SessionStart/    │            ▼                      ▼
  │  Stop/SessionEnd) │      0G Storage             0G Compute Router
  ├──────────────────┤   (encrypted snapshots,    (OpenAI-compatible,
  │ Codex hooks       │    append-only log)        TEE providers)
  │ (SessionStart/    │
  │  Stop)            │
  └──────────────────┘
```

**The single most important architectural fact:** dMemo's memory engine is **mem0 OSS**,
embedded in-process (D1/D7) — the original plan to fork supermemory was dropped because
supermemory's engine (ingestion/chunking/embedding/graph) is closed-source, leaving only its
client SDKs and per-agent plugins open. Per-host fork bases are settled per D18
(`followup-fork-bases.md`).

**Engine resolution (`mem0.md`):** mem0's engine IS fully open (Apache-2.0, ~60k stars,
same-day commits): fact-extraction pipeline, embedding, vector storage, retrieval — in both
Python and a real TS implementation (`mem0ai/oss` npm). It runs fully in-process (no server),
has a formal `VectorStoreBase`/`VectorStore` adapter seam (23–25 existing implementations) we
can implement for 0G, and its LLM calls take an OpenAI-compatible `base_url` → 0G Router
config-only. **Settled engine (D1/D7): embed mem0 OSS + a journaling `VectorStore` wrapper
around its native in-process stores (hybrid)** — native stores serve search untouched, the
wrapper journals mutations as deltas for the 0G flush layer (see §3a flow) — instead of
building our own store. Per-host glue forks mem0's own first-party plugins where they exist,
with a merged Node adapter for Claude Code/Codex (D18, `followup-fork-bases.md`).
Caveats: 0G Router has **no `/embeddings` endpoint** (verified against the router OpenAPI
spec) → use a local embedder (FastEmbed in Python; Ollama or a small local adapter in TS) so
plaintext never leaves the machine; the TS in-process vector store is a single SQLite file →
serves search locally and serializes into the periodic checkpoint, while the wrapper's journal
supplies the per-completion deltas (D3/D7); `infer=false` (verbatim,
no extra LLM call) vs `infer=true` (fact extraction, +1 LLM round-trip, always backgrounded)
are both native modes — pick per write-back path.

**Second most important:** every write to 0G Storage — file or KV — is **one on-chain,
gas-paying transaction with block-confirmation latency**, and the KV layer requires a
self-hosted Rust daemon (`zgs_kv`) with no official hosted endpoint (`0g-storage.md`). This
forces the sync-engine design in §3.

---

## 2. Integration map per target agent

Fork-base column per D18 (`followup-fork-bases.md`).

| Agent | Inference via 0G | Memory recall (fetch+inject) | Memory capture (write-back) | Fork base (D18) | Status |
|---|---|---|---|---|---|
| **Claude Code** | ✅ first-class `/v1/messages` on 0G Router (verified, `followup-0g-endpoints.md`) | `UserPromptSubmit` deterministic prefetch + `SessionStart` → `additionalContext` | `Stop` hook (background), `PreCompact` capture | **Merge**: `claude-supermemory` packaging (esbuild `.cjs`, single client seam) + `mem0-plugin` deterministic prefetch/guards | **Green** — v1.0 (D15) |
| **OpenCode** | ✅ native: `provider.<id>` + `@ai-sdk/openai-compatible` | `chat.message` + `chat.messages.transform` (every turn) | every-3rd-msg auto-add + `experimental.session.compacting` | `mem0-plugin/.opencode-plugin/opencode-mem0.ts` — swap `MemoryClient` → in-process OSS `Memory`, strip 4 Platform-only tools | **Green** — v1.0 (D15) |
| **OpenClaw** | ✅ native: `models.providers.<id>.baseUrl`, `api: openai-completions` | `before_prompt_build` hook (deterministic in default `smart` strategy) | `agent_end` hook; exclusive `plugins.slots.memory` | `@mem0/openclaw-mem0` — only first-party plugin with real OSS mode; swap OpenAI defaults → local embedder + 0G Router | **Green** — v1.0 (D15) |
| **Codex** | ❌ memory-only: no `/v1/responses` on Router (D10, `followup-0g-endpoints.md`) | `UserPromptSubmit` / `SessionStart` (CC-schema-compatible) | `Stop` hook; disable native `memories.*` | Same merged Node adapter as Claude Code + `mem0-plugin`'s idempotent `install_codex_hooks.py` pattern (12s hook timeouts) | **Green (memory leg)** — v1.0 memory-only (D15) |
| **Hermes** | ✅ native: `provider: custom` + `base_url` | `MemoryProvider.prefetch()` | `sync_turn()` / `on_session_end()` | bundled `hermes-agent/plugins/memory/mem0` (OSS backend; copy as `dmemo` provider) | **Green** — v1.1 (D15, Python SDK per D16) |

Key cross-host insight: **Codex hooks are deliberately Claude-Code-schema-compatible**
(same event names, same `additionalContext` output shape, same permission-mode vocabulary —
`codex.md`), so one hook adapter covers both coding CLIs with minimal changes — now proven in
production by mem0-plugin, whose Codex sideload reuses the identical scripts
(`followup-fork-bases.md` §2). Both CLIs spawn hooks as fresh subprocesses, so the in-process
store is opened per hook call — fine for the SQLite-file store D7 already selects.

Memory integration works **independently of inference routing** for every host — a user can run
Claude Code on Anthropic's API but still get dMemo private memory. The two legs should ship as
separable features.

## 2b. Inference leg (settled)

- Use the **0G Router**: `https://router-api.0g.ai/v1`, plain `Authorization: Bearer sk-...`,
  fully OpenAI-compatible incl. SSE streaming (`0g-compute.md`). No wallet in the request path.
- Set `X-0G-Provider-Trust-Mode: private` (TeeML-only routing) to make the "private inference"
  claim true (`0g-compute.md`, `dai-values.md` §C.4). `GET /v1/models` (no auth) exposes a
  `verifiability` field to filter TeeML models programmatically.
- `verify_tee: true` for audit logging; SDK `processResponse()` (EIP-191, throwaway wallet OK)
  as opt-in zero-trust escalation. Don't build routing/failover — Router does it.
- Direct SDK path (`@0gfoundation/0g-compute-ts-sdk`) is fully scriptable but heavier; only
  needed if Router can't serve a use case.

## 2c. SDK wrapper leg (settled)

For devs using raw OpenAI/Anthropic SDKs (not one of the 5 hosts):

- **Primary: custom `fetch` wrapper** — works identically on both SDKs and is the only pattern
  confirmed against 0G's documented OpenAI-shaped surface (`sdks.md`).
- **Streaming write-back: `Stream.tee()`** (native, identical in both SDKs) or the
  `finalChatCompletion`/`finalMessage` events; port supermemory's `TransformStream`-tap pattern
  from `packages/tools/src/openai/middleware.ts` (`supermemory.md` §c-3).
- Anthropic's native `middleware` (v0.101.0+) is a nicer secondary path, but only reachable if
  an Anthropic-shaped endpoint exists (direct Anthropic, or 0G `/v1/messages` if confirmed).

---

## 3. Cross-cutting: the Convex-style sync + ephemeral model on 0G

The question: does 0G Storage's latency/consistency support *fetch-at-runtime → in-memory only →
discard, with completion output as an automatic mutation* — and where does the sync engine live?

**Answer: yes, but only as a client-side, session-batched snapshot log — not as a Convex-style
live-mutation database.** The constraints that force this:

| 0G constraint (from `0g-storage.md`) | Design consequence |
|---|---|
| Every write = 1 on-chain tx (gas + block confirmation) | Cannot write per-mutation. Accumulate mutations **in memory** during the session; flush **one batched encrypted write per turn-end (fire-and-forget) or session-end** |
| Log layer is append-only, content-addressed (rootHash) | Memory state = a chain of encrypted snapshots/deltas. "Update" = upload new blob, advance a pointer |
| KV layer needs self-hosted `zgs_kv` daemon; no official hosted endpoint | KV cannot be the plug-and-play source of truth. **Open decision: pointer strategy** (see §5) |
| Reads by rootHash are fast (storage nodes + optional HotRouter prefetch); no auth on download | Fetch-at-session-start is viable; secrecy is 100% the encryption's job |
| Write→read visibility has block-time latency | Same-session read-your-writes must come from the **local in-memory state**, never from re-fetching 0G |

So the sync engine **lives entirely in the dMemo client SDK**, and the loop per session is:

```
session start:  resolve latest rootHash → downloadToBlob → self-verify Merkle root (D9) →
                decrypt → plaintext memory in RAM only
per turn:       host hook injects relevant slice into the prompt
                completion output → mutation applied to in-RAM state (instant read-your-writes)
                async: encrypt + upload delta/snapshot (fire-and-forget, non-blocking —
                matches every host's "hooks must not block" contract)
session end:    final flush + pointer advance → wipe RAM. Nothing persists locally.
```

This is "Convex-like" in the developer experience sense (mutations are automatic, state feels
synced) but the honest description is **eventually-durable ephemeral memory**: durability lags
the conversation by one async write. Failure mode to design for: crash between completion and
flush loses at most the un-flushed turns — acceptable for memory, and exactly why batching to
session-end (rather than per-turn) is the right trade for quality anyway.

### 3a. The hybrid store (D7) — how the loop is realized

Neither a "pure" 0G-backed `VectorStore` adapter (0G reads are blob downloads, not queries —
search can't hit the chain) nor a raw-file snapshot of mem0's native stores (no deltas; blob =
opaque engine file, breaks the D16 cross-language spec). Instead: a thin journaling wrapper
that **implements mem0's `VectorStore` interface and delegates to the untouched native store**.

```
SESSION START
  resolve rootHash (eth_getLogs)  [D8] ──▶ download checkpoint + deltas ──▶ decrypt [D9]
        │ replay into native store (temp / :memory:)
        ▼
PER TURN
  mem0.search() ──▶ wrapper ──▶ delegates to native store (full BM25+cosine, in-process)
  mem0.add()   ──▶ wrapper ──▶ ├─ delegates write to native store
                               └─ appends mutation to journal
FLUSH (async, per completion)  [D4]
  encrypt(journal delta) ──▶ indexer.upload ──▶ 0G (1 tx)   ← small, canonical format [D16]
  every K flushes: serialize full state ──▶ checkpoint      [D3]
  history swept from RAM into the same delta                [D5]

SESSION END
  final flush ──▶ wipe RAM + temp file
```

Why hybrid: the history store is *not* behind the vector-store ABC, so an external serializer
exists no matter what (D5); the wrapper adds mutation-level visibility (deltas for D3) and a
canonical blob format (D16) while reusing the native store's search — the least total custom
code of the three options considered (`mem0.md` D7).

Latency budget check (the reports' shared open worry): only the **read at session start** is on
the critical path — one indexer download + local decrypt. Writes are async by construction.
Hosts with tight prefetch expectations (Hermes) provide `queue_prefetch()`; OpenClaw hook
timeouts are configurable. Needs one live benchmark on testnet, not more research.

## 4. Values checklist → concrete build decisions (from `dai-values.md`)

1. **ECIES-to-wallet-pubkey as default encryption** — the payment wallet doubles as the memory
   key; zero extra secrets (native in `0g-ts-sdk`).
2. **Self-verify Merkle root on every download (D9)** — AES-CTR has no auth tag; the SDK's
   `with_proof` flag is a no-op, so dMemo recomputes the blob's Merkle root and compares it
   against the on-chain root.
3. **Pin to TeeML providers** (`X-0G-Provider-Trust-Mode: private`) or disclose mode per
   provider; TeeTLS leaks prompts to the upstream LLM vendor.
4. **"Forget" = crypto-shred + tombstone, never "deleted."** Do not port supermemory's
   `DELETE /v4/memories` semantics/wording as-is.
5. **Key-custody design doc for always-on agents** before shipping coding-agent integrations
   (where the wallet key lives when no human is present).
6. Disclose plainly: metadata (writer address, size, cadence) is public on-chain even with
   perfect encryption; key loss = permanent memory loss.

---

## 5. Open items

### Resolved by follow-up agents
1. **0G endpoint shapes** (`followup-0g-endpoints.md`): `/v1/messages` is a real, first-class
   Anthropic Messages implementation (router source: "For Claude Code client compatibility") —
   **Claude Code inference through 0G is unblocked**. `/v1/responses` does not exist — **Codex
   stays memory-only** (no shim recommended). `/v1/models` exposes `verifiability`
   (TeeML/TeeTLS) + `tee_attested` → TeeML pinning is programmable. Headless first-credential
   minting: leans NO — one interactive pc.0g.ai sign-in remains in setup.
2. **Claude Code packaging** (`followup-claude-code-packaging.md`): plugins bundle
   hooks+MCP+skills+commands; two-command install via marketplace; same plugin dir loads in the
   Agent SDK via `options.plugins`. Ship a dMemo marketplace repo; skip MCP in v1; esbuild-bundle
   hooks to dependency-free `.cjs` (no npm install after plugin-cache copy).
3. **Pointer strategy** (`followup-pointer-strategy.md`), live-verified on testnet:
   - `FixedPriceFlow.Submit` indexes `sender` → **`eth_getLogs` filtered by own wallet decodes
     `submissionIndex` (the storage-layer txSeq) from the log, then resolves the file root via
     storage-node `getFileInfoByTxSeq`: `indexer.selectNodes(1)` → `node.getFileInfoByTxSeq(txSeq)`
     → `fileInfo.tx.dataMerkleRoot`** — zero extra infra, 173ms live for discovery. **Corrected**:
     `nodes[0].root` in the Submit event is only a subtree root, not the file root, whenever chunk
     count isn't a power of two (spike, c2-blob.mjs, live testnet run) — do not decode the root
     hash directly from the log. Public RPC caps ranges at ~4.78M blocks (~22 days) → cache last
     `{block, txSeq, rootHash}` client-side; optional tiny `wallet → rootHash` pointer contract
     (ERC-7857 INFT precedent) for O(1) cold starts. Ranking: getLogs+cache > pointer contract >
     operated 0G-KV > indexer API (doesn't exist).
   - ⚠️ **`with_proof` is a no-op in the current ts-sdk** (`Downloader.ts` `// TODO: add proof
     check`) — Merkle verification is NOT implemented despite docs. dMemo must re-verify the
     content-addressed hash of downloaded ciphertext itself (updates values decision §4.2).
   - Cost: `pricePerSector` ≈ 3.07e-8 0G; storage fee for a ≤256KB write is negligible
     (~0.0000005–0.00003 0G) — per-write cost is dominated by tx gas, confirming batch-per-turn.
     **Measured (spike, c1b-fund-and-chat.mjs, live testnet run)**: one flush of a 2,169-byte
     encrypted blob cost **0.00125 0G gas + 0.00000028 0G storage fee (tx.value)**, total
     ≈**0.00125 0G** — gas-dominated, confirming the D2 prediction of ~0.001 0G/flush
     (tx `0xb502164c…`).

4. **mem0 engine** (`mem0.md`): full engine is genuinely open (Apache-2.0), in-process, with
   a real storage-adapter seam and TS parity — recommended as dMemo's engine (see §1).
   0G Router serves no `/embeddings` (verified) → local embedder. Remaining mem0-related
   decisions: `infer` mode per write path; whether the SQLite history table rides inside the
   same snapshot blob or gets its own adapter.
5. **Per-host fork bases** (`followup-fork-bases.md`, D18): fork `@mem0/openclaw-mem0`
   (OpenClaw), `opencode-mem0.ts` (OpenCode), Hermes's bundled mem0 provider (v1.1); Claude
   Code + Codex share one merged Node adapter — `claude-supermemory`'s packaging skeleton +
   mem0-plugin's deterministic behaviors + its Codex installer pattern. Codex's hook precedent
   is mem0-plugin's Codex sideload, which reuses the same scripts.

### Decisions for Tomás
- **Testnet vs mainnet as initial target.** Research says: testnet (Galileo, chain 16602) has a
  faucet and full parity of endpoints; Router has a testnet URL too. Recommend: build/benchmark
  on testnet, keep network as a one-env-var switch (the starter kit already works this way).
- **Onboarding gap to accept or fight:** the first Router API key appears to require one
  interactive pc.0g.ai sign-in (no documented headless mint) — "4 steps, 5 minutes" but not
  fully scriptable end-to-end today (`0g-compute.md`).
- Key custody model for always-on agents (needs its own design doc — see §4.5).

### Parked (needs a prototype, not research)
- Live latency benchmark: session-start fetch+decrypt on testnet vs host hook budgets.
- Smoke test: 0G Router streaming chunk shape vs `Stream.tee()`/helper parsers (`sdks.md`).
- Mutation-diffing design: no existing "smart diffing" implementation to reuse — design our
  own; likely simple append-log + periodic consolidation snapshot.

---

## Decisions (settled — full map closed)

All open questions are resolved. Per-topic decisions live at the bottom of their source report:
`mem0.md` (D1, D5–D7, D16, D17), `0g-storage.md` (D2–D4, D14), `followup-pointer-strategy.md` (D8, D9),
`0g-compute.md` (D10), `followup-0g-runtime.md` (D12), `dai-values.md` (D13),
`followup-fork-bases.md` (D18). Cross-cutting decisions:

| # | Decision | Detail |
|---|---|---|
| D11 | Memory leg ships separable from inference leg | Every host gets dMemo memory regardless of which API serves inference |
| D15 | **v1 host scope: tiered** | v1.0 = Claude Code, OpenCode, OpenClaw (memory + inference) + Codex (memory-only, `Stop` hook, 3s cap). v1.1 = Hermes (Python package per D16 in `mem0.md`) |
| D18 | **Per-host fork bases** | mem0 first-party where native-hook plugins exist (OpenClaw/OpenCode/Hermes); merged Node adapter for Claude Code + Codex. Detail: `followup-fork-bases.md` §4 |

## Deferred (own track, later)

| Item | Status |
|---|---|
| B5 — Key custody for always-on agents | Separate focused design session |
| B6 — Packaging (npm names, monorepo, Claude Code marketplace) | Map complete → unblocked. Research done: `followup-claude-code-packaging.md` |
| Tapp-TEE remote mode | v2 candidate, contingent on Tapp mainnet + multi-operator |

## Phase 0 spike (validates D3/D4/D6/D17)

- C1: session-start fetch+decrypt latency on testnet vs host hook budgets → tunes K
- C2: 0G Router streaming chunk shape vs `Stream.tee()`
- C3: end-to-end loop — mem0 OSS + journaling `VectorStore` wrapper (hybrid, D7) + delta/checkpoint flush; step 1: plain native-store snapshot to get the loop running, step 2: insert the wrapper for deltas. Sanity-check `infer=false` default
