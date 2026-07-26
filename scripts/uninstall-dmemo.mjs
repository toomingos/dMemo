#!/usr/bin/env node
// Full uninstaller — removes dMemo from every host on this machine and, by
// default, from `~/.dmemo` too. Written for the release-testing loop: the
// only way to exercise the real first-run path (`npx @dmemo/cli setup`) is to
// get back to a machine that has never seen dMemo, and no single host command
// does that.
//
// Each host is uninstalled through its own native command where one exists,
// because those commands know things this script shouldn't have to (OpenClaw
// resets the `memory` slot to `memory-core`, Claude Code rewrites three
// separate JSON files). Where a host has no uninstall path, or where its
// uninstall is incomplete, this script closes the gap:
//
//   Claude Code  `claude plugin uninstall` + `marketplace remove`, then the
//                cache/marketplace clones those leave behind.
//   Codex        `install-codex-hooks.cjs --uninstall` removes the hooks but
//                NOT the `config.toml` edits `install()` made — including
//                `[memories] generate_memories/use_memories = false`, which
//                disables Codex's *native* memory. Left alone, uninstalling
//                dMemo leaves Codex with no memory at all. See revertCodexConfig.
//   OpenCode     No uninstall command exists at all (`opencode plugin` is
//                install-only), so the config array is edited directly.
//   OpenClaw     `openclaw plugins uninstall --force`, plus the npm project
//                directory it leaves behind.
//
// SAFETY: `~/.dmemo/config.json` holds the private key that is the ONLY way to
// decrypt memories already written to 0G Storage. Deleting it is irreversible
// and unrecoverable. So a timestamped backup of everything this script touches
// is taken FIRST, and removal is skipped entirely if the backup fails.
//
// Usage:
//   node scripts/uninstall-dmemo.mjs                 # back up, then remove everything
//   node scripts/uninstall-dmemo.mjs --dry-run       # print the plan, change nothing
//   node scripts/uninstall-dmemo.mjs --keep-wallet   # hosts only, leave ~/.dmemo alone
//   node scripts/uninstall-dmemo.mjs --only=codex    # one host (repeatable)
//   node scripts/uninstall-dmemo.mjs --no-backup     # skip the backup (not advised)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME ?? os.homedir();
const DMEMO_HOME = process.env.DMEMO_HOME ?? path.join(HOME, '.dmemo');
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HOME, '.codex');
const CLAUDE_HOME = path.join(HOME, '.claude');
const OPENCLAW_HOME = path.join(HOME, '.openclaw');
const OPENCODE_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'),
  'opencode',
);

const MARKETPLACE = 'dmemo-plugins';
const PLUGIN_ID = 'dmemo';
const HOSTS = ['claude', 'codex', 'opencode', 'openclaw'];

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const KEEP_WALLET = argv.includes('--keep-wallet');
const NO_BACKUP = argv.includes('--no-backup');
const only = argv.filter((a) => a.startsWith('--only=')).map((a) => a.slice('--only='.length));

const unknownHost = only.find((h) => !HOSTS.includes(h));
if (unknownHost) {
  console.error(`--only expects one of ${HOSTS.join(', ')}, got '${unknownHost}'`);
  process.exit(1);
}
const wants = (host) => only.length === 0 || only.includes(host);

const done = [];
const skipped = [];
const problems = [];

function log(msg) { console.log(msg); }
function note(msg) { console.log(`  ${msg}`); }
function fail(step, err) {
  const msg = err instanceof Error ? err.message : String(err);
  problems.push(`${step}: ${msg}`);
  console.log(`  ! ${msg}`);
}

// --- primitives --------------------------------------------------------------

function rm(target) {
  if (!fs.existsSync(target)) return false;
  if (DRY_RUN) { note(`would remove ${target}`); return true; }
  fs.rmSync(target, { recursive: true, force: true });
  note(`removed ${target}`);
  return true;
}

function writeJson(file, value) {
  if (DRY_RUN) { note(`would rewrite ${file}`); return; }
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  note(`rewrote ${file}`);
}

/** Run a host CLI. Never throws — a host that isn't installed, or that has
 * already had the plugin removed, is a normal outcome here, not an error. */
function run(bin, args) {
  if (DRY_RUN) { note(`would run: ${bin} ${args.join(' ')}`); return { ok: true, out: '' }; }
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() };
  }
}

