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
  throw).
- **Capture:** deterministic, verbatim (`infer: false` by default) capture
  on the native `event` hook (`message.updated`, `role==='assistant' &&
  info.finish`), every 3rd assistant turn, deduped per assistant message
  ID. Also proactively captured pre-compaction (see below) so nothing is
  lost right before the host prunes context.
- **Compaction:** wired on the **native** `experimental.session.compacting`
  hook (not a synthetic file-writing shim). Trigger math ported from
  opencode-supermemory: token-ratio ≥ 0.80 of the model's context window
  **and** ≥ 50,000 total tokens, with a 30s cooldown between triggers.
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
