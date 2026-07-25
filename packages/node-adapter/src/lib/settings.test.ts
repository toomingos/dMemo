import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `settings.ts` computes `DMEMO_HOME`/`DMEMO_CONFIG_PATH` once, at module
// load time, from `process.env.DMEMO_HOME` (it's the Claude Code/Codex hook
// entry point — every hook invocation is a fresh subprocess, gotcha 10, so
// module-load-time is early enough there). To point it at a scratch
// directory for this test file we must set `DMEMO_HOME` BEFORE the module
// is first imported, which means a dynamic `import()` after the env var is
// set rather than a static import (hoisted before any code runs). This test
// file gets its own process under `node --test` (one child process per
// file), so this doesn't leak into other test files.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-node-adapter-settings-test-'));
process.env.DMEMO_HOME = path.join(scratchDir, '.dmemo');

const { loadDmemoEnv, isConfigured, DMEMO_CONFIG_PATH, resolveScope } = await import('./settings.js');

function writeConfigFile(contents: Record<string, unknown> | string): void {
  fs.mkdirSync(path.dirname(DMEMO_CONFIG_PATH), { recursive: true });
  const raw = typeof contents === 'string' ? contents : JSON.stringify(contents);
  fs.writeFileSync(DMEMO_CONFIG_PATH, raw, { mode: 0o600 });
}

// `loadDmemoEnv` merges into the real `process.env` (that's the point — it's
// what every hook script reads afterward). Reset the keys it touches before
// each test so one test's fill can't leak into the next.
beforeEach(() => {
  delete process.env.DMEMO_PRIVATE_KEY;
  delete process.env.DMEMO_NETWORK;
  delete process.env.DMEMO_SCOPE;
  delete process.env.CLAUDE_PLUGIN_OPTION_PRIVATE_KEY;
  fs.rmSync(DMEMO_CONFIG_PATH, { force: true });
});

const KEY_A = '0xaaaa1111111111111111111111111111111111111111111111111111111111';
const KEY_B = '0xbbbb2222222222222222222222222222222222222222222222222222222222';

test('DMEMO_HOME override is honoured (scratch dir, never the real ~/.dmemo)', () => {
  assert.equal(DMEMO_CONFIG_PATH, path.join(process.env.DMEMO_HOME as string, 'config.json'));
  assert.ok(!DMEMO_CONFIG_PATH.startsWith(os.homedir()) || process.env.DMEMO_HOME!.startsWith(os.homedir()));
});

test('config file present, env empty -> loadDmemoEnv fills process.env from the file', () => {
  writeConfigFile({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'mainnet' });
  const env = loadDmemoEnv();
  assert.equal(env.DMEMO_PRIVATE_KEY, KEY_A);
  assert.equal(env.DMEMO_NETWORK, 'mainnet');
  assert.equal(isConfigured(env), true);
});

test('env set and file present -> a real env var wins', () => {
  writeConfigFile({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'mainnet' });
  process.env.DMEMO_PRIVATE_KEY = KEY_B;
  process.env.DMEMO_NETWORK = 'testnet';
  const env = loadDmemoEnv();
  assert.equal(env.DMEMO_PRIVATE_KEY, KEY_B, 'env DMEMO_PRIVATE_KEY must win over the file');
  assert.equal(env.DMEMO_NETWORK, 'testnet', 'env DMEMO_NETWORK must win over the file');
});

test('neither env nor file configured -> isConfigured is false (fail-open, not a throw)', () => {
  const env = loadDmemoEnv();
  assert.equal(isConfigured(env), false);
});

test('a malformed config file does not crash loadDmemoEnv — falls back to env-only', () => {
  writeConfigFile('{ this is not valid json');
  assert.doesNotThrow(() => loadDmemoEnv());
  const env = loadDmemoEnv();
  assert.equal(isConfigured(env), false);
});

test('Claude Code plugin userConfig (CLAUDE_PLUGIN_OPTION_PRIVATE_KEY) maps onto DMEMO_PRIVATE_KEY when nothing else set it', () => {
  process.env.CLAUDE_PLUGIN_OPTION_PRIVATE_KEY = KEY_A;
  const env = loadDmemoEnv();
  assert.equal(env.DMEMO_PRIVATE_KEY, KEY_A);
  assert.equal(isConfigured(env), true);
});

test('resolveScope defaults to "default" and honours DMEMO_SCOPE', () => {
  assert.equal(resolveScope({}), 'default');
  assert.equal(resolveScope({ DMEMO_SCOPE: 'work' }), 'work');
});
