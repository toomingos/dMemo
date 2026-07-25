# @dmemo/opencode-plugin

OpenCode host adapter for dMemo (T3.2). Forked from mem0's
`opencode-mem0.ts` (D18) with the mem0-Platform client replaced by an
in-process `@dmemo/core` `DmemoSession`. Private, encrypted, portable memory
backed by 0G Storage — no external memory service, no API key required for
the memory leg itself.

## Install / load

Build produces a standard ESM npm package (`dist/index.js` + `.d.ts`).
Publish it (or reference it locally) and load it from `opencode.json`'s
`"plugin"` array — OpenCode resolves and auto-installs npm-named plugin
entries at startup:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@dmemo/opencode-plugin"]
}
```

## Runtime (Bun)

OpenCode runs plugins **in-process under Bun**, and installs plugin
dependencies with `bun install` at startup. That matters because `mem0ai/oss`
imports `better-sqlite3` at module scope, and `better-sqlite3` is a V8 C++
addon — a surface Bun does not implement
([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)). Loading it
under Bun **aborts the whole OpenCode process** (`panic(main thread): NAPI
FATAL ERROR: …`); it is not a catchable error, so the plugin's fail-open path
cannot save you from it.

`@dmemo/core` handles this: `DmemoSession.open()` routes `better-sqlite3` to
Bun's built-in `bun:sqlite` before mem0 is imported. Nothing to configure —
just make sure the plugin resolves a `@dmemo/core` that includes this fix.
If it can't be installed, `open()` throws instead of aborting, and the plugin
falls back to its normal no-op behavior (memory disabled, host unharmed).

Verified end-to-end on Bun 1.2.18 and 1.3.14 (macOS arm64): `opencode serve`
boots with the plugin loaded, restores the memory chain, and answers from
`dmemo_search`.

## Configuration (fail-open)

The plugin reads dMemo config from the environment via `@dmemo/core`'s
`loadConfigFromEnv` (`DMEMO_PRIVATE_KEY`, `DMEMO_NETWORK`, `DMEMO_INFER`,
etc.). If required config (e.g. `DMEMO_PRIVATE_KEY`) is missing, or opening
the session fails for any reason (RPC unreachable, unfunded wallet, decrypt
failure against pre-existing incompatible chain data), `createDmemoPlugin`
returns an **empty hooks object** — the plugin becomes a no-op and never
breaks the host. This is verified by unit tests (`src/index.test.ts`).

`infer` defaults to `false`: capture is verbatim (no second LLM call) unless
explicitly opted in.

Optional: `DMEMO_OPENCODE_SCOPE` overrides the default per-(user, project)
scope string (`opencode:<osUser>:<projectDirName>`) — useful for monorepos
where the directory name collides across projects.

Optional: `DMEMO_OPENCODE_CAPTURE_EVERY` sets how many completed turns pass
between captures. The default is `1` — **every turn is captured**; set it to
`3` to sample every 3rd turn instead. Values that aren't a positive integer
fall back to the default rather than throwing — config must never break the
host.

Sampling is not the cost lever it looks like. `memory.add` is local (verbatim
under `infer: false`: one fastembed embedding + a SQLite write, no LLM call),
and the on-chain spend comes from `flush()`, which **self-coalesces** — flushes
are chained sequentially and each drains the journal up front, so any flush
queued behind an in-flight upload finds an empty journal and returns without
uploading. Cost is bounded by roughly one blob per upload round-trip (measured
10–13.5s), not one per turn. Raising this value drops turns permanently without
buying a proportional saving.

## Inference routing (optional, separate from the memory leg)

dMemo's memory leg (embedding, encryption, 0G Storage) never requires a
Router key. If you also want OpenCode's own chat inference routed through
the 0G Compute Router (e.g. to test against 0G-hosted models), register it
as a custom OpenAI-compatible provider in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@dmemo/opencode-plugin"],
  "provider": {
    "0g": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "0G Router (testnet)",
      "options": {
        "baseURL": "https://router-api-testnet.integratenetwork.work/v1",
        "apiKey": "{env:ZEROG_API_KEY}"
      },
      "models": {
        "qwen2.5-omni": { "name": "Qwen 2.5 Omni (TeeTLS, testnet)" }
      }
    }
  }
}
```

Notes:
- The Router speaks `/v1/chat/completions` (OpenAI-compatible), hence
  `@ai-sdk/openai-compatible`, not `@ai-sdk/openai` (which targets the
  `/v1/responses` shape).
