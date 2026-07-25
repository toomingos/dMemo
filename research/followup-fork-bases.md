# Follow-up: Per-Host Fork Bases After the mem0 Pivot (D18)

Scope: this doc covers the per-host fork-base decision (D18) for the mem0-based architecture —
which existing plugin/integration to fork or copy as the starting point for each host
(OpenClaw, OpenCode, Claude Code, Codex, Hermes). Findings come from code-level reads of mem0's
first-party integrations (2026-07-25, repos cloned at
`/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-…/scratchpad/repos/`), compared
head-to-head against the supermemory bases read in the first research pass. Hermes needed no
new read — its mem0 plugin was read code-level in `mem0.md` (§5).

Decision criterion: dMemo embeds **mem0 OSS in-process** behind the journaling `VectorStore`
wrapper (D1/D7). The best fork base is the one closest to *that* shape — deterministic
lifecycle hooks + an isolated client seam that an in-process `Memory` can slot into — not the
one with the most features.

---

## 1. Verdict table (D18)

| Host | Fork base | What to change | Loser & why |
|---|---|---|---|
| **OpenClaw** | `mem0/integrations/openclaw` (`@mem0/openclaw-mem0`) — fork outright | Swap OSS defaults in `providers.ts:247-326` (embedder `text-embedding-3-small`→local Ollama/bundled per D6; LLM `gpt-5-mini`→0G Router base_url) — defaults, not opt-ins. Insert D7 wrapper under its OSS `Memory` init | `openclaw-supermemory`: cloud-only, no OSS mode, no agent scoping, no dream analog |
| **OpenCode** | `mem0-plugin/.opencode-plugin/opencode-mem0.ts` — fork outright | Replace `new MemoryClient({apiKey})` (`:279`, single site) with in-process OSS `Memory` + D7 wrapper; strip 4 Platform-only tool integrations (`autoSetupCategories`, `delete_entities`, `list_entities`, `get_event_status`, `:139-173,580-626`); rewrite `resolveFilters`/`scope.ts` from Platform `{AND:[…]}` REST DSL to OSS `SearchFilters` | `opencode-supermemory`: first-message-only injection, dead `captureEveryNTurns` config, compaction bypasses native hook |
| **Claude Code** | **Merge**: `claude-supermemory` packaging skeleton + `mem0-plugin` deterministic behaviors | From claude-supermemory: single isolated client class (`SupermemoryClient`→dMemo core), esbuild-bundled dependency-free `.cjs` hooks (`scripts/build.js`), stdin/stdout JSON helpers, settings/auth layering. From mem0-plugin: deterministic top-5 prefetch on every `UserPromptSubmit` (`on_user_prompt.sh:160-179`) replacing supermemory's model-gated recall directive; guards (subagent-skip `on_stop.sh:26-29`, `MEMORY.md` write-block, Bash-error recall, PreCompact capture) | Neither alone: mem0-plugin — Bash+Python, smeared HTTP, venv/pip install (60-120s); claude-supermemory — recall is model-optional, not deterministic |
| **Codex** | Same merged Node adapter as Claude Code (hooks are CC-schema-compatible) + `mem0-plugin/scripts/install_codex_hooks.py` installer pattern | Port the installer's idempotent merge into `~/.codex/hooks.json` (`OWNER_MARKER` strip-then-reinsert, `install_codex_hooks.py:43-83,147-148`), `--uninstall`, Windows guard (`:132-140`), `[features] codex_hooks=true` detection (`:91-110`). Note Codex needs longer hook timeouts (UserPromptSubmit/Bash 12s vs Claude's 8/5s — `codex-hooks.json:54,76`) | `claude-supermemory`: no Codex path at all; mem0-plugin: proven CC-schema sideload (same scripts, 6 events) |
| **Hermes** (v1.1) | `hermes-agent/plugins/memory/mem0` — copy as `dmemo` provider | Point its OSS backend (`_backend.py` + `_oss_providers.py` `base_url_key: "openai_base_url"`) at 0G Router; insert the Python D7 wrapper under its in-process `Memory` | Bundled `supermemory` provider: wire-coupled to proprietary REST surface, no in-process OSS story |

**Net pattern:** mem0 first-party wins outright wherever it ships a real native-hook plugin
(OpenClaw, OpenCode, Hermes). For the two hook-file CLIs (Claude Code, Codex) no single base
fits — mem0's is the right *behavior* (deterministic) in the wrong *packaging* (Python venv,
smeared HTTP), claude-supermemory's is the right packaging (bundled Node) with the wrong
recall model — so the adapter merges both patterns. Zero supermemory *code* survives as a
base; two supermemory *patterns* do (packaging skeleton; compaction trigger heuristics below).

