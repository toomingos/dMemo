// T4.1 step 4 — OpenCode leg, rewritten. The previous version hand-wrote
// `"plugin": ["@dmemo/opencode-plugin"]` into `~/.config/opencode/opencode.json`
// and reported success unconditionally. That was the worst possible failure
// shape: verified empirically, when the npm spec doesn't resolve, OpenCode
// loads that config at startup, silently ignores the unresolvable entry
// (no log line), and the user gets a green "installed" message with zero
// memory.
//
// OpenCode actually ships its own install command, so there is no reason to
// hand-edit its config at all:
//
//   opencode plugin <module> [--global] [--force]
//
// (aliased `opencode plug`; command definition at
// `$REPOS/opencode/packages/opencode/src/cli/cmd/plug.ts:179-198` — flags
// confirmed at the `.option("global", ...)` / `.option("force", ...)`
// block in the same file). Crucially, it resolves the spec via
// `resolvePluginTarget()` -> `Npm.add()` and only patches config AFTER that
// resolution succeeds (`$REPOS/opencode/packages/opencode/src/plugin/shared.ts:207-213`,
// `resolvePluginTarget`) — so a nonexistent npm package now fails loudly
// with a real nonzero exit and a printed error, instead of writing a dead
// config entry.
//
// `resolvePluginTarget` checks `isPathPluginSpec(spec)` BEFORE trying npm at
// all (same file, `isPathPluginSpec`: accepts `file://`, a spec starting
// with `.`, or an absolute filesystem path). That is the officially
// supported way to install from an unpublished local checkout, which is
// exactly our situation before `@dmemo/opencode-plugin` is published (see
// RELEASE.md) — so when the npm spec doesn't resolve, this installer looks
// for a local monorepo checkout at `packages/opencode-plugin` (by walking up
// from this file and confirming the package.json name actually matches — it
// never guesses blindly) and retries with that absolute directory path as
// the plugin spec, which `isPathPluginSpec` accepts as-is (no `file://`
// prefix needed for an absolute path). If neither the npm spec nor a local
// checkout resolves, this installer fails loudly with both errors rather
// than silently doing nothing, matching the "fail loudly" property we
// wanted from OpenCode's own command in the first place.
//
// `--global` targets `~/.config/opencode/` (honoring `$XDG_CONFIG_HOME`),
// matching the scope the old installer targeted. `--force` (`plug.ts`
// `.option("force", ...)`, "replace existing plugin version") makes re-runs
// idempotent instead of a silent no-op when the plugin is already recorded.
//
// If the `opencode` binary isn't on PATH, this installer stays non-fatal —
// same posture as the Claude Code / OpenClaw installers — and returns
// manual instructions instead of throwing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const NPM_SPEC = '@dmemo/opencode-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface OpenCodeInstallResult {
  /** True once the `opencode` binary was confirmed present on PATH. */
  attempted: boolean;
  succeeded: boolean;
  /** The plugin spec that ultimately succeeded (npm name, or an absolute
   * local checkout path) — whichever `opencode plugin` was last run with. */
  specUsed?: string;
  /** True when the published npm spec did not resolve and this installer
   * fell back to a local monorepo checkout of `packages/opencode-plugin`. */
  usedLocalFallback: boolean;
  output?: string;
  error?: string;
  manualInstructions: string;
}

function manualInstructions(): string {
  return [
    'OpenCode: install the dMemo memory plugin (native install command,',
    'patches your global opencode config for you):',
    `  opencode plugin ${NPM_SPEC} --global --force`,
    '  (in a dev/unpublished monorepo checkout, this falls back automatically',
    '  to a local `packages/opencode-plugin` directory spec instead)',
  ].join('\n');
}

/**
 * Best-effort search for an unpublished local checkout of the plugin, for
 * monorepo dev/CI runs before `@dmemo/opencode-plugin` is published to npm.
 * Walks up from `startDir` (this file's directory in production; overridable
 * for tests) looking for `packages/opencode-plugin`, and only accepts it
 * once its `package.json` name actually matches — never guesses blindly, and
 * never matches some unrelated `packages/opencode-plugin` directory that
 * happens to exist outside this monorepo.
 */
export function findLocalPluginDir(startDir: string = __dirname): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'packages', 'opencode-plugin');
    const pkgFile = path.join(candidate, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg && pkg.name === NPM_SPEC) return candidate;
      } catch {
        // Not valid/matching JSON — keep searching upward rather than
        // guessing this is the right directory.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runInstall(spec: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('opencode', ['plugin', spec, '--global', '--force'], {
    encoding: 'utf8',
    env,
  });
}

export function installOpenCode(
  env: NodeJS.ProcessEnv = process.env,
  opts: { searchFrom?: string } = {}
): OpenCodeInstallResult {
  try {
    execFileSync('opencode', ['--version'], { stdio: 'ignore', env });
  } catch (err) {
    return {
      attempted: false,
      succeeded: false,
      usedLocalFallback: false,
      error: err instanceof Error ? err.message : String(err),
      manualInstructions: manualInstructions(),
    };
  }

  try {
    const output = runInstall(NPM_SPEC, env);
    return {
      attempted: true,
      succeeded: true,
      specUsed: NPM_SPEC,
      usedLocalFallback: false,
      output,
      manualInstructions: manualInstructions(),
    };
  } catch (npmErr) {
    const npmError = npmErr instanceof Error ? npmErr.message : String(npmErr);
    const localDir = findLocalPluginDir(opts.searchFrom ?? __dirname);
    if (!localDir) {
      return {
        attempted: true,
        succeeded: false,
        usedLocalFallback: false,
        error:
          `npm spec "${NPM_SPEC}" did not resolve, and no local ` +
          `packages/opencode-plugin checkout was found to fall back to:\n${npmError}`,
        manualInstructions: manualInstructions(),
      };
    }
    try {
      const output = runInstall(localDir, env);
      return {
        attempted: true,
        succeeded: true,
        specUsed: localDir,
        usedLocalFallback: true,
        output,
        manualInstructions: manualInstructions(),
      };
    } catch (localErr) {
      const localError = localErr instanceof Error ? localErr.message : String(localErr);
      return {
        attempted: true,
        succeeded: false,
        usedLocalFallback: true,
        error:
          `npm spec "${NPM_SPEC}" failed:\n${npmError}\n` +
          `local fallback ${localDir} also failed:\n${localError}`,
        manualInstructions: manualInstructions(),
      };
    }
  }
}