function onPath(bin) {
  try {
    // `sh -c` rather than `{shell: true}`: the latter concatenates args
    // unescaped (Node DEP0190) and would warn on every call.
    execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- backup ------------------------------------------------------------------

/** Everything this script can delete, copied somewhere it won't. The wallet is
 * the reason this exists: `~/.dmemo/config.json` is unrecoverable once gone. */
function backup() {
  // Local time, not ISO/UTC: this name is read by a human comparing it against
  // when they ran the command, and an offset there reads as the wrong backup.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const dir = path.join(HOME, `dmemo-backup-${stamp}`);
  const targets = [
    [DMEMO_HOME, 'dotdmemo'],
    [path.join(CODEX_HOME, 'hooks.json'), 'codex-hooks.json'],
    [path.join(CODEX_HOME, 'config.toml'), 'codex-config.toml'],
    [path.join(OPENCLAW_HOME, 'openclaw.json'), 'openclaw.json'],
    [path.join(OPENCODE_DIR, 'opencode.json'), 'opencode.json'],
    [path.join(OPENCODE_DIR, 'opencode.jsonc'), 'opencode.jsonc'],
    [path.join(CLAUDE_HOME, 'settings.json'), 'claude-settings.json'],
    [path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), 'claude-installed_plugins.json'],
    [path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), 'claude-known_marketplaces.json'],
  ].filter(([src]) => fs.existsSync(src));

  if (targets.length === 0) return { dir: null, count: 0 };
  if (DRY_RUN) {
    note(`would back up ${targets.length} path(s) to ${dir}`);
    return { dir, count: targets.length };
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const [src, dest] of targets) fs.cpSync(src, path.join(dir, dest), { recursive: true });
  note(`backed up ${targets.length} path(s) to ${dir}`);
  return { dir, count: targets.length };
}

// --- Claude Code -------------------------------------------------------------

function uninstallClaude() {
  log('\nClaude Code');
  if (!onPath('claude')) { skipped.push('claude (not installed)'); return note('not installed — skipped'); }

  const un = run('claude', ['plugin', 'uninstall', `${PLUGIN_ID}@${MARKETPLACE}`]);
  note(un.ok ? 'plugin uninstalled' : `plugin uninstall reported: ${un.out.split('\n')[0] || 'nothing to remove'}`);
  const mk = run('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE]);
  note(mk.ok ? 'marketplace removed' : `marketplace remove reported: ${mk.out.split('\n')[0] || 'nothing to remove'}`);

  // The CLI deregisters the plugin but leaves the cloned marketplace and the
  // unpacked plugin cache on disk (~13 MB), which a later `marketplace add`
  // can serve stale. Remove them so a reinstall genuinely refetches.
  rm(path.join(CLAUDE_HOME, 'plugins', 'cache', MARKETPLACE));
  rm(path.join(CLAUDE_HOME, 'plugins', 'marketplaces', MARKETPLACE));
  done.push('claude');
}

// --- Codex -------------------------------------------------------------------

/** Strip the exact keys `install()` writes into config.toml. Deliberately
 * line-based and exact-match: this is a user-owned file that may contain
 * unrelated settings, so anything not written by dMemo is left untouched.
 * Sections are pruned only once empty, and the file only if it has nothing
 * left but whitespace. */
function revertCodexConfig() {
  const file = path.join(CODEX_HOME, 'config.toml');
  if (!fs.existsSync(file)) return;

  const OWNED = new Map([
    ['features', ['codex_hooks = true']],
    // install() disables Codex's own memory so the two don't double up.
    // Removing these restores Codex's defaults (memory on) rather than
    // leaving the user with no memory at all.
    ['memories', ['generate_memories = false', 'use_memories = false']],
  ]);

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const kept = [];
  let section = null;
  let removed = 0;
  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) { section = header[1]; kept.push(line); continue; }
    const owned = OWNED.get(section) ?? [];
    if (owned.includes(line.trim().replace(/\s+/g, ' '))) { removed++; continue; }
    kept.push(line);
  }
  if (removed === 0) return;

  // Drop any section header whose body is now empty.
  const pruned = [];
  for (let i = 0; i < kept.length; i++) {
    const header = kept[i].trim().match(/^\[([^\]]+)\]$/);
    if (header && OWNED.has(header[1])) {
      let j = i + 1;
      while (j < kept.length && kept[j].trim() === '') j++;
      const atEnd = j >= kept.length;
      const nextIsHeader = !atEnd && /^\[[^\]]+\]$/.test(kept[j].trim());
      if (atEnd || nextIsHeader) { i = j - 1; continue; }
    }
    pruned.push(kept[i]);
  }

  if (DRY_RUN) { note(`would revert ${removed} dMemo key(s) in ${file}`); return; }
  if (pruned.join('').trim() === '') {
    fs.rmSync(file);
    note(`removed ${file} (contained only dMemo settings)`);
  } else {
    fs.writeFileSync(file, pruned.join('\n'));
    note(`reverted ${removed} dMemo key(s) in ${file} (Codex native memory re-enabled)`);
  }
}