## 2. Key findings

| Key finding | Ref |
|---|---|
| mem0-plugin ships a working Codex sideload: 6 hook events via `~/.codex/hooks.json`, same scripts as Claude Code, idempotent installer | `install_codex_hooks.py:1-163`, `codex-hooks.json:1-105` |
| `opencode-supermemory`'s context injection is gated `if (isFirstMessage)` — fires once per session, not per turn. mem0's plugin injects every turn (`chatMessageHook` + `chat.messages.transform`) | `opencode-supermemory/src/index.ts:132-136`; `opencode-mem0.ts:630-886` |
| `opencode-supermemory`'s `captureEveryNTurns` knob is dead config (zero call sites); its compaction bypasses OpenCode's native hook, writing synthetic message/part files to `~/.opencode/` directly | `config.ts:31,159-161` vs grep; `compaction.ts:10-11,169-235,406-410` |
| `@mem0/openclaw-mem0` is the only first-party plugin exercising `mem0ai/oss` in production: SQLite-resilience + vector-dim workarounds solved, session-key→`userId:agent:<id>` scoping, subagent recall-from-parent/skip-capture, non-interactive-trigger filtering | `providers.ts:329-392`, `isolation.ts:17-107`, `index.ts:723-728,862-867` |
| openclaw-mem0's "no key needed" OSS headline is true only on the Ollama path; **documented defaults still call OpenAI** for embedder+LLM — dMemo must swap defaults, not add opt-ins | `providers.ts:251-255` vs `README.md:97,99,332` |
| Claude Code/Codex hooks run as **fresh subprocesses per invocation** — the in-process store is opened/closed per hook call. Fine for the SQLite-file store; FAISS or big indexes would need a resident process/IPC. Reinforces D7's choice of the better-sqlite3 store for Node hosts | `on_user_prompt.sh:121`, backgrounded `python3 … &` pattern |

## 3. Reusable patterns worth porting regardless of base

| Pattern | Source | Why |
|---|---|---|
| Dream (periodic consolidation): cheap-gates → memory-gate → file-lock, agent-driven merge/rewrite | `openclaw-mem0` `dream-gate.ts:104-185`, `skills/memory-dream/SKILL.md` | Consolidation = just more mutations through the D7 wrapper → N new deltas (good append-only fit). Tag deltas `source: "dream"` vs `"capture"` for auditability; flush a dream burst as one batch, not N blobs. Feeds the delta-compaction open item |
| Session-key → scoped userId mapping | `openclaw-mem0` `isolation.ts:62-107` | Directly answers the OpenClaw multi-agent → key/scope open question: `${userId}:agent:${agentId}` namespace, subagents read parent scope + skip capture |
| Compaction trigger heuristics (token-ratio ≥0.80 + ≥50k tokens, cooldown, `session.idle` catch-up) | `opencode-supermemory` `compaction.ts:332-373,522-552` | Good trigger math even though its wiring bypasses the native hook — reimplement on `experimental.session.compacting` |
| Deterministic param-patching via `PreToolUse` `updatedInput` | `mem0-plugin` `enforce_metadata_defaults.sh` | Injects identity/scope into any model-invoked memory tool call — keeps optional tools consistent with hook-driven writes |
| Every-Nth-turn background capture + rubric-once-per-session dedup markers | `mem0-plugin` `on_user_prompt.sh:156-206` | Deterministic capture cadence between Stop-hook flushes |

## 4. Decision

| # | Decision | Detail |
|---|---|---|
| D18 | **Per-host fork bases (post-pivot)** | OpenClaw: fork `@mem0/openclaw-mem0`. OpenCode: fork `opencode-mem0.ts`. Hermes (v1.1): copy `hermes-agent/plugins/memory/mem0` as `dmemo` provider. Claude Code + Codex: one merged Node adapter — `claude-supermemory` packaging (esbuild `.cjs`, single client seam) + `mem0-plugin` deterministic prefetch/guards + its Codex installer pattern. In every host the client seam is replaced by dMemo core (in-process mem0 OSS + D7 journaling wrapper); mem0-Platform-only surfaces (MCP `mcp.mem0.ai`, project/entity/event APIs) are stripped, not ported. Supersedes the fork-base column that stood in SYNTHESIS §2 since before the pivot |