- Mainnet Router: `https://router-api.0g.ai/v1`.
- Testnet model catalog drift (verified live 2026-07-25, see `TASKS.md`):
  the spec-era `qwen/qwen2.5-omni-7b (TeeML)` id no longer exists. The
  current testnet chat model is `qwen2.5-omni` (TeeTLS, not TeeML) —
  TeeML-pinned chat is currently unavailable on testnet. Re-check
  `GET {baseURL}/models` before hardcoding a model id; Claude models are
  mainnet-only via the Router.
- `apiKey` is a Router `sk-...` key (`ZEROG_API_KEY` env var), unrelated to
  the dMemo wallet private key used for the memory leg.

## What this plugin does

- **Injection (every turn):** `chat.message` searches memory for the
  incoming user text; `experimental.chat.messages.transform` unshifts a
  `dMemo Memory Context` text block into the newest user message if any
  results were found. Fails open (search error → transcript untouched, no
  throw). The queued context between the two hooks is kept **per OpenCode
  session** (in `SessionTurnTracker`, alongside the F5 cadence state) — one
  plugin instance serves every session on the server, so a single shared
  queue would let one session's injected memory leak into another's prompt
  under interleaving. `transform`'s own input carries no `sessionID`, so the
  owning session is recovered from `output.messages[].info.sessionID`
  instead; if that can't be resolved unambiguously (missing, or messages
  disagree), the queued context is **dropped**, never guessed — a missed
  injection degrades one answer, a misdelivered one leaks another session's
  private memory. See gotcha 27 in `TASKS.md`.
- **Capture:** deterministic, verbatim (`infer: false` by default) capture
  on the native `event` hook, driven off the **turn boundary** — the session
  going idle, which OpenCode emits exactly once per turn once the runner has
  drained every queued step. Both spellings are accepted (`session.status`
  with `status.type === "idle"`, and the deprecated-but-still-emitted
  `session.idle`); turns are counted **per session** and deduped per
  assistant message ID, so the overlapping pair counts once. **Every turn is
  captured** by default; `DMEMO_OPENCODE_CAPTURE_EVERY` samples instead. Also
  proactively captured pre-compaction (see below) so nothing is lost right
  before the host prunes context.

  > Do **not** count `message.updated` events here. It fires *twice* per
  > assistant message and once per *step*, so a turn with one tool call
  > emits 4 of them — measured on OpenCode 1.18.5. The previous cadence did
  > exactly that and therefore captured 2 of every 3 turns instead of 1, and
  > could capture a `finish:"tool-calls"` step whose text is still empty
  > (storing a prompt with no answer). See gotcha 25 in `TASKS.md`.
- **Compaction:** wired on the **native** `experimental.session.compacting`
  hook (not a synthetic file-writing shim). Trigger math ported from
  opencode-supermemory: token-ratio ≥ 0.80 of the model's context window
  **and** ≥ 50,000 total tokens, with a 30s cooldown between triggers (the
  cooldown clock is per-session — one plugin instance serves every session
  on the server).
  Captures the last assistant turn and injects a short recall note
  (`dmemo_search`) into the compaction context.
- **Manual tools:** `dmemo_search` and `dmemo_add` (two-tool convention).
  The four mem0-Platform-only tools from the fork base
  (`autoSetupCategories`, `delete_entities`, `list_entities`,
  `get_event_status`) are **not ported** — dMemo has no Platform surface.
- **Scope:** `resolveFilters`/`scope.ts` rewritten from mem0-Platform's
  `{AND:[...]}` REST DSL to mem0-OSS's flat `SearchFilters`
  (`{user_id?, agent_id?, run_id?}`); write side uses OSS `Entity`
  (camelCase `{userId?, runId?}`). `"session"` scope narrows to the current
  OpenCode session via `run_id`/`runId`; the default `"project"` scope
  searches everything captured for the opened dMemo chain.
- **Lifecycle:** `dispose` awaits any pending flush, then closes the
  session cleanly.

## Development

```bash
pnpm run build   # tsc -b
pnpm test        # node --test against dist/*.test.js (mocked, no network)
pnpm run live    # scripts/live-integration.mjs — REAL DmemoSession on
                 # 0G testnet; funds a fresh ephemeral wallet from
                 # spike/.env (small spend); never prints any private key
```
