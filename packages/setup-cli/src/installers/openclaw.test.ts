// Covers the rewritten OpenClaw installer (installers/openclaw.ts): install
// now claims the memory slot as a side effect (verified against
// openclaw/docs/plugins/memory-lancedb.md and src/plugins/slot-selection.ts
// upstream), so this installer verifies that with `openclaw config get
// plugins.slots.memory --json` instead of printing manual slot-editing
// instructions. These tests fake the `openclaw` binary on PATH so every
// scenario (binary missing, install failure, slot not claimed, slot claimed)
// is fully controllable without a real OpenClaw install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installOpenClaw } from './openclaw.js';

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-openclaw-test-'));
}

function fakeOpenclawBin(script: string): NodeJS.ProcessEnv {
  const binDir = scratchDir();
  const bin = path.join(binDir, 'openclaw');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { ...process.env, PATH: binDir };
}

// $SLOT_OWNER controls what `config get plugins.slots.memory --json` reports
// back, so each test can simulate "slot claimed" vs. "another plugin still
// owns it" independently of whether `plugins install` itself succeeded.
const INSTALL_OK_SLOT_CLAIMED = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-openclaw"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then echo "installed $3"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "\\"dmemo\\""; exit 0; fi
exit 1
`;

const INSTALL_OK_SLOT_NOT_CLAIMED = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-openclaw"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then echo "installed $3"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "\\"memory-core\\""; exit 0; fi
exit 1
`;

const INSTALL_FAILS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-openclaw"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then echo "package not found" >&2; exit 1; fi
exit 1
`;

// The exact refusal a real re-run produces (reported from a live
// `npx @dmemo/cli setup` second run): OpenClaw will not clobber a plugin it
// already tracks, and names the two commands that do work.
const ALREADY_EXISTS = `plugin already exists: $HOME/.openclaw/npm/projects/dmemo-openclaw-plugin-3a233cbdf3/node_modules/@dmemo/openclaw-plugin (delete it first)
Use 'openclaw plugins update <id-or-npm-spec>' to upgrade the tracked plugin, or rerun install with '--force' to replace it.`;

const ALREADY_EXISTS_FORCE_OK = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-openclaw"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  if [ "$4" = "--force" ]; then echo "replaced $3"; exit 0; fi
  echo "${ALREADY_EXISTS}" >&2; exit 1
fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "\\"dmemo\\""; exit 0; fi
exit 1
`;

const ALREADY_EXISTS_ONLY_UPDATE_OK = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-openclaw"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "update" ]; then echo "updated $3"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then echo "${ALREADY_EXISTS}" >&2; exit 1; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "\\"dmemo\\""; exit 0; fi
exit 1
`;

const ALREADY_EXISTS_NOTHING_WORKS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-openclaw"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then echo "${ALREADY_EXISTS}" >&2; exit 1; fi
if [ "$1" = "plugins" ] && [ "$2" = "update" ]; then echo "registry unreachable" >&2; exit 1; fi
exit 1
`;

const INSTALL_OK_CONFIG_GET_FAILS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-openclaw"; exit 0; fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then echo "installed $3"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "config path not found" >&2; exit 1; fi
exit 1
`;

test('openclaw binary missing: non-fatal, reports not attempted', () => {
  const env = { ...process.env, PATH: scratchDir() };
  const result = installOpenClaw(env);
  assert.equal(result.attempted, false);
  assert.equal(result.succeeded, false);
  assert.equal(result.slotClaimed, undefined, 'never got far enough to check the slot');
  assert.match(result.configGuidance, /openclaw plugins install @dmemo\/openclaw-plugin/);
});

test('install fails outright (package unresolvable): non-fatal, no slot check attempted', () => {
  const env = fakeOpenclawBin(INSTALL_FAILS);
  const result = installOpenClaw(env);
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, false);
  assert.equal(result.slotClaimed, undefined);
  assert.match(result.error ?? '', /package not found/);
});

test('install succeeds and the memory slot is verified claimed', () => {
  const env = fakeOpenclawBin(INSTALL_OK_SLOT_CLAIMED);
  const result = installOpenClaw(env);
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, true);
  assert.equal(result.slotClaimed, true);
  assert.equal(result.slotOwner, 'dmemo');
  assert.equal(result.error, undefined);
});

test('install reports success but another plugin still owns the slot: overall result is NOT success', () => {
  const env = fakeOpenclawBin(INSTALL_OK_SLOT_NOT_CLAIMED);
  const result = installOpenClaw(env);
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, false, 'a claimed install with an unclaimed slot must not report success');
  assert.equal(result.slotClaimed, false);
  assert.equal(result.slotOwner, 'memory-core');
  assert.match(result.error ?? '', /memory-core/);
  assert.match(result.error ?? '', /not claimed|not "dmemo"/i);
});

test('install succeeds but the slot verification command itself fails: reported as not succeeded, not silently OK', () => {
  const env = fakeOpenclawBin(INSTALL_OK_CONFIG_GET_FAILS);
  const result = installOpenClaw(env);
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? '', /verifying/);
});

// --- re-running `dmemo setup` -------------------------------------------
//
// The reported bug: a second `npx @dmemo/cli setup` reported openclaw as a
// failed step, because `plugins install` exits non-zero on a plugin it
// already tracks. "Already installed" is the end state we wanted, so it must
// resolve to success, not to a red line.

test('re-run: install refuses because the plugin exists, --force replaces it and the step succeeds', () => {
  const env = fakeOpenclawBin(ALREADY_EXISTS_FORCE_OK);
  const result = installOpenClaw(env);
  assert.equal(result.succeeded, true, 'a second setup run must not report openclaw as failed');
  assert.equal(result.replaced, true, 'the caller needs to know it replaced rather than freshly installed');
  assert.equal(result.slotClaimed, true, 'the slot is still verified after a forced replace');
  assert.equal(result.error, undefined);
});

test('re-run: when --force is unavailable, `plugins update` is the documented fallback', () => {
  const env = fakeOpenclawBin(ALREADY_EXISTS_ONLY_UPDATE_OK);
  const result = installOpenClaw(env);
  assert.equal(result.succeeded, true);
  assert.equal(result.replaced, true);
  assert.equal(result.slotClaimed, true);
});

test('re-run: neither --force nor update works — reported as a failure, with both commands named', () => {
  const env = fakeOpenclawBin(ALREADY_EXISTS_NOTHING_WORKS);
  const result = installOpenClaw(env);
  assert.equal(result.succeeded, false, 'a genuinely stuck install must not be papered over');
  assert.match(result.error ?? '', /--force/);
  assert.match(result.error ?? '', /plugins update/);
});

test('a real install failure is never mistaken for "already installed"', () => {
  // Guards the classifier: INSTALL_FAILS says "package not found", which must
  // not trigger the --force retry path that "already exists" does.
  const env = fakeOpenclawBin(INSTALL_FAILS);
  const result = installOpenClaw(env);
  assert.equal(result.succeeded, false);
  assert.equal(result.replaced, undefined, 'no replace should have been attempted');
});

test('configGuidance never tells the user to hand-edit plugins.slots.memory', () => {
  const env = fakeOpenclawBin(INSTALL_OK_SLOT_CLAIMED);
  const result = installOpenClaw(env);
  assert.doesNotMatch(result.configGuidance, /plugins\.slots\.memory\s*=/);
  // The one thing install genuinely doesn't set — the wallet key — must
  // still be called out.
  assert.match(result.configGuidance, /privateKey/);
});
