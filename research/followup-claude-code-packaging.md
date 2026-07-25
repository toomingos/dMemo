# Claude Code Packaging Follow-Up — Plugin Distribution for dMemo

Scope: resolves open question #3 from `claude-code.md` — can dMemo's hooks (+ optional MCP server) be packaged and installed in "a couple of steps"? Covers plugin contents, install UX, plugin-hook semantics, a full read of `supermemoryai/claude-supermemory` as a working precedent, and the Claude Agent SDK embedding path.

Sources: official docs at code.claude.com/docs (`plugins`, `plugin-marketplaces`, `discover-plugins`, `plugins-reference`, `hooks`, `agent-sdk/typescript`, `agent-sdk/plugins` — all fetched 2026-07-24); `supermemoryai/claude-supermemory` cloned and read in full at `/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/claude-supermemory`.

---

## (a) High-level overview

```
Author side (dMemo team)                    User side (one person, once)
──────────────────────────                  ────────────────────────────
dmemo-plugin/
├── .claude-plugin/
│   ├── plugin.json          manifest        /plugin marketplace add dmemo/claude-dmemo
├── hooks/hooks.json         SessionStart,    /plugin install dmemo
│                             UserPromptSubmit,        │
│                             PreToolUse,               ▼
│                             Stop                claude-plugins-community OR
├── skills/                                     dmemo-owned marketplace repo
│   ├── dmemo-search/SKILL.md   (recall)              │
│   └── dmemo-save/SKILL.md     (explicit save)        ▼
├── commands/                 /dmemo:status etc   ~/.claude/plugins/cache/… (copied,
├── .mcp.json (OPTIONAL)      mid-turn tools       versioned, sandboxed to plugin dir)
└── scripts/*.cjs (bundled,          │
    no node_modules needed)          ▼
                                 plugin active this session:
                                 hooks fire automatically,
                                 skills namespaced /dmemo:*,
                                 MCP tools (if any) appear in toolkit
```

