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

test('configGuidance never tells the user to hand-edit plugins.slots.memory', () => {
  const env = fakeOpenclawBin(INSTALL_OK_SLOT_CLAIMED);
  const result = installOpenClaw(env);
  assert.doesNotMatch(result.configGuidance, /plugins\.slots\.memory\s*=/);
  // The one thing install genuinely doesn't set — the wallet key — must
  // still be called out.
  assert.match(result.configGuidance, /privateKey/);
});