/** Fallback for when ~/.dmemo is already gone: same filter the bundled
 * installer applies — any hook whose command carries the DMEMO_HOOK marker. */
function stripCodexHooks() {
  const file = path.join(CODEX_HOME, 'hooks.json');
  if (!fs.existsSync(file)) return false;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }

  const hooks = parsed.hooks ?? {};
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const before = (hooks[event] ?? []).length;
    hooks[event] = (hooks[event] ?? []).filter(
      (m) => !(m.hooks ?? []).some((h) => typeof h.command === 'string'
        && (h.command.includes('DMEMO_HOOK=1') || h.command.includes('.dmemo/codex-plugin'))),
    );
    removed += before - hooks[event].length;
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (removed === 0) return false;
  parsed.hooks = hooks;
  writeJson(file, parsed);
  return true;
}

function uninstallCodex() {
  log('\nCodex');
  const installer = path.join(DMEMO_HOME, 'codex-plugin', 'scripts', 'install-codex-hooks.cjs');
  const hooksFile = path.join(CODEX_HOME, 'hooks.json');

  if (!fs.existsSync(hooksFile) && !fs.existsSync(installer)) {
    skipped.push('codex (nothing installed)');
    return note('no hooks installed — skipped');
  }

  // Prefer the vendored installer: it is the code that wrote these hooks, so
  // it stays correct if the hook set ever changes.
  if (fs.existsSync(installer)) {
    const res = run('node', [installer, '--uninstall']);
    note(res.ok ? 'hooks removed via bundled installer' : `installer failed, falling back: ${res.out.split('\n')[0]}`);
    if (!res.ok) stripCodexHooks();
  } else {
    note('bundled installer missing (~/.dmemo already removed) — filtering hooks directly');
    stripCodexHooks();
  }

  // The bundled uninstaller does NOT do this, which is the whole reason this
  // step exists. Without it Codex is left with its native memory disabled.
  revertCodexConfig();

  // An empty hooks.json is dMemo's leftover, not a Codex artifact.
  if (fs.existsSync(hooksFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      if (Object.keys(parsed.hooks ?? {}).length === 0) rm(hooksFile);
    } catch { /* malformed — leave it for the user to look at */ }
  }
  done.push('codex');
}

// --- OpenCode ----------------------------------------------------------------

/** OpenCode merges opencode.json and opencode.jsonc, so both need checking.
 * Only the .json variant is rewritten structurally; .jsonc may carry comments
 * that JSON.parse would silently destroy, so that one is reported, not edited. */
function uninstallOpencode() {
  log('\nOpenCode');
  const json = path.join(OPENCODE_DIR, 'opencode.json');
  const jsonc = path.join(OPENCODE_DIR, 'opencode.jsonc');
  let touched = false;

  if (fs.existsSync(json)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(json, 'utf8')); }
    catch (err) { fail('opencode.json', err); parsed = null; }
    if (parsed && Array.isArray(parsed.plugin)) {
      const kept = parsed.plugin.filter((p) => typeof p !== 'string' || !p.startsWith('@dmemo/'));
      if (kept.length !== parsed.plugin.length) {
        if (kept.length === 0) delete parsed.plugin; else parsed.plugin = kept;
        writeJson(json, parsed);
        touched = true;
      }
    }
  }

  if (fs.existsSync(jsonc) && /@dmemo\//.test(fs.readFileSync(jsonc, 'utf8'))) {
    note(`! ${jsonc} references @dmemo/ — remove it by hand (not edited: comments would be lost)`);
    problems.push(`${jsonc} still references @dmemo/`);
  }

  // The local dev shim from install-adapters-local.mjs, if it is still around.
  rm(path.join(OPENCODE_DIR, 'plugins', 'dmemo.ts'));

  if (!touched) note('no @dmemo plugin entry found');
  if (!fs.existsSync(json) && !fs.existsSync(jsonc)) skipped.push('opencode (not configured)');
  else done.push('opencode');
}