Two install commands cover it end-to-end:
```
/plugin marketplace add <owner>/<repo>      # register the catalog
/plugin install dmemo@<marketplace-name>    # install; scope = user/project/local
```
That satisfies "a couple of steps and you have private memory" — provided the plugin is self-contained (no separate MCP server deploy, no manual settings.json edits, no separate API-key file placement outside the plugin's own `userConfig` prompt).

---

## (b) Key decisions and why

### 1. Can a plugin bundle hooks + MCP + skills for one-command install? — Yes, and more

A single plugin directory can contain, all at once: `skills/`, `commands/` (legacy flat-file skills), `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/` (executables on `PATH`), `settings.json` (default agent/statusline), `themes/`. Only `plugin.json` is required to live inside `.claude-plugin/`; every other directory is at the plugin root.

| Component | Where | dMemo use |
|---|---|---|
| `hooks/hooks.json` | plugin root | `SessionStart` (inject memory), `Stop`/`SessionEnd` (write-back), optionally `UserPromptSubmit`/`PreToolUse` (reasoned recall, see §4) |
| `.mcp.json` | plugin root | optional mid-turn recall/save tools — **but see §4, supermemory ships none** |
| `skills/` | plugin root | model-invoked recall/save skills, namespaced `/dmemo:search` |
| `commands/` | plugin root | status/logout/config utility commands |
| `settings.json` (plugin) | plugin root | only `agent`/`subagentStatusLine` keys — not a place for arbitrary default settings |

Reference: [Create plugins — Plugin structure overview](https://code.claude.com/docs/en/plugins), [Plugins reference — Plugin directory structure](https://code.claude.com/docs/en/plugins-reference#plugin-directory-structure).

Key constraint: **plugins are copied into `~/.claude/plugins/cache/` on install**, not run in-place. Any path reference outside the plugin's own directory (`../shared`) breaks after install. Bundle scripts must be self-contained inside the plugin (see §5, supermemory's esbuild pattern solves this for Node deps). Reference: [Plugin caching and file resolution](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution).

### 2. Install UX — `/plugin`, marketplaces, git URLs, trust prompts

| Path | Command | Notes |
|---|---|---|
| Official marketplace | `/plugin install dmemo@claude-plugins-official` | Requires Anthropic curation/acceptance — not self-serve; no application process |
| Community marketplace | `/plugin marketplace add anthropics/claude-plugins-community` then `/plugin install dmemo@claude-community` | Self-serve via review form (claude.ai or platform.claude.com), automated validation + safety screening, pinned to a commit SHA, syncs nightly |
| **Own marketplace (recommended for v1)** | `/plugin marketplace add dmemo-ai/claude-dmemo` then `/plugin install dmemo@dmemo-plugins` | Fully self-serve, zero review latency, just push to a public GitHub repo with `.claude-plugin/marketplace.json` |
| Direct git URL (non-GitHub) | `/plugin marketplace add https://gitlab.com/.../plugin.git` | Works with any git host |
| Non-interactive/CI | `claude plugin marketplace add <source>` / `claude plugin install <plugin>@<marketplace>` | Same operations as CLI subcommands, scriptable |

Trust/permission surface the user sees:
- A **security warning is shown in docs, not enforced by a signature system**: *"Plugins and marketplaces are highly trusted components that can execute arbitrary code on your machine with your user privileges... Anthropic doesn't control what MCP servers, files, or other software are included in plugins and can't verify that they work as intended."* — [Discover and install plugins — Security](https://code.claude.com/docs/en/discover-plugins#security)
- Installing opens a **scope picker** (User / Project / Local) that must be confirmed interactively — this is the actual "did you mean to install this" gate, not a separate consent dialog per component.
- The plugin detail view (pre-install) shows a **"Will install"** section (commands, agents, skills, hooks, MCP/LSP servers) and a **context-cost estimate** before the user confirms — this is the closest thing to a permission prompt.
- After install, `/reload-plugins` activates it in the current session (or restart).
- Community-marketplace plugins get automated safety screening + SHA pinning; own-marketplace or `--plugin-dir` plugins get none of that — the only gate is the user's judgment at install time.

Reference: [Discover and install plugins](https://code.claude.com/docs/en/discover-plugins), [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces).

**Decision implication**: dMemo should ship its **own marketplace repo** (`dmemo-ai/claude-dmemo` with `.claude-plugin/marketplace.json`) for v1 — no review latency, full control over release cadence — while separately submitting to `claude-plugins-community` for discoverability. Both can coexist; a plugin can be installed from either.

### 3. Plugin hooks vs. user-configured hooks — precedence, disable, timeouts

| Question | Finding |
|---|---|
| Precedence | **None — they coexist.** All hooks from plugin `hooks/hooks.json` + `~/.claude/settings.json` + `.claude/settings.json` + `.claude/settings.local.json` merge and run **in parallel**; identical handlers are deduplicated by command string/args (or URL for `http`) |
| Disable | Plugin hooks disable as a unit with the plugin (`/plugin disable dmemo@marketplace`); no per-hook toggle within an enabled plugin. `"disableAllHooks": true` in settings kills everything including plugin hooks |
| Enterprise override | `allowManagedHooksOnly` can block user/project hooks while **exempting hooks from plugins force-enabled via managed `enabledPlugins`** — lets an org distribute vetted hooks (dMemo) org-wide even when employees can't add their own | 
| Timeouts | `command`/`http`/`mcp_tool`: 600s default (30s for `UserPromptSubmit`, 10s for `MessageDisplay`); `prompt`: 30s; `agent`: 60s. Override per-hook with `"timeout": <seconds>` |
| Path placeholders | `${CLAUDE_PLUGIN_ROOT}` (install dir, changes on update), `${CLAUDE_PLUGIN_DATA}` (persistent across updates — `~/.claude/plugins/data/{id}/`, good for caching a decrypted key or a Node `node_modules` install), `${CLAUDE_PROJECT_DIR}` |
| Limitation | Shell-form plugin hook commands **cannot** reference `${user_config.*}` (would let arbitrary user input execute in a shell) — must use exec form (`command`+`args` array) or read `CLAUDE_PLUGIN_OPTION_<KEY>` env var instead |

Reference: [Hooks](https://code.claude.com/docs/en/hooks), [Plugins reference — Hooks](https://code.claude.com/docs/en/plugins-reference), [Plugins reference — User configuration](https://code.claude.com/docs/en/plugins-reference#user-configuration).

**Decision implication**: dMemo's `SessionStart`/`Stop` hooks behave identically whether shipped via plugin or hand-copied into a user's `settings.json` — no functional downgrade from packaging as a plugin. The `userConfig` field (see §5) is the clean way to prompt for a dMemo API key at install time instead of asking users to hand-edit `settings.json` or export env vars.

### 4. Real-world precedent — `claude-supermemory`, read in full

dMemo's merged Claude Code + Codex adapter (D18) borrows this packaging pattern — not the supermemory engine, just the plugin skeleton. The repo is a **hooks + skills + commands plugin with NO bundled MCP server** — a directly relevant, deliberate architectural choice worth mirroring.

| File | Role |
|---|---|
| `.claude-plugin/marketplace.json` | one marketplace (`supermemory-plugins`), one plugin entry, `source: "./plugin"` (relative path within the same repo) |
| `plugin/.claude-plugin/plugin.json` | manifest: name, version, author, homepage/repo/license/keywords — no `hooks`/`mcpServers` inline, all in separate files |
| `plugin/hooks/hooks.json` | 4 hooks: `SessionStart` (30s timeout), `UserPromptSubmit` (10s), `PreToolUse` matcher `Skill\|Bash` (10s), `Stop` (30s) — all `type: "command"`, all `node "${CLAUDE_PLUGIN_ROOT}/scripts/*.cjs"` |
| `plugin/skills/supermemory-search/SKILL.md`, `supermemory-save/SKILL.md` | model-invoked skills; frontmatter `allowed-tools: Bash(node:*)` scopes what the skill may call |
| `plugin/commands/*.md` | flat-file commands: `index`, `project-config`, `logout`, `session`, `status` |
| *(no `.mcp.json` anywhere in the repo)* | **confirmed absent** — recall/save happen through skills that shell out to bundled Node scripts, not MCP tools |

How recall works without MCP (the interesting part):
1. `SessionStart` hook (`context-hook.cjs`) — fetches project memory, injects as `additionalContext`, handles first-run OAuth (opens browser) if no API key found, falls back to `SUPERMEMORY_CC_API_KEY` env var.
2. `UserPromptSubmit` hook (`recall-hook.cjs`) — injects a **reasoning directive** every turn (not the memory itself): *"decide whether recalling saved memory would materially improve your answer to THIS message... Recall via the supermemory-search skill when..."* — this is prompt-engineering the model to decide, per turn, whether to invoke the skill.
3. `PreToolUse` hook matcher `Skill|Bash` (`recall-approve.cjs`) — regex-detects when the tool call is the `supermemory-search` skill or a matching `Bash node .../search-memory.cjs` command, and returns `permissionDecision: "allow"` automatically — **this removes the permission prompt for read-only recall**, which is the exact friction an MCP tool call would also need `PreToolUse` auto-approval to avoid.
4. `Stop` hook (`summary-hook.cjs`) — reads `transcript_path`/`session_id` from stdin, formats new turns, POSTs to Supermemory API as a memory, keyed by a container tag derived from git remote (shared team memory) — same write-back pattern as recommended in `claude-code.md` for dMemo.

Dependency bundling trick (relevant to any Node/TS-based dMemo hook scripts): `scripts/build.js` uses **esbuild** to bundle each hook entry point (`src/*.js`) into a single minified `.cjs` file with a `#!/usr/bin/env node` banner, committed under `plugin/scripts/`. This avoids shipping `node_modules` in the plugin or requiring `npm install` post-install — the plugin cache just contains ready-to-run single-file scripts. `package.json` only needs `node >=18` on the user's `PATH`.

**Decision implication**: dMemo does **not need an MCP server** to satisfy "recall mid-turn" — a `UserPromptSubmit` reasoning-directive hook + a `Skill` (shelling to a bundled script) + a `PreToolUse` auto-approve hook reproduces MCP-tool ergonomics using only hook+skill primitives, avoiding: MCP server process management, `.mcp.json` per-server user approval flow, and MCP tool context/token overhead. This is a stronger fit for dMemo's "couple of steps" goal than shipping a separate MCP server.

An MCP server remains optional/additive if dMemo wants exploratory search tools (e.g., graph browsing) beyond simple recall/save — it can be added to the same plugin's `.mcp.json` later without restructuring anything.

### 5. Agent SDK path — same plugin artifact, loaded programmatically

The Claude Agent SDK (TypeScript and Python) accepts an `options.plugins` array of `{ type: "local", path: "<dir>" }` entries. `type` **must** be `"local"` — to use a marketplace-distributed plugin in the SDK, download/clone it first and point at the local directory (no marketplace resolution inside the SDK).

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
query({
  prompt: "...",
  options: { plugins: [{ type: "local", path: "./node_modules/@dmemo/claude-plugin" }] }
});
```

- The plugin's hooks, skills, agents, and MCP servers all load exactly as they would under the CLI — same `plugin.json`/`hooks/hooks.json`/`.mcp.json` files.
- SDK users can also register hooks purely programmatically via `options.hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>` if they'd rather not depend on the packaged plugin at all — these are two independent, non-conflicting mechanisms (SDK-native hooks + plugin-provided hooks both fire).
- `strictMcpConfig: true` excludes plugin-provided MCP servers, keeping only explicitly-listed ones — a safety valve for SDK embedders who want no auto-loaded tools.

Reference: [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins), [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).

**Decision implication**: **one packaging artifact serves both distribution paths.** Ship the dMemo plugin as an npm package (or a plain git-cloneable directory); Claude Code CLI users install it via `/plugin install` (marketplace-resolved), Agent SDK embedders `npm install @dmemo/claude-plugin` and pass `{ type: "local", path: require.resolve(...) }`. No separate SDK-specific integration code needed — this directly answers RQ5 without a fork in the packaging strategy.

---

## Recommended packaging shape for dMemo

**What gets built** (one repo, two roles):
```
claude-dmemo/                              (repo doubles as marketplace + plugin source)
├── .claude-plugin/marketplace.json        # marketplace: 1 entry, source: "./plugin"
├── plugin/
│   ├── .claude-plugin/plugin.json         # name: "dmemo", userConfig for API key
│   ├── hooks/hooks.json                   # SessionStart (inject), Stop (write-back),
│   │                                       #   UserPromptSubmit (reasoned-recall directive),
│   │                                       #   PreToolUse matcher Skill|Bash (auto-approve recall)
│   ├── skills/dmemo-search/SKILL.md       # model-invoked recall
│   ├── skills/dmemo-save/SKILL.md         # model-invoked explicit save
│   ├── commands/status.md, logout.md      # utility slash commands
│   └── scripts/*.cjs                      # esbuild-bundled, no node_modules needed at runtime
└── (no .mcp.json in v1 — add later only if exploratory tools are needed)
```

**What the user types** (two commands, matches "a couple of steps"):
```
/plugin marketplace add dmemo-ai/claude-dmemo
/plugin install dmemo
```
Then a `userConfig`-driven prompt (not a manual env var/file edit) collects the dMemo API key at enable time, stored in the OS keychain if `sensitive: true` is set.

**Why this shape**: it mirrors the one working precedent (`claude-supermemory`) component-for-component, satisfies the plugin-hooks-have-no-special-precedence guarantee (so behavior is identical to a hand-installed hook set), needs no MCP server to hit "recall/save," and the exact same `plugin/` directory is reusable unmodified as an `options.plugins` entry for Claude Agent SDK embedders — one artifact, two install surfaces (CLI marketplace install, SDK local-path load).

## Files/paths referenced
- `/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/claude-supermemory/` (full repo: `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `plugin/skills/*/SKILL.md`, `src/context-hook.js`, `src/recall-hook.js`, `src/recall-approve.js`, `src/summary-hook.js`, `scripts/build.js`)
