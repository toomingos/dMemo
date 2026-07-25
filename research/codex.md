# OpenAI Codex CLI — Integration Research for dMemo

Scope: custom provider/baseURL routing, native memory attachment points (MCP, hooks, config, AGENTS.md), and prior art for a Codex memory sideload.

Repo cloned: `github.com/openai/codex` @ `89a3b89` (2026-07-24) into
`/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/codex`.

## (a) High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Codex CLI session lifecycle                     │
│                                                                            │
│  SessionStart ──▶ [AGENTS.md loaded, static, once] ──▶ UserPromptSubmit  │
│       │                                                        │         │
│       │ (hook: additionalContext injection)                    ▼         │
│       │                                            PreToolUse/PostToolUse │
│       │                                                (per tool call)   │
│       ▼                                                        │         │
│  inference call ──▶ model_providers.<id> (base_url, wire_api)  │         │
│       │                                                        ▼         │
│       └──────────────────────────────────────▶  Stop (end of turn)      │
│                                                        │                  │
│                                                        ▼                  │
│                                                  SessionEnd (teardown)    │
└─────────────────────────────────────────────────────────────────────────┘

Native OpenAI memory (separate, built-in, on by default):
  rollout (transcript) ──Phase1(extract)──▶ state DB ──Phase2(consolidate)──▶
  ~/.codex/memories/{raw_memories.md, MEMORY.md, memory_summary.md, skills/}
  (git-baselined local dir; uses OpenAI's own extract/consolidation models)
```

Best write-back points for dMemo, in order of fit:
```
Stop hook / SessionEnd hook ──(exec external command, gets transcript_path)──▶
   dMemo write-back process ──encrypt──▶ 0G Storage
                                              │
SessionStart hook ──(additionalContext)──▶ dMemo read process ──decrypt (0G Compute)──▶ inject
```
Alternatively/in addition: an MCP server (`mcp_servers.<id>`) exposing `search_memory`/`add_memory` tools the agent calls mid-turn — this is the pattern basicmemory.com uses, and is orthogonal to hooks.

## (b) Key Decisions and Why

### 1. Custom provider / baseURL to route inference through 0G

| Fact | Reference |
|---|---|
| `[model_providers.<id>]` in `~/.codex/config.toml` supports arbitrary `base_url`, `env_key`/`auth`/`aws`, custom headers, retry/timeout settings | `codex-rs/model-provider-info/src/lib.rs:89-144` |
| Provider IDs `openai`, `ollama`, `lmstudio` are reserved — cannot override the built-in `openai` provider's URL; must define a new provider id (e.g. `zerog`) | `codex-rs/model-provider-info/src/lib.rs:438-464`, confirmed via [OpenRouter blog](https://openrouter.ai/blog/tutorials/codex-cli-openrouter/) |
| **`wire_api = "chat"` was removed** (deprecated Feb 2026). Only `"responses"` (OpenAI Responses API shape) is valid now — deserialization hard-errors on `"chat"` | `codex-rs/model-provider-info/src/lib.rs:50,72-84` (`CHAT_WIRE_API_REMOVED_ERROR`) |
| Selection at runtime: `--profile <name>` (loads `$CODEX_HOME/<name>.config.toml`) or `-c model_provider=<id>` | learn.chatgpt.com/docs/config-file/config-reference (redirect target of `developers.openai.com/codex/config-reference`) |
| Env override shortcut: `OPENAI_BASE_URL` for the built-in `openai` provider only | Web search summary (morphllm.com, ofox.ai — verify directly before relying on it) |

**Decision implication for dMemo/0G:** Routing through `pc.0g.ai` is natively supported *if* 0G Compute exposes (or fronts via a thin proxy) an OpenAI **Responses API**-shaped endpoint — Chat Completions compatibility alone is no longer sufficient for Codex CLI. This is a hard native-config change (no code fork needed): add a `[model_providers.zerog]` block with `base_url`, `wire_api = "responses"`, and `env_key`. This matches the plug-and-play goal — zero SDK/code changes, just a `config.toml` block + `codex --profile zerog` or `-c model_provider=zerog`.

### 2. Native memory attachment points

**Two separate systems exist — do not conflate them:**

**(i) Codex's own native memory subsystem** (already built into core, on by default):
- Crates: `codex-rs/memories/{read,write}`, orchestrated from `codex-rs/core` (config wiring in `codex-rs/core/src/config/mod.rs:887-888,3339-3340,3925-3926`; task wiring in `codex-rs/core/src/tasks/mod.rs:139-152,649-772`; session wiring `codex-rs/core/src/session/session.rs:647-680`).
- Config: `MemoriesConfig` (`codex-rs/config/src/types.rs:323-355`) — `generate_memories: true`, `use_memories: true` by default, gated additionally behind `Feature::MemoryTool`.
- Pipeline (`codex-rs/memories/README.md:29-158`): Phase 1 extracts a structured memory per rollout (via the same model — `extract_model`/`consolidation_model`, defaulting to OpenAI's own models) into a local SQLite-ish state DB; Phase 2 consolidates into git-tracked plaintext files under `~/.codex/memories/` (`raw_memories.md`, `MEMORY.md`, `memory_summary.md`, `skills/`). Runs async in the background at session start, only for non-ephemeral, non-subagent sessions.
- **Not pluggable to an external/encrypted backend** — it's local filesystem + git, unencrypted, and calls whatever `model_provider` is configured for extraction/consolidation. It's a competitor to dMemo's memory loop, not an extension point for it.
- **Decision:** disable it (`memories.generate_memories = false`, `memories.use_memories = false` in config.toml) to avoid double-writing / conflicting with dMemo, and implement dMemo's own loop via hooks + MCP below. Confirm before shipping that disabling doesn't remove some other UX Codex depends on (e.g. `/memory` slash command) — not verified in this pass.

**(ii) Lifecycle hooks** — the real attachment point for dMemo, and it is Claude-Code-hook-schema-compatible by design:
- Full event list: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop` — `codex-rs/config/src/hook_config.rs:36-59`.
- Configured either as `~/.codex/hooks.json` / `<project>/.codex/hooks.json` (discovered per config-layer folder, `codex-rs/hooks/src/engine/discovery.rs:113-135,307+`) or inline `[hooks.*]` TOML tables in `config.toml` (documented equivalence: learn.chatgpt.com/docs/config-file/config-reference).
- **SessionStart** hook output supports `hookSpecificOutput.additionalContext` (free-text string injected into context) — exact same field name/shape as Claude Code — `codex-rs/hooks/schema/generated/session-start.command.output.schema.json:5-21`. This is the read-side injection point for dMemo.
- **Stop** hook input includes `session_id`, `turn_id`, `transcript_path`, `last_assistant_message`, `cwd`, `model`, `permission_mode` — `codex-rs/hooks/schema/generated/stop.command.input.schema.json`. `last_assistant_message` + `transcript_path` are exactly what a write-back process needs to summarize/store a completion as a memory mutation. Stop hooks can also `block`/request continuation (exit code 2 + stderr, or `{"decision":"block","reason":...}`) — `codex-rs/hooks/src/events/stop.rs:229-344`.
- **SessionEnd** hook fires on teardown but is deliberately capped at a **3-second max timeout** to stay inside the app-server's 5s shutdown budget (`codex-rs/hooks/src/events/session_end.rs:20-23`) — too tight for a full encrypt-and-upload-to-0G-Storage round trip. **Use `Stop` (per-turn, generous default timeout) for write-back, not `SessionEnd`.**
- `permission_mode` enum values (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`) are verbatim Claude Code's permission-mode vocabulary, reinforcing that this hook system was deliberately built to the same contract shape as Claude Code hooks — a dMemo hook adapter written for Claude Code should port with minimal changes.
- Admin lockdown exists: `requirements.toml` can set `allow_managed_hooks_only = true` to disable user/project hooks entirely (`docs/config.md:9-15`) — relevant if dMemo is deployed in managed/enterprise Codex environments.

**(iii) MCP servers** — the mid-turn retrieval/write tool-call surface:
- `[mcp_servers.<id>]` supports both local launcher (`command`) and **remote HTTP** (`url` + `bearer_token_env_var`) servers, per-tool `approval_mode` overrides — confirmed in `codex-rs/config/src/mcp_types.rs:1-120` (types) and learn.chatgpt.com/docs/config-file/config-reference (field names). CLI shorthand: `codex mcp add <name> <command...>` (`codex-rs/cli/src/mcp_cmd.rs`).
- Codex itself can also *be* an MCP server (`codex mcp-server`) for embedding in other hosts — separate from the above and not relevant to dMemo's memory injection (`codex-rs/docs/codex_mcp_interface.md:1-49`).

**(iv) AGENTS.md** — static only, not a write-back point:
- Discovery: `~/.codex` (`AGENTS.override.md` then `AGENTS.md`) → walk from git root down to cwd, same override/base pattern per directory; files concatenate root-to-leaf with closer files taking precedence.
- Loaded **once per session/run** at startup, not per-turn; 32 KiB combined cap (`project_doc_max_bytes`); purely static markdown, no templating/generation.
- Source: `learn.chatgpt.com/docs/agent-configuration/agents-md` (redirect target of `docs/agents_md.md:3` / `developers.openai.com/codex/guides/agents-md`).
- **Decision:** AGENTS.md is not suitable for live memory injection (once-per-session, static file). It's only useful as a place to point at how memory works (e.g. "dMemo hooks are active"), not as the injection mechanism itself.

### 3. Prior art for a Codex memory sideload: mem0-plugin's installer (D18 fork base)

| Finding | Detail |
|---|---|
| mem0-plugin ships a working Codex sideload — this is the settled fork-base component (D18) for the Claude Code + Codex merged Node adapter | `install_codex_hooks.py` idempotently writes/merges into `~/.codex/hooks.json`, wiring 6 hook events |
| Reuses Claude Code's hook scripts verbatim | Same scripts as the Claude Code manifest — confirms the CC-schema-compatibility finding in (b)(ii) above holds in production, not just by spec similarity |
| Codex-specific timeout tuning | Uses 12s timeouts on Codex (longer than the timeouts used elsewhere) — Codex is slower to fire hooks than Claude Code |
| Platform guard | Refuses Windows installs |

**Decision implication:** `install_codex_hooks.py`'s pattern — idempotent `hooks.json` merge, shared hook scripts with Claude Code, 12s Codex timeouts, Windows guard — is what dMemo's Codex installer is built from (D18, detail in `followup-fork-bases.md`). The `Stop`-hook write-back mechanism recommended in §(c) below gives a deterministic write guarantee: the write fires on turn completion rather than depending on the model deciding to call an MCP tool.

## (c) Recommended dMemo Integration Shape for Codex (native-only, no fork of Codex)

1. **Read path:** `SessionStart` hook (command handler) → dMemo fetches + decrypts relevant memory from 0G Storage via 0G Compute → returns `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext": "<memory>"}}` on stdout.
2. **Write path:** `Stop` hook (command handler, generous default timeout, not `SessionEnd`) → receives `transcript_path`/`last_assistant_message` → dMemo summarizes turn → encrypts → writes to 0G Storage as a memory mutation. Non-blocking: exit 0, no `decision:block` needed unless review is desired.
3. **Optional mid-turn retrieval:** register a `mcp_servers.dmemo` (local `command` launcher) exposing `search_memory`/`add_memory` tools for agent-initiated recall within a turn, orthogonal to the hooks-based read/write path above.
4. **Inference routing:** `[model_providers.zerog]` with `base_url = "https://pc.0g.ai/..."`, `wire_api = "responses"`, `env_key = "ZEROG_API_KEY"`; user selects via `codex --profile zerog` or `-c model_provider=zerog`. **Blocking requirement to verify with 0G:** does `pc.0g.ai` (or a thin proxy in front of it) speak the OpenAI Responses API shape? Chat Completions is no longer accepted by Codex CLI at all.
5. **Disable native memory** (`memories.generate_memories = false`, `memories.use_memories = false`) to avoid a competing unencrypted local memory store fighting with dMemo's 0G-backed one.

## Open Questions / Not Verified

- Whether 0G Compute's `pc.0g.ai` endpoint is Responses-API-shaped today, or would need a translation proxy (chat-completions → responses). This is a 0G-side question, not a Codex-side one — Codex's requirement is fixed and non-negotiable (`wire_api = "responses"` only).
- Whether disabling native `memories.*` fully removes all UX surface (e.g., a `/memory` slash command or memory-citation UI) or just stops background generation — not traced end-to-end in this pass.
- Exact behavior/latency budget expectations for `Stop` hook execution (default timeout value) — file exists (`codex-rs/hooks/src/events/stop.rs`) but the default timeout constant wasn't located; only `SessionEnd`'s 1s default / 3s cap was (`codex-rs/hooks/src/events/session_end.rs:20-23`). Worth confirming Stop's default before assuming it's "generous."
- No official OpenAI-published doc page enumerates the hooks system the way `docs/config.md` implies exists at `developers.openai.com/codex/config-reference` — the redirect target (`learn.chatgpt.com/docs/config-file/config-reference`) does cover it per the WebFetch summary above, but this wasn't independently re-verified against raw HTML (WebFetch summarized, not quoted verbatim in full).
