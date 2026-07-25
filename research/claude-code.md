# Claude Code Research — dMemo Integration

Scope: how Claude Code (Anthropic's CLI agent) can (1) route inference through 0G Compute, (2) have external memory injected/captured at native lifecycle points, and (3) the fork base for the merged Claude Code + Codex adapter (D18).

Sources: official docs at code.claude.com/docs (fetched 2026-07-24). Claude Code's own CLI source is closed; nothing here is inferred beyond the published docs/reference. Fork-base analysis (D18) draws on `followup-claude-code-packaging.md` (claude-supermemory packaging skeleton, full repo read) and `followup-fork-bases.md` (mem0-plugin, Codex hook installer).

---

## (a) High-level overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Claude Code session                          │
│                                                                        │
│  SessionStart hook ──► additionalContext ──► injected before 1st turn │
│        │                                                               │
│        ▼                                                               │
│  UserPromptSubmit hook ──► additionalContext ──► injected per turn    │
│        │                                                               │
│        ▼                                                               │
│  [agentic loop: model + tools, incl. MCP tools like recall()/memory()]│
│        │                                                               │
│        ▼                                                               │
│  Stop hook (per turn) / SessionEnd hook (once) ──► read transcript_path│
│        │                                                               │
│        ▼                                                               │
│  external write-back (0G Storage, encrypted)                          │
└─────────────────────────────────────────────────────────────────────┘

Inference routing (separate axis, orthogonal to memory):
Claude Code ──ANTHROPIC_BASE_URL──► gateway ──/v1/messages (Anthropic format)──► upstream
                                        (must speak Anthropic Messages API;
                                         Anthropic doesn't support non-Claude
                                         models behind this)
```

Two independent integration surfaces:
1. **Where memory gets in/out** — hooks (deterministic, no model cooperation needed) vs. MCP tools (model must decide to call them) vs. CLAUDE.md/skills (static, loaded every session).
2. **Where inference gets routed** — `ANTHROPIC_BASE_URL` / gateway config, decoupled from #1. This determines whether pc.0g.ai can sit behind Claude Code at all.

---

## (b) Key decisions and why

### 1. Custom provider / baseURL — routing Claude Code through 0G Compute

| Question | Finding | Reference |
|---|---|---|
| Can Claude Code point at a custom endpoint? | Yes: `ANTHROPIC_BASE_URL` (+ `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `apiKeyHelper`) | [env-vars](https://code.claude.com/docs/en/env-vars), [llm-gateway-connect](https://code.claude.com/docs/en/llm-gateway-connect) |
| What must the endpoint implement? | The **Anthropic Messages API** verbatim: `POST /v1/messages` (+ optional `/v1/messages/count_tokens`), streaming SSE responses, forwarding `anthropic-beta`/`anthropic-version` headers unchanged | [llm-gateway-protocol#api-formats](https://code.claude.com/docs/en/llm-gateway-protocol) |
| Does Anthropic support routing to non-Claude models through a gateway? | **Explicitly no.** *"Anthropic doesn't endorse, maintain, or audit third-party gateway products, and doesn't support routing Claude Code to non-Claude models through any gateway."* | [llm-gateway.md](https://code.claude.com/docs/en/llm-gateway) |
| Practical implication for dMemo | pc.0g.ai (0G Compute) would need to expose an **Anthropic-Messages-compatible `/v1/messages` endpoint**, streaming, that either (a) actually serves a Claude model, or (b) translates to another model — the latter is unsupported/best-effort: Claude Code sends Claude-specific fields (`thinking: {"type":"adaptive"}`, `output_config`, tool `strict`/`defer_loading`, context-management beta) that a non-Claude backend will `400` on unless the gateway strips them (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` helps) or the backend accepts/ignores them | [llm-gateway-protocol#feature-pass-through](https://code.claude.com/docs/en/llm-gateway-protocol) |
| Streaming requirement | *"Inference responses must stream... a gateway that buffers complete responses before relaying them stalls the client."* | same |
| Minimal working config | `env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN }` in `~/.claude/settings.json` or shell export | [llm-gateway-connect](https://code.claude.com/docs/en/llm-gateway-connect) |
| Model discovery (optional) | `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` queries `GET /v1/models` at your base URL and adds returned model IDs to the `/model` picker — but **filters out any `id` not starting with `claude` or `anthropic`**, another signal this path assumes Claude-family models | [llm-gateway-protocol#model-discovery](https://code.claude.com/docs/en/llm-gateway-protocol) |
| Alternative: Claude Agent SDK | Same mechanism — the SDK has *"no gateway-specific options; it passes environment variables to the Claude Code process it spawns."* TS: `options.env` replaces env entirely (must spread `process.env`); Python: `ClaudeAgentOptions(env=...)` merges on top | [llm-gateway-connect#agent-sdk](https://code.claude.com/docs/en/llm-gateway-connect) |

**Decision implication**: if dMemo's plug-and-play story requires 0G Compute serving arbitrary/non-Claude models, `ANTHROPIC_BASE_URL` is the wrong mechanism to advertise as "official/supported" — it's technically pluggable but Anthropic states it's unsupported for non-Claude models and will leak Claude-specific request fields that a naive proxy will choke on. If pc.0g.ai serves Claude models (e.g., a TEE-hosted Claude), this path works cleanly. Recommend prototyping a minimal Anthropic-Messages-shaped proxy (`/v1/messages`, SSE, forward `anthropic-*` headers) in front of pc.0g.ai and testing with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` to reduce the field surface first, since that's a documented mitigation for `400`s from non-Anthropic upstreams.

### 2. Native memory attachment points

Claude Code hook events (verbatim table from [hooks.md](https://code.claude.com/docs/en/hooks)), the ones relevant to memory in/out:

| Hook | Fires | Can inject context? | Can block? | Use for dMemo |
|---|---|---|---|---|
| `SessionStart` | New/resumed/cleared/compacted/forked session | Yes — `additionalContext` (also `initialUserMessage`, `sessionTitle`, `watchPaths`) | No | **Fetch memory once at session start, decrypt, inject into context before first prompt** |
| `UserPromptSubmit` | Every user prompt, before Claude processes it | Yes — `hookSpecificOutput.additionalContext` | Yes | Optional: fetch freshest memory per turn (costs latency/tokens each turn) |
| `Stop` | Claude finishes responding (every turn, not just task completion) | Yes — `additionalContext`; has `last_assistant_message` | Yes | Capture per-turn output for incremental write-back |
| `SessionEnd` | Session terminates (`clear`/`resume`/`logout`/`prompt_input_exit`/`bypass_permissions_disabled`/`other`) | **No** — output fields are common-only, no event-specific output | No | Read `transcript_path` (full JSONL transcript) and `session_id` from stdin, upload to 0G Storage for write-back |
| `PreCompact`/`PostCompact` | Around context compaction | No (PreCompact can block) | Only PreCompact | Not primary; note project-root CLAUDE.md auto-reloads after compact, nested CLAUDE.md/memory does not |

Verified input/output shapes (verbatim from docs):
- `SessionStart` input includes `source` (`startup`/`resume`/`clear`/`compact`/`fork`), `model`, `agent_type`, `session_title`.
- `SessionStart` output: `additionalContext` (injected "before the first prompt"), `initialUserMessage`, `watchPaths`, `sessionTitle`, `reloadSkills`.
- `SessionEnd` input: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, matcher/`reason`. No decision-control output — *"SessionEnd is used for side effects like logging or cleanup."*
- Hook comms: *"Command hooks communicate through stdout, stderr, and exit codes only... Text returned via `additionalContext` is injected as a system reminder that Claude reads as plain text."* — [hooks-guide.md](https://code.claude.com/docs/en/hooks-guide)
- Hook types supported: `command` (shell), `http` (webhook), `mcp_tool`, `prompt` (LLM judge), `agent`. Timeouts: command/http/mcp_tool 10 min (UserPromptSubmit lowered to 30s); prompt 30s; agent 60s.
- Config lives in `hooks` block of any [settings file](https://code.claude.com/docs/en/settings) (`~/.claude/settings.json`, project `.claude/settings.json`, `.claude/settings.local.json`, managed policy). Project-level hooks require the workspace-trust dialog.

**This is the load-bearing mechanism for dMemo**: `SessionStart` (fetch+inject) and `SessionEnd` (capture+write-back) are the two hooks that are (1) deterministic — *"Hooks... provide deterministic control over Claude Code's behavior, ensuring certain actions always happen rather than relying on the LLM to choose to run them"* ([hooks-guide.md](https://code.claude.com/docs/en/hooks-guide)) — and (2) require zero model cooperation, unlike an MCP memory tool that the model must decide to call.

Other native surfaces, weaker fit:
- **CLAUDE.md** — static instructions loaded every session (project/user/org scoped, `@import` syntax, 200-line/25KB soft budget on `MEMORY.md`-style auto-memory). Good for *"always call the memory tool"* instructions, not for injecting dynamic content — content is loaded from disk at launch, not fetched from a remote store. [memory.md](https://code.claude.com/docs/en/memory)
- **Auto memory** (`~/.claude/projects/<project>/memory/MEMORY.md`) — Claude Code's own built-in local persistent memory feature (on by default). It's local-disk, per-machine, per-repo — not encrypted/remote, not shared across machines. Not a substitute for dMemo's cross-agent, cross-device store, but architecturally validates "memory index loaded every session + topic files loaded on demand" as the pattern Anthropic itself uses.
- **Subagents** — run in their own context; *"the main conversation's auto memory isn't loaded into subagents; the exception is a fork, which inherits the parent conversation and system prompt."* Subagents get their own `memory` field for persistent notes. Not a memory-injection point per se; more a scoping/isolation feature. [sub-agents.md](https://code.claude.com/docs/en/sub-agents)
- **MCP tools/resources/prompts** — agent-driven, not automatic:
  - MCP **resources** require explicit `@server:uri` mention by the user (or the model choosing to reference them) — *"Claude Code automatically provides tools to list and read MCP resources"* but they are not auto-loaded into context. [mcp.md]
  - MCP **prompts** surface as slash commands (`/mcp__server__promptname`) — *"MCP prompts are dynamically discovered from connected servers"* but require explicit invocation, not run at session start automatically.
  - MCP **tools** (e.g., a memory `recall`/`save` tool) only fire if the model decides to call them — reliability depends on prompting (CLAUDE.md or MCP tool descriptions telling the model to always call `recall` first / `save` after new facts).
- **Channels** (research preview) — MCP servers that *push* events into an already-running session (Telegram/Discord/iMessage/webhook). Interesting for a "memory update pushed mid-session" pattern later, but immature (preview, Bun-based plugin, requires `--channels` flag, gated by org policy) — not a v1 fit. [channels.md](https://code.claude.com/docs/en/channels)

### 3. Fork base for the Claude Code + Codex adapter (D18)

dMemo originally planned to fork supermemory; supermemory's engine is closed-source, which drove the pivot to embedding mem0 OSS (Apache-2.0) in-process instead (D1-D5).

mem0 ships a first-party Claude Code plugin (`mem0/integrations/mem0-plugin`: hooks + MCP + skills) and an `install_codex_hooks.py` pattern for Codex — read code-level in `followup-fork-bases.md`. The settled fork base (D18) merges the Claude Code and Codex integrations into **one** Node adapter, combining three sources:

| Source | Contributes |
|---|---|
| `claude-supermemory` packaging skeleton (full analysis in `followup-claude-code-packaging.md`) | esbuild-bundled, dependency-free `.cjs` hooks; single isolated client class |
| mem0-plugin | deterministic behaviors: top-5 prefetch on every `UserPromptSubmit`, subagent-skip / PreCompact / Bash-error-recall guards |
| mem0-plugin's `install_codex_hooks.py` | idempotent Codex hook installer (12s timeouts on Codex) |

mem0-plugin alone is disqualified as the base by its Bash+Python packaging (runtime venv + pip install) and Platform-API calls smeared across 5 scripts; claude-supermemory alone by its model-gated (non-deterministic) per-turn recall. The merge takes claude-supermemory's dependency-free packaging shape and drops mem0-plugin's deterministic hook logic into it — consistent with the hook-vs-MCP-tool distinction above (§2): deterministic `SessionStart`/`UserPromptSubmit` hooks, not model-optional MCP tool calls, are the mechanism for both injection and capture.

---

## Open questions (unresolved by research)

1. **0G Compute API shape** — does pc.0g.ai already expose (or could easily expose) an Anthropic-Messages-format `/v1/messages` streaming endpoint, or only an OpenAI-compatible/custom API? This determines whether `ANTHROPIC_BASE_URL` routing is a days-of-work proxy or a non-starter. Not verifiable from Claude Code docs alone — needs 0G-side research.
2. **Which Claude Code surfaces matter for "plug and play"** — CLI only, or also VS Code extension / Claude Agent SDK-embedded agents? Gateway env-var propagation differs per surface (VS Code needs `claudeCode.environmentVariables`; SDK needs explicit `env` passthrough) per [llm-gateway-connect#configure-each-surface](https://code.claude.com/docs/en/llm-gateway-connect) — worth deciding scope before designing the plug-and-play installer.
3. Whether hooks can be reliably packaged/distributed as part of a plugin (for one-command install) — resolved in `followup-claude-code-packaging.md` (plugin marketplace mechanics + the claude-supermemory packaging precedent).

## Files/paths referenced
- `/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/claude-agent-sdk-python/src/claude_agent_sdk/_internal/session_resume.py` (session/env handling in Python SDK, not deeply explored — flagged for follow-up if session-resume semantics matter for memory continuity)
- `followup-claude-code-packaging.md` (claude-supermemory packaging skeleton, full repo read — D18 component)
- `followup-fork-bases.md` (mem0-plugin, Codex hook installer — D18 components)
