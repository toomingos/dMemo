# @dmemo/openclaw-plugin

OpenClaw host adapter for dMemo (T3.3). Forked from `@mem0/openclaw-mem0`'s
lifecycle shape (isolation scoping, deterministic `before_prompt_build`
recall, `agent_end` capture, dream-consolidation gate) with the OSS
`Memory` init's OpenAI-by-default embedder/LLM swapped for `@dmemo/core`'s
local embedder + `DmemoSession`'s 0G Storage flush/restore. All
mem0-Platform-only surfaces are stripped, not ported.

**Hard requirement, structural not conventional**: the shipped defaults can
never call OpenAI. Embedding is always local (`@dmemo/core`'s default
embedder); capture always passes `infer: false` to `memory.add()`
unconditionally — this plugin has no config knob that could produce a real
OpenAI call.

## Install

```bash
openclaw plugins install @dmemo/openclaw-plugin
```

Then register it in your OpenClaw config (standard
`plugins.entries.<id>.config` block, same shape every OpenClaw memory
backend uses):

```jsonc
{
  "plugins": {
    "slots": { "memory": "dmemo" },
    "entries": {
      "dmemo": {
        "config": {
          "privateKey": "${DMEMO_PRIVATE_KEY}",
          "scope": "default",
          "network": "testnet",
          "recall": { "strategy": "smart", "topK": 5, "timeoutMs": 10000 },
          "dream": { "enabled": true, "minHours": 24, "minSessions": 5, "minMemories": 20 }
        }
      }
    }
  }
}
```

`plugins.slots.memory` is exclusive — registering `"dmemo"` here takes over
recall/capture from whatever memory plugin (if any) owned the slot before.

`DMEMO_PRIVATE_KEY` — the easiest way to get this value is `npx dmemo
setup`, which writes it to `~/.dmemo/config.json`; export it into the
environment OpenClaw runs in, or paste the value directly (not
recommended — prefer the env-var interpolation form above).

## Config reference (`openclaw.plugin.json`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `privateKey` | string | — | 0x-prefixed hex. Required — no config, no memory (fails open, never throws). |
| `scope` | string | `"default"` | Base mem0 `user_id`. Per-agent sessions auto-namespace as `<scope>:agent:<agentId>`. |
| `network` | `"testnet" \| "mainnet"` | `"testnet"` | |
| `recall.strategy` | `"always" \| "smart" \| "manual"` | `"smart"` | |
| `recall.topK` | number | `5` | |
| `recall.timeoutMs` | number | `10000` | Raised from a generic default to clear T0.1's measured cold-restore time with headroom. |
| `dream.enabled` | boolean | `true` | Tags dream mutations `source: "dream"`; flushes a dream burst as one delta batch. |
| `dream.minHours` / `minSessions` / `minMemories` | number | `24` / `5` / `20` | Dream-consolidation gate thresholds. |

## Known limitation

`infer` is hardcoded to `false` unconditionally in this build — there is no
config knob that flips it, and setting one in a future version would need
`@dmemo/core`'s session-open seam to grow a real LLM slot wired to the 0G
Router first. See the `infer` field's doc comment in `src/config.ts` for
why: passing `infer: true` through today would make a **real** network call
to a placeholder OpenAI LLM config — exactly the "shipped defaults call
OpenAI" failure mode this plugin exists to prevent.

## Inference routing (optional, separate from the memory leg)

To route OpenClaw's own chat inference through the 0G Compute Router:

```jsonc
{
  "models": {
    "providers": {
      "zg": {
        "baseUrl": "https://router-api-testnet.integratenetwork.work/v1",
        "api": "openai-completions",
        "apiKey": "${ZEROG_API_KEY}"
      }
    }
  },
  "agents": { "defaults": { "model": { "primary": "zg/qwen2.5-omni" } } }
}
```

Testnet model catalog drift (verified live 2026-07-25): the spec-era
`qwen/qwen2.5-omni-7b (TeeML)` id no longer exists; the current testnet
chat model is `qwen2.5-omni` (**TeeTLS**, not TeeML — see
`docs/disclosure.md`). Re-check `GET {baseUrl}/models` before pinning a
model id in production. Mainnet Router: `https://router-api.0g.ai/v1`.

## Development

```bash
pnpm run build   # tsc -b
pnpm test        # node --test against dist/*.test.js (17/17, mocked, no network)
```
