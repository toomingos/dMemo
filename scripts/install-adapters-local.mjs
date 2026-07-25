#!/usr/bin/env node
// Local dev installer — wires every host adapter to THIS checkout, so the
// whole stack can be manually tested before anything is published.
//
// `packages/setup-cli` (`npx dmemo setup`) is the real end-user path, but it
// points three of the four hosts at npm/GitHub coordinates that do not exist
// yet (`@dmemo/opencode-plugin`, `@dmemo/openclaw-plugin`,
// `dmemo-ai/claude-dmemo`). This script substitutes local equivalents that
// every host documents as first-class:
//
//   Claude Code  `claude plugin marketplace add <local dir>`      (marketplace source accepts a path)
//   Codex        vendored install-codex-hooks.cjs -> ~/.codex/hooks.json  (already fully local)
//   OpenCode     ~/.config/opencode/plugins/dmemo.ts shim         (global plugin dir, docs: opencode.ai/docs/plugins)
//   OpenClaw     `openclaw plugins install --link <pkg dir>` + ~/.openclaw/openclaw.json merge
//
// Everything is idempotent, skips hosts that aren't installed, and supports
// `--uninstall`. It never writes a private key: all four hosts read
// `~/.dmemo/config.json`, which `dmemo setup` owns.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME ?? os.homedir();
const DMEMO_HOME = process.env.DMEMO_HOME ?? path.join(HOME, '.dmemo');
const DMEMO_CONFIG = path.join(DMEMO_HOME, 'config.json');

const CLAUDE_MARKETPLACE_DIR = path.join(REPO, 'claude-dmemo');
const CLAUDE_MARKETPLACE_NAME = 'dmemo-plugins';
const CODEX_PLUGIN_SCRIPTS = path.join(REPO, 'claude-dmemo', 'plugin', 'scripts');
const OPENCODE_PLUGIN_DIST = path.join(REPO, 'packages', 'opencode-plugin', 'dist', 'index.js');
const OPENCLAW_PLUGIN_DIR = path.join(REPO, 'packages', 'openclaw-plugin');

const args = new Set(process.argv.slice(2));
const UNINSTALL = args.has('--uninstall');
const SKIP_BUILD = args.has('--skip-build');
const SKIP_WARMUP = args.has('--skip-warmup');
const ONLY = [...args].find((a) => a.startsWith('--only='))?.slice('--only='.length);

const results = [];
function record(host, status, detail) {
  results.push({ host, status, detail });
  const icon = { ok: '✔', skip: '–', warn: '!', fail: '✘' }[status] ?? '?';
  console.log(`  ${icon} ${host}: ${detail}`);
}
function wanted(host) {
  return !ONLY || ONLY.split(',').includes(host);
}
// Some hosts ship their own installer that drops a binary outside a
// login-shell PATH (opencode.ai/install → ~/.opencode/bin), so a plain
// `which` under-detects when this script runs from a non-interactive shell.
const EXTRA_BIN_PATHS = {
  opencode: [path.join(HOME, '.opencode', 'bin', 'opencode')],
  openclaw: [path.join(HOME, '.openclaw', 'bin', 'openclaw')],
  codex: [path.join(HOME, '.codex', 'bin', 'codex')],
};

function have(bin) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return (EXTRA_BIN_PATHS[bin] ?? []).some((p) => fs.existsSync(p));
  }
}

