# @dmemo/node-adapter (build-only, not published to npm)

**This package is `"private": true` and intentionally not published to
npm.** It is a build tool: its `build` script (`tsc -b && node
scripts/build.cjs`) esbuild-bundles the hook scripts in `src/hooks/` and
`src/codex/` into dependency-free single-file `.cjs` bundles and writes
them into `../../claude-dmemo/plugin/scripts/` — the Claude Code +
Codex distribution artifact actually shipped to end users.

## Why this isn't an npm package

- **Claude Code** distribution is a git repo (`dmemo-ai/claude-dmemo`,
  Claude's plugin-marketplace mechanism), not npm — `/plugin marketplace
  add` clones a repo, it doesn't `npm install` anything.
- **Codex** has no plugin/marketplace or registry concept at all; it only
  reads `~/.codex/hooks.json` directly. The `.cjs` scripts referenced by
  those hooks need to live at some stable path on disk — `packages/setup-cli`
  (`dmemo` on npm) vendors a copy of exactly the files Codex needs (see its
  `scripts/vendor-codex-plugin.mjs`) precisely so an end user's `npx dmemo
  setup` never needs this package or a live GitHub fetch.

## What it builds

| Source | Output | Used by |
|---|---|---|
| `src/hooks/session-start.ts` | `session-start.cjs` | Claude Code `SessionStart`, Codex `SessionStart` |
| `src/hooks/user-prompt-submit.ts` | `user-prompt-submit.cjs` | Claude Code `UserPromptSubmit`, Codex `UserPromptSubmit` |
| `src/hooks/stop.ts` | `stop.cjs` | Claude Code `Stop`, Codex `Stop` |
| `src/hooks/pre-compact.ts` | `pre-compact.cjs` | Claude Code `PreCompact`, Codex `PreCompact` |
| `src/hooks/recall-approve.ts` | `recall-approve.cjs` | Claude Code `PreToolUse` (auto-approve the search skill) |
| `src/cli/*.ts` | `save-memory.cjs`, `search-memory.cjs`, `status.cjs` | Claude Code skills/commands |
| `src/codex/install.ts` | `install-codex-hooks.cjs` | Codex hooks.json installer (idempotent merge, `--uninstall`) |

Each `.cjs` bundle is fully self-contained (no `node_modules` needed at
runtime) except for the native `better-sqlite3`/`fastembed` bindings, which
are installed/linked at first run into `~/.dmemo/native/` via
`src/lib/native-bootstrap.ts`'s `node_modules` symlink shim — see
`TASKS.md` gotcha 17 for why (`Module.globalPaths`/`NODE_PATH` don't work
for a bundled `.cjs`'s dynamic `import()`).

## Development

```bash
pnpm run build   # writes into ../../claude-dmemo/plugin/scripts/
pnpm test        # unit tests (dist/*.test.js, if any exist for a given change)
```

The Codex installer itself is separately covered by
`packages/setup-cli`'s end-to-end sandboxed test (throwaway `HOME`/
`CODEX_HOME`), since that's the real invocation path for most users.
