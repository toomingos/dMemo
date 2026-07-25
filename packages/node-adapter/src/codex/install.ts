#!/usr/bin/env node
// TS port of mem0-plugin's `install_codex_hooks.py` (D18 fork-base
// pattern). Codex discovers hooks only at `~/.codex/hooks.json` (no
// plugin-host auto-wiring), so this installer merges dMemo's hook entries
// into it directly: idempotent owner-marker strip-then-reinsert,
// `--uninstall`, Windows refusal (Codex hooks are plain `node ...`
// commands here, not `.sh`, but the underlying Windows-shell-invocation
// caveat from the mem0-plugin precedent still applies to `command`-type
// Codex hooks generally, so the guard is ported as-is), `[features]
// codex_hooks=true` detection, and disabling Codex's competing native
// memory subsystem in config.toml (gotcha: Codex's own memory pipeline is
// unencrypted/local and not pluggable — must be turned off, not merged
// with dMemo's).
//
// Usage:
//   node install-codex-hooks.cjs                 # install/update
//   node install-codex-hooks.cjs --uninstall      # remove dMemo entries
//   CODEX_HOME=/tmp/sandbox node install-codex-hooks.cjs   # sandboxed (tests)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This file is esbuild-bundled straight from source to a single `.cjs`
// (scripts/build.cjs), so the CJS globals `__dirname`/`require`/`module`
// used below are real at runtime — `import.meta.url` is NOT usable here:
// esbuild leaves it `undefined` for `format: 'cjs'` output (confirmed by
// build warning), which would silently break both `defaultPluginRoot()`
// and the direct-invocation check at the bottom of this file.

// Substring identifying hook entries this installer owns — present in
// every command string regardless of install path (see hooks-template.json
// commands' `DMEMO_HOOK=1` prefix).
const OWNER_MARKER = 'DMEMO_HOOK=1';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ command?: string; [key: string]: unknown }>;
}
interface HooksConfig {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function hooksFile(): string {
  return path.join(codexHome(), 'hooks.json');
}

function configFile(): string {
  return path.join(codexHome(), 'config.toml');
}

/** This installer ships inside `plugin/scripts/` (built alongside the
 * other .cjs hook scripts, see scripts/build.js) so its own directory's
 * parent is the plugin root Codex's hooks.json commands should point at —
 * the same `${CLAUDE_PLUGIN_ROOT}/scripts/*.cjs` layout Claude Code uses,
 * just resolved to an absolute path instead of an env var. */
function defaultPluginRoot(): string {
  return path.dirname(__dirname); // scripts/ -> plugin/
}

function loadTemplate(pluginRoot: string): HooksConfig {
  const templatePath = path.join(__dirname, 'hooks-template.json');
  const raw = fs.readFileSync(templatePath, 'utf8').split('${PLUGIN_ROOT}').join(pluginRoot);
  return JSON.parse(raw) as HooksConfig;
}

function loadExisting(): HooksConfig {
  const file = hooksFile();
  if (!fs.existsSync(file)) return { hooks: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as HooksConfig;
  } catch (err) {
    throw new Error(`failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isOwnedEntry(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(OWNER_MARKER));
}

function stripOwnedEntries(config: HooksConfig): HooksConfig {
  const hooks = config.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] ?? []).filter((entry) => !isOwnedEntry(entry));
    if (hooks[event]!.length === 0) delete hooks[event];
  }
  config.hooks = hooks;
  return config;
}

function mergeTemplate(config: HooksConfig, template: HooksConfig): HooksConfig {
  const hooks = (config.hooks ??= {});
  for (const [event, entries] of Object.entries(template.hooks ?? {})) {
    hooks[event] = [...(hooks[event] ?? []), ...entries];
  }
  return config;
}

function writeConfig(config: HooksConfig): void {
  fs.mkdirSync(codexHome(), { recursive: true });
  fs.writeFileSync(hooksFile(), JSON.stringify(config, null, 2) + '\n');
}

function featureFlagEnabled(): boolean {
  const file = configFile();
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, 'utf8');
  return content
    .split('\n')
    .some((line) => line.split('#', 1)[0]!.replace(/\s+/g, '') === 'codex_hooks=true');
}

/** Merge `[features] codex_hooks = true` and disable Codex's native memory
 * subsystem (`memories.generate_memories`/`memories.use_memories = false`)
 * into config.toml. A hand-rolled minimal TOML editor — this installer
 * only ever needs to add/flip a small number of well-known keys, so a full
 * TOML parser dependency (that would also need externalizing, per the
 * native-module packaging constraint) isn't worth pulling in for this. */
function patchConfigToml(): { addedFeatureFlag: boolean; addedMemoryDisable: boolean } {
  const file = configFile();
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let addedFeatureFlag = false;
  let addedMemoryDisable = false;

  if (!featureFlagEnabled()) {
    if (/^\[features\]\s*$/m.test(content)) {
      content = content.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true');
    } else {
      content += `${content.endsWith('\n') || content === '' ? '' : '\n'}\n[features]\ncodex_hooks = true\n`;
    }
    addedFeatureFlag = true;
  }

  const hasGenerateFalse = /generate_memories\s*=\s*false/.test(content);
  const hasUseFalse = /use_memories\s*=\s*false/.test(content);
  if (!hasGenerateFalse || !hasUseFalse) {
    if (/^\[memories\]\s*$/m.test(content)) {
      content = content.replace(/^\[memories\]\s*$/m, '[memories]\ngenerate_memories = false\nuse_memories = false');
    } else {
      content += `${content.endsWith('\n') || content === '' ? '' : '\n'}\n[memories]\ngenerate_memories = false\nuse_memories = false\n`;
    }
    addedMemoryDisable = true;
  }

  if (addedFeatureFlag || addedMemoryDisable) {
    fs.mkdirSync(codexHome(), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { addedFeatureFlag, addedMemoryDisable };
}

export function install(pluginRoot: string = defaultPluginRoot()): void {
  let config = loadExisting();
  config = stripOwnedEntries(config);
  const template = loadTemplate(pluginRoot);
  config = mergeTemplate(config, template);
  writeConfig(config);

  const { addedFeatureFlag, addedMemoryDisable } = patchConfigToml();

  console.log(`Installed dMemo hooks into ${hooksFile()}`);
  console.log(`Plugin path: ${pluginRoot}`);
  console.log('Events: SessionStart, UserPromptSubmit, Stop, PreCompact');
  if (addedFeatureFlag) console.log(`Enabled [features] codex_hooks = true in ${configFile()}`);
  if (addedMemoryDisable) console.log(`Disabled Codex's native memory subsystem in ${configFile()}`);
}

export function uninstall(): void {
  const config = stripOwnedEntries(loadExisting());
  writeConfig(config);
  console.log(`Removed dMemo hooks from ${hooksFile()}`);
}

function main(): number {
  if (process.platform === 'win32') {
    console.error(
      'Codex lifecycle hooks on native Windows require a shell capable of the ' +
        '`VAR=1 node ...` command form used here. Re-run this installer from WSL or Git Bash.'
    );
    return 2;
  }

  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    uninstall();
    return 0;
  }

  install();
  return 0;
}

// Only run when invoked directly (not when imported by tests) — standard
// CJS entry-point check (`require.main === module`), correct because this
// file is esbuild-bundled to `format: 'cjs'`, not executed as ESM.
if (require.main === module) {
  process.exitCode = main();
}