/** Absolute path to a host binary, so exec works even when PATH lacks it. */
function bin(name) {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
      .trim()
      .split('\n')[0];
  } catch {
    return (EXTRA_BIN_PATHS[name] ?? []).find((p) => fs.existsSync(p)) ?? name;
  }
}
function run(exe, argv, opts = {}) {
  return execFileSync(exe, argv, { encoding: 'utf8', stdio: 'pipe', ...opts });
}
function errMsg(err) {
  const out = [err?.stdout, err?.stderr].filter(Boolean).join('').trim();
  return out || (err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------- preflight

function preflight() {
  console.log('\nPreflight');

  if (!SKIP_BUILD && !UNINSTALL) {
    process.stdout.write('  · building all packages (pnpm -r build)… ');
    try {
      run('pnpm', ['-r', 'build'], { cwd: REPO });
      console.log('done');
    } catch (err) {
      console.log('FAILED');
      console.error(errMsg(err));
      process.exit(1);
    }
  }

  if (!fs.existsSync(DMEMO_CONFIG)) {
    console.log(`  ! ${DMEMO_CONFIG} missing — no wallet configured.`);
    console.log('    Every adapter fails open (no-op) until you run:');
    console.log('      node packages/setup-cli/dist/cli.js setup');
    console.log('    (or `--import-key <0x…>` to reuse an already-funded wallet)');
  } else {
    let addr = '(unknown)';
    try {
      addr = JSON.parse(fs.readFileSync(DMEMO_CONFIG, 'utf8')).DMEMO_ADDRESS ?? addr;
    } catch {
      /* fail open — the adapters will report the real error */
    }
    console.log(`  ✔ wallet config: ${DMEMO_CONFIG} (${addr})`);
  }
}

// The hook bundles lazily `npm install` better-sqlite3 + fastembed into
// ~/.dmemo/native on their first run (native-bootstrap.ts). Doing that here
// instead means the first real agent turn isn't a 60-90s stall inside a hook
// timeout. Also downloads the bge-small-en-v1.5 ONNX weights on first embed.
function warmup() {
  if (SKIP_WARMUP || UNINSTALL) return;
  console.log('\nWarming native deps (better-sqlite3 + fastembed → ~/.dmemo/native)');
  const status = path.join(CODEX_PLUGIN_SCRIPTS, 'status.cjs');
  if (!fs.existsSync(status)) {
    console.log('  – skipped: bundles not built');
    return;
  }
  try {
    const out = run('node', [status], {
      cwd: REPO,
      env: { ...process.env, DMEMO_DEBUG: '1' },
      timeout: 15 * 60_000,
    });
    console.log(
      out
        .trim()
        .split('\n')
        .map((l) => `  │ ${l}`)
        .join('\n')
    );
  } catch (err) {
    console.log(`  ! warmup did not complete cleanly: ${errMsg(err).split('\n')[0]}`);
    console.log('    (adapters fail open; the first real turn will retry the bootstrap)');
  }
}

// ------------------------------------------------------------- Claude Code

function claudeCode() {
  if (!have('claude')) return record('claude-code', 'skip', 'claude CLI not on PATH');

  if (UNINSTALL) {
    try {
      run(bin('claude'), ['plugin', 'uninstall', `dmemo@${CLAUDE_MARKETPLACE_NAME}`]);
    } catch {
      /* not installed */
    }
    try {
      run(bin('claude'), ['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE_NAME]);
    } catch {
      /* not added */
    }
    return record('claude-code', 'ok', 'plugin + marketplace removed');
  }

  // `marketplace add` accepts a URL, path, or GitHub repo — a local path is
  // the documented way to test a marketplace before publishing it.
  try {
    run(bin('claude'), ['plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE_DIR]);
  } catch (err) {
    // Already added is not an error for our purposes; re-sync instead so a
    // rebuilt bundle actually reaches the installed copy.
    if (!/already/i.test(errMsg(err))) return record('claude-code', 'fail', errMsg(err).split('\n')[0]);
  }
  try {
    run(bin('claude'), ['plugin', 'marketplace', 'update', CLAUDE_MARKETPLACE_NAME]);
  } catch {
    /* best effort */
  }

  try {
    run(bin('claude'), ['plugin', 'install', `dmemo@${CLAUDE_MARKETPLACE_NAME}`]);
    return record('claude-code', 'ok', 'dmemo@dmemo-plugins installed (restart Claude Code)');
  } catch (err) {
    if (/already installed/i.test(errMsg(err))) {
      // Claude Code snapshots the plugin into
      // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ — a copy,
      // not a symlink — so a rebuild only lands after an explicit update.
      try {
        run(bin('claude'), ['plugin', 'update', `dmemo@${CLAUDE_MARKETPLACE_NAME}`]);
        return record('claude-code', 'ok', 'already installed → updated from local build (restart Claude Code)');
      } catch (updateErr) {
        return record('claude-code', 'warn', `installed, but update failed: ${errMsg(updateErr).split('\n')[0]}`);
      }
    }
    return record('claude-code', 'fail', errMsg(err).split('\n')[0]);
  }
}

// -------------------------------------------------------------------- Codex

function codex() {
  const codexHome = process.env.CODEX_HOME ?? path.join(HOME, '.codex');
  if (!have('codex') && !fs.existsSync(codexHome)) {
    return record('codex', 'skip', 'codex CLI not on PATH and ~/.codex absent — `npm i -g @openai/codex`');
  }

  const installer = path.join(CODEX_PLUGIN_SCRIPTS, 'install-codex-hooks.cjs');
  if (!fs.existsSync(installer)) return record('codex', 'fail', `missing ${installer} — run pnpm -r build`);

  // Point hooks.json straight at the checkout's bundles (not the ~/.dmemo
  // copy `dmemo setup` makes) so `pnpm -r build` is picked up with no reinstall.
  try {
    const out = run('node', [installer, ...(UNINSTALL ? ['--uninstall'] : [])], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    return record('codex', 'ok', `${UNINSTALL ? 'removed from' : 'hooks written to'} ${path.join(codexHome, 'hooks.json')}${out.trim() ? ` — ${out.trim().split('\n').pop()}` : ''}`);
  } catch (err) {
    return record('codex', 'fail', errMsg(err).split('\n')[0]);
  }
}

// ----------------------------------------------------------------- OpenCode

// OpenCode resolves plugins from four sources; the global plugin dir
// (~/.config/opencode/plugins/, .js/.ts files) needs no npm package, so a
// one-line re-export shim pointed at the local dist is the whole install.
function opencode() {
  const cfgDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), 'opencode');
  if (!have('opencode') && !fs.existsSync(cfgDir)) {
    return record('opencode', 'skip', 'opencode CLI not on PATH and config dir absent — `npm i -g opencode-ai`');
  }

  const shimPath = path.join(cfgDir, 'plugins', 'dmemo.ts');

  if (UNINSTALL) {
    fs.rmSync(shimPath, { force: true });
    return record('opencode', 'ok', `removed ${shimPath}`);
  }

  if (!fs.existsSync(OPENCODE_PLUGIN_DIST)) {
    return record('opencode', 'fail', `missing ${OPENCODE_PLUGIN_DIST} — run pnpm -r build`);
  }

  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.writeFileSync(
    shimPath,
    [
      '// Generated by dMemo scripts/install-adapters-local.mjs — local dev shim.',
      '// Re-exports the plugin from the monorepo checkout so `pnpm -r build`',
      '// takes effect with no reinstall. The published path is instead an',
      '// "@dmemo/opencode-plugin" entry in opencode.json\'s "plugin" array.',
      `export { default } from ${JSON.stringify(OPENCODE_PLUGIN_DIST)};`,
      '',
    ].join('\n')
  );
  return record('opencode', 'ok', `${shimPath} → ${path.relative(REPO, OPENCODE_PLUGIN_DIST)}`);
}

// ----------------------------------------------------------------- OpenClaw

// `openclaw plugins install ./dir` (and `--link`) runs a code-safety scan
// that rejects any node_modules symlink pointing outside the install root —
// which is exactly what a pnpm workspace looks like (`node_modules/ethers ->
// ../../../node_modules/.pnpm/...`). The documented dev flow assumes a flat
// npm layout, so instead of weakening the scanner via
// `security.installPolicy`, we hand OpenClaw what a *published* plugin looks
// like: a staging dir with one esbuild-bundled ESM file and no node_modules
// at all. Same technique the Claude Code / Codex hook bundles already use
// (packages/node-adapter/scripts/build.cjs), sharing its externals list.
//
// This staging step exists ONLY for local installs. Published to npm,
// `@dmemo/openclaw-plugin` resolves `@dmemo/core` from the registry
// normally and needs no bundling.
function stageOpenClawBundle() {
  const esbuild = createRequire(path.join(REPO, 'packages', 'node-adapter', 'package.json'))('esbuild');
  const externals = JSON.parse(
    fs.readFileSync(path.join(REPO, 'packages', 'node-adapter', 'scripts', 'externals.json'), 'utf8')
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_PLUGIN_DIR, 'package.json'), 'utf8'));

  const staging = path.join(DMEMO_HOME, 'openclaw-plugin-local');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'dist'), { recursive: true });

  esbuild.buildSync({
    entryPoints: [path.join(OPENCLAW_PLUGIN_DIR, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(staging, 'dist', 'index.js'),
    external: [...externals.native, ...externals.ossOptionalBackends],
    // @dmemo/core reaches for `import.meta.url` (createRequire) and CJS
    // interop inside the bundle needs real `require`/__dirname — esbuild
    // does not synthesize these for ESM output, so inject them.
    banner: {
      js: [
        "import { createRequire as __dmemoCreateRequire } from 'node:module';",
        "import { fileURLToPath as __dmemoFileURLToPath } from 'node:url';",
        "import { dirname as __dmemoDirname } from 'node:path';",
        'const require = __dmemoCreateRequire(import.meta.url);',
        'const __filename = __dmemoFileURLToPath(import.meta.url);',
        'const __dirname = __dmemoDirname(__filename);',
      ].join('\n'),
    },
    logLevel: 'warning',
  });

  fs.writeFileSync(
    path.join(staging, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        type: 'module',
        license: pkg.license,
        // Pre-runtime discovery metadata — OpenClaw refuses to install
        // without it (docs/plugins/manifest.md).
        openclaw: pkg.openclaw,
      },
      null,
      2
    ) + '\n'
  );
  for (const f of ['openclaw.plugin.json', 'LICENSE', 'README.md']) {
    const src = path.join(OPENCLAW_PLUGIN_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(staging, f));
  }
  return staging;
}

function openclawConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH ?? path.join(HOME, '.openclaw', 'openclaw.json');
}

function readOpenClawConfig() {
  const p = openclawConfigPath();
  if (!fs.existsSync(p)) return { cfg: {}, parsed: true };
  try {
    return { cfg: JSON.parse(fs.readFileSync(p, 'utf8')) ?? {}, parsed: true };
  } catch {
    // JSON5 (comments/trailing commas) is legal here but not round-trippable
    // by JSON.stringify — never clobber a config we can't faithfully rewrite.
    return { cfg: {}, parsed: false };
  }
}

/** Drop dMemo's own plugin entry + memory-slot claim, leaving everything
 * else untouched. Safe to call when they were never set. */
function clearOpenClawConfigEntries() {
  const { cfg, parsed } = readOpenClawConfig();
  if (!parsed) return false;
  let changed = false;
  if (cfg.plugins?.entries?.dmemo) {
    delete cfg.plugins.entries.dmemo;
    changed = true;
  }
  if (cfg.plugins?.slots?.memory === 'dmemo') {
    delete cfg.plugins.slots.memory;
    changed = true;
  }
  if (changed) fs.writeFileSync(openclawConfigPath(), JSON.stringify(cfg, null, 2) + '\n');
  return changed;
}

/** Where `openclaw plugins install` copies a plugin to — it re-homes the
 * staged dir under ~/.openclaw/extensions/<manifest id>/, not under the
 * package name it was staged as. */
function installedOpenClawDir() {
  const base = path.join(process.env.OPENCLAW_HOME ?? path.join(HOME, '.openclaw'), 'extensions');
  const p = path.join(base, 'dmemo');
  return fs.existsSync(p) ? p : null;
}

// better-sqlite3 / fastembed stay `external` in the bundle (native .node
// bindings can't be inlined). The hook bundles solve this with
// native-bootstrap.ts's node_modules symlink next to the running file; do
// the same for the installed OpenClaw plugin — but AFTER install, so the
// code-safety scan never sees the escaping symlink.
function linkNativeDepsInto(dir) {
  if (!dir) return;
  const target = path.join(DMEMO_HOME, 'native', 'node_modules');
  if (!fs.existsSync(target)) return;
  const link = path.join(dir, 'node_modules');
  try {
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, 'dir');
  } catch {
    /* best effort — the plugin fails open if the native deps don't resolve */
  }
}