// --- OpenClaw ----------------------------------------------------------------

function uninstallOpenclaw() {
  log('\nOpenClaw');
  if (!onPath('openclaw') && !fs.existsSync(OPENCLAW_HOME)) {
    skipped.push('openclaw (not installed)');
    return note('not installed — skipped');
  }

  if (onPath('openclaw')) {
    // --force because the prompt has no TTY here; the native command is worth
    // using because it also resets the exclusive `memory` slot.
    const res = run('openclaw', ['plugins', 'uninstall', PLUGIN_ID, '--force']);
    note(res.ok ? 'plugin uninstalled (memory slot reset)' : `uninstall reported: ${res.out.split('\n').pop() || 'nothing to remove'}`);
  }

  // It removes node_modules/@dmemo/openclaw-plugin but leaves the npm project
  // directory (and @dmemo/core inside it) behind.
  const projects = path.join(OPENCLAW_HOME, 'npm', 'projects');
  if (fs.existsSync(projects)) {
    for (const entry of fs.readdirSync(projects)) {
      if (entry.startsWith('dmemo-')) rm(path.join(projects, entry));
    }
  }
  done.push('openclaw');
}

// --- main --------------------------------------------------------------------

log(DRY_RUN ? 'DRY RUN — nothing will be changed.\n' : 'Uninstalling dMemo.\n');

if (!NO_BACKUP) {
  log('Backup');
  try {
    const { dir, count } = backup();
    if (count === 0) note('nothing installed to back up');
    else if (!DRY_RUN) note('this is the only copy of your wallet key — keep it until you are sure');
    if (dir) process.env.DMEMO_LAST_BACKUP = dir;
  } catch (err) {
    console.error(`\nBackup failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Refusing to remove anything without one. Re-run with --no-backup to override.');
    process.exit(1);
  }
} else {
  log('Backup\n  skipped (--no-backup)');
}

if (wants('claude')) { try { uninstallClaude(); } catch (err) { fail('claude', err); } }
// Codex must run before ~/.dmemo is removed: its uninstaller lives there.
if (wants('codex')) { try { uninstallCodex(); } catch (err) { fail('codex', err); } }
if (wants('opencode')) { try { uninstallOpencode(); } catch (err) { fail('opencode', err); } }
if (wants('openclaw')) { try { uninstallOpenclaw(); } catch (err) { fail('openclaw', err); } }

log('\nShared config');
if (KEEP_WALLET) {
  note(`kept ${DMEMO_HOME} (--keep-wallet)`);
} else if (only.length > 0) {
  note(`kept ${DMEMO_HOME} (--only was used; pass no --only to remove it)`);
} else if (!rm(DMEMO_HOME)) {
  note('nothing at ' + DMEMO_HOME);
}

log('\n---');
if (done.length) log(`Uninstalled: ${done.join(', ')}`);
if (skipped.length) log(`Skipped: ${skipped.join(', ')}`);
if (problems.length) {
  log(`\nNeeds attention:`);
  for (const p of problems) log(`  - ${p}`);
}
if (!DRY_RUN && !NO_BACKUP && process.env.DMEMO_LAST_BACKUP) {
  log(`\nBackup: ${process.env.DMEMO_LAST_BACKUP}`);
  log('Reinstall with the same wallet:');
  log(`  npx @dmemo/cli setup --testnet --import-key "$(node -p "require('${process.env.DMEMO_LAST_BACKUP}/dotdmemo/config.json').DMEMO_PRIVATE_KEY")"`);
}
log('\nRestart any running agent host before testing a fresh install —');
log('hooks stay resident in a live process after their files are gone.');

process.exitCode = problems.length > 0 ? 1 : 0;
