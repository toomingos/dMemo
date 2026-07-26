// Covers the Claude Code installer (installers/claudeCode.ts), with the
// `claude` binary faked on PATH so every branch is controllable without a
// real Claude Code install or a published marketplace repo.
//
// The case that motivated this file is the second one below: `dmemo setup`
// run twice reported claude-code as a failed step, because both `plugin
// marketplace add` and `plugin install` exit non-zero once their target is
// already there. That is the end state we asked for, so it is success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installClaudeCode } from './claudeCode.js';

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-claude-test-'));
}

function fakeClaudeBin(script: string): NodeJS.ProcessEnv {
  const binDir = scratchDir();
  const bin = path.join(binDir, 'claude');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { ...process.env, PATH: binDir };
}

const BOTH_OK = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-claude"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ]; then echo "added $4"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then echo "installed $3"; exit 0; fi
exit 1
`;

const BOTH_ALREADY_THERE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-claude"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ]; then echo "Marketplace dmemo-plugins already exists" >&2; exit 1; fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then echo "Plugin dmemo is already installed" >&2; exit 1; fi
exit 1
`;

const MARKETPLACE_ALREADY_INSTALL_FRESH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-claude"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ]; then echo "already added" >&2; exit 1; fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then echo "installed $3"; exit 0; fi
exit 1
`;

const MARKETPLACE_UNREACHABLE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-claude"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ]; then echo "repository dmemo-ai/claude-dmemo not found" >&2; exit 1; fi
exit 1
`;

const INSTALL_FAILS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-claude"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ]; then echo "added $4"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then echo "no plugin named dmemo in dmemo-plugins" >&2; exit 1; fi
exit 1
`;

test('claude binary missing: non-fatal, reports not attempted', () => {
  const env = { ...process.env, PATH: scratchDir() };
  const result = installClaudeCode(env);
  assert.equal(result.attempted, false);
  assert.equal(result.succeeded, false);
  assert.match(result.manualInstructions, /claude plugin install dmemo@dmemo-plugins/);
});

test('fresh install: marketplace added and plugin installed', () => {
  const result = installClaudeCode(fakeClaudeBin(BOTH_OK));
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, true);
  assert.equal(result.alreadyPresent, false, 'nothing was pre-existing on a fresh machine');
  assert.equal(result.error, undefined);
});

test('re-run: marketplace and plugin are both already there — success, not a failed step', () => {
  const result = installClaudeCode(fakeClaudeBin(BOTH_ALREADY_THERE));
  assert.equal(result.succeeded, true, 'a second `dmemo setup` must not report claude-code as failed');
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.error, undefined);
});

test('re-run: marketplace already added, plugin installed for the first time', () => {
  const result = installClaudeCode(fakeClaudeBin(MARKETPLACE_ALREADY_INSTALL_FRESH));
  assert.equal(result.succeeded, true);
  assert.equal(result.alreadyPresent, true);
});

test('a marketplace that cannot be reached fails loudly and never reaches install', () => {
  const result = installClaudeCode(fakeClaudeBin(MARKETPLACE_UNREACHABLE));
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? '', /Command failed/);
});

test('a real install failure is never mistaken for "already installed"', () => {
  const result = installClaudeCode(fakeClaudeBin(INSTALL_FAILS));
  assert.equal(result.succeeded, false, 'a genuine failure must not be swallowed by the re-run path');
  assert.ok(result.error, 'the reason has to survive to the caller');
});