// `openclaw plugins install --link <dir>` links a development checkout
// instead of copying it, so rebuilds land without reinstalling. Config lives
// in ~/.openclaw/openclaw.json (JSON5; $OPENCLAW_CONFIG_PATH overrides).
function openclaw() {
  if (!have('openclaw')) {
    return record('openclaw', 'skip', 'openclaw CLI not on PATH — `npm i -g openclaw@latest`');
  }

  if (UNINSTALL) {
    try {
      run(bin('openclaw'), ['plugins', 'uninstall', 'dmemo']);
    } catch {
      /* not installed */
    }
    return record('openclaw', 'ok', 'plugin uninstalled (memory slot left for you to re-point)');
  }

  // A config that names a plugin which isn't installed makes OpenClaw treat
  // the whole config as invalid and refuse to run ANY command — including
  // the install that would fix it. So always clear our own entries before
  // installing, and re-add them only once the plugin is really on disk.
  clearOpenClawConfigEntries();

  let staged;
  try {
    staged = stageOpenClawBundle();
  } catch (err) {
    return record('openclaw', 'fail', `staging bundle failed: ${errMsg(err).split('\n')[0]}`);
  }

  try {
    run(bin('openclaw'), ['plugins', 'install', '--force', staged]);
  } catch (err) {
    return record('openclaw', 'fail', errMsg(err).split('\n')[0]);
  }

  linkNativeDepsInto(installedOpenClawDir());

  // Claim the exclusive memory slot + supply config. `privateKey` is
  // deliberately absent: config.ts falls back to ~/.dmemo/config.json (the
  // same file every other host reads), so the key never enters OpenClaw's
  // config file at all. A `"${DMEMO_PRIVATE_KEY}"` placeholder would work too
  // but makes OpenClaw print a "Missing env var" warning on every single
  // command, since its own daemon environment has no such var.
  const cfgPath = openclawConfigPath();
  const { cfg, parsed } = readOpenClawConfig();
  if (!parsed) {
    return record(
      'openclaw',
      'warn',
      `plugin linked, but ${cfgPath} is JSON5/unparseable — add plugins.slots.memory="dmemo" by hand (see packages/openclaw-plugin/README.md)`
    );
  }

  cfg.plugins ??= {};
  cfg.plugins.slots ??= {};
  cfg.plugins.slots.memory = 'dmemo';
  cfg.plugins.entries ??= {};
  const priorConfig = { ...(cfg.plugins.entries.dmemo?.config ?? {}) };
  delete priorConfig.privateKey; // migrate off any placeholder a prior run wrote
  cfg.plugins.entries.dmemo = {
    ...(cfg.plugins.entries.dmemo ?? {}),
    enabled: true,
    // The capture leg lives on the `agent_end` typed hook, which OpenClaw
    // blocks for non-bundled plugins unless conversation access is granted
    // explicitly — without this the plugin loads and recalls but never
    // saves anything, which looks like "memory silently does nothing".
    hooks: { ...(cfg.plugins.entries.dmemo?.hooks ?? {}), allowConversationAccess: true },
    config: {
      scope: 'default',
      network: 'testnet',
      ...priorConfig,
    },
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return record('openclaw', 'ok', `linked + memory slot claimed in ${cfgPath}`);
}

// --------------------------------------------------------------------- main

console.log(`dMemo local adapter installer — ${UNINSTALL ? 'UNINSTALL' : 'install'} from ${REPO}`);
preflight();
if (!UNINSTALL) warmup();

console.log(`\nHosts`);
if (wanted('claude-code')) claudeCode();
if (wanted('codex')) codex();
if (wanted('opencode')) opencode();
if (wanted('openclaw')) openclaw();

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');

if (!UNINSTALL) {
  console.log('\nNext');
  console.log('  · restart each host so it re-reads its plugin/hook config');
  console.log('  · DMEMO_DEBUG=1 makes every adapter append to ~/.dmemo/hooks.log');
  console.log(`  · check state any time:  node ${path.relative(REPO, path.join(CODEX_PLUGIN_SCRIPTS, 'status.cjs'))}`);
  if (skipped.length) {
    console.log(`  · not installed on this machine: ${skipped.map((r) => r.host).join(', ')}`);
  }
}

process.exitCode = failed.length ? 1 : 0;
