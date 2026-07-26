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
  `scripts/vendor-codex-plugin.mjs`) precisely so an end user's `npx @dmemo/cli
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

## Graceful shutdown (gotcha 28)

Every hook/CLI entry point above funnels through `withSession()`
(`src/lib/dmemo.ts`), which is the single open/use/close seam for a
`DmemoSession` per invocation. `withSession()` installs `@dmemo/core`'s
`installGracefulShutdown` right after `DmemoSession.open()` succeeds and
keeps it live through its own `finally`'s `close()` — so a SIGTERM/SIGINT/
SIGHUP arriving anywhere in that window (most importantly, mid-flush
during a `Stop`/`PreCompact` write-back) now runs the same bounded
`waitForPendingFlush()` + `close()` a normal return would, instead of
losing the capture to the signal's default disposition. This reuses F7's
existing, host-agnostic shutdown module unchanged (no second
implementation) — see `packages/core/src/runtime/shutdown.ts`'s header for
the full constraints (never `process.exit()`, why re-delivering the
original signal is required, why a hung flush is force-terminated via
`SIGKILL`).

Timeout: defaults to `installGracefulShutdown`'s own
`DEFAULT_SHUTDOWN_TIMEOUT_MS` (4s), overridable via
`DMEMO_SHUTDOWN_TIMEOUT_MS`. Checked against every hook's own
host-enforced timeout (`../../claude-dmemo/plugin/hooks/hooks.json`,
`src/codex/hooks-template.json`): the tightest is `UserPromptSubmit`/
`PreToolUse` at 10s, the rest are 30s — 4s leaves comfortable margin under
the tightest of those budgets. Covered by
`src/lib/hook-shutdown.test.ts` (real child-process signal tests, mirroring
`packages/core/src/runtime/shutdown.test.ts` but for a short-lived,
hook-shaped process with no artificial keep-alive).

## Development

```bash
pnpm run build   # writes into ../../claude-dmemo/plugin/scripts/
pnpm test        # unit tests (dist/*.test.js, if any exist for a given change)
```

The Codex installer itself is separately covered by
`packages/setup-cli`'s end-to-end sandboxed test (throwaway `HOME`/
`CODEX_HOME`), since that's the real invocation path for most users.
