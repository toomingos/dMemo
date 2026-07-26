import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfigFromEnv,
  loadDmemoConfig,
  MissingConfigError,
  ConfigNotFoundError,
  dmemoHome,
  dmemoConfigPath,
  readDmemoConfigFile,
} from './config.js';

// Two throwaway, structurally-valid hex strings. Test fixtures only — never
// funded, never used against a real network. (Not real secp256k1 keys —
// `loadConfigFromEnv` doesn't validate key shape, only presence.)
const KEY_A = '0xaaaa1111111111111111111111111111111111111111111111111111111111';
const KEY_B = '0xbbbb2222222222222222222222222222222222222222222222222222222222';

function scratchEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-core-config-test-'));
  return { DMEMO_HOME: path.join(dir, '.dmemo'), ...extra };
}

function writeConfigFile(env: NodeJS.ProcessEnv, contents: Record<string, unknown> | string): void {
  const configPath = dmemoConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const raw = typeof contents === 'string' ? contents : JSON.stringify(contents);
  fs.writeFileSync(configPath, raw, { mode: 0o600 });
}

// --- loadConfigFromEnv (existing, unchanged behavior) -----------------------

test('loadConfigFromEnv: throws MissingConfigError when DMEMO_PRIVATE_KEY is absent', () => {
  assert.throws(() => loadConfigFromEnv({}), MissingConfigError);
});

test('loadConfigFromEnv: is unaffected by a config file on disk (env-only, by design)', () => {
  const env = scratchEnv();
  writeConfigFile(env, { DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' });
  // loadConfigFromEnv never looks at the filesystem — this is the primitive
  // loadDmemoConfig wraps, not a duplicate of it.
  assert.throws(() => loadConfigFromEnv(env), MissingConfigError);
});

// --- dmemoHome / dmemoConfigPath --------------------------------------------

test('dmemoConfigPath respects a DMEMO_HOME override', () => {
  const env = scratchEnv();
  assert.equal(dmemoConfigPath(env), path.join(env.DMEMO_HOME as string, 'config.json'));
});

test('dmemoHome falls back to ~/.dmemo when DMEMO_HOME is unset', () => {
  assert.equal(dmemoHome({}), path.join(os.homedir(), '.dmemo'));
});

// --- readDmemoConfigFile -----------------------------------------------------

test('readDmemoConfigFile: returns null when the file does not exist (never throws)', () => {
  const env = scratchEnv();
  assert.equal(readDmemoConfigFile(env), null);
});

test('readDmemoConfigFile: returns null for a malformed (unparseable) file, does not crash', () => {
  const env = scratchEnv();
  writeConfigFile(env, '{ "DMEMO_PRIVATE_KEY": "0xaaaa", '); // truncated JSON
  assert.equal(readDmemoConfigFile(env), null);
});

test('readDmemoConfigFile: returns null for valid JSON that is not an object (e.g. an array)', () => {
  const env = scratchEnv();
  writeConfigFile(env, '[1, 2, 3]');
  assert.equal(readDmemoConfigFile(env), null);
});

test('readDmemoConfigFile: parses a well-formed config file', () => {
  const env = scratchEnv();
  writeConfigFile(env, { DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'mainnet' });
  const parsed = readDmemoConfigFile(env);
  assert.equal(parsed?.DMEMO_PRIVATE_KEY, KEY_A);
  assert.equal(parsed?.DMEMO_NETWORK, 'mainnet');
});

// --- loadDmemoConfig: the F1 fix --------------------------------------------

test('loadDmemoConfig: config file present, env empty -> the file is used', () => {
  const env = scratchEnv();
  writeConfigFile(env, { DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'mainnet' });
  const config = loadDmemoConfig(env);
  assert.equal(config.privateKey, KEY_A);
  assert.equal(config.network, 'mainnet');
});

test('loadDmemoConfig: env set and file present -> a real env var wins', () => {
  const env = scratchEnv({ DMEMO_PRIVATE_KEY: KEY_B, DMEMO_NETWORK: 'testnet' });
  writeConfigFile(env, { DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'mainnet' });
  const config = loadDmemoConfig(env);
  assert.equal(config.privateKey, KEY_B, 'env DMEMO_PRIVATE_KEY must win over the file');
  assert.equal(config.network, 'testnet', 'env DMEMO_NETWORK must win over the file');
});

test('loadDmemoConfig: file fills in fields env does not set, alongside an env-set private key', () => {
  const env = scratchEnv({ DMEMO_PRIVATE_KEY: KEY_B });
  writeConfigFile(env, { DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'mainnet', DMEMO_SCOPE: 'work' });
  const config = loadDmemoConfig(env);
  assert.equal(config.privateKey, KEY_B, 'env private key still wins');
  assert.equal(config.network, 'mainnet', 'network not set in env falls back to the file');
});

test('loadDmemoConfig: neither env nor file configured -> ConfigNotFoundError names the path and points at the setup command', () => {
  const env = scratchEnv();
  assert.throws(
    () => loadDmemoConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof ConfigNotFoundError);
      assert.ok(err instanceof MissingConfigError, 'must still satisfy existing instanceof MissingConfigError checks');
      assert.equal(err.configPath, dmemoConfigPath(env));
      assert.ok(err.message.includes(dmemoConfigPath(env)), 'error must name the file it looked for');
      // The published CLI is `@dmemo/cli`, not bare `dmemo` — that name was
      // unpublished on npm in 2018 and is permanently reserved. Assert the
      // real invocation, so this test fails if the message drifts back to a
      // command a user cannot actually run.
      assert.ok(err.message.includes('npx @dmemo/cli setup'), 'error must tell the user how to fix it');
      return true;
    }
  );
});

test('loadDmemoConfig: a malformed config file does not crash opaquely — still a clear ConfigNotFoundError', () => {
  const env = scratchEnv();
  writeConfigFile(env, '{ this is not valid json');
  assert.throws(() => loadDmemoConfig(env), ConfigNotFoundError);
});

test('loadDmemoConfig: DMEMO_HOME override is honoured for the file fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-core-config-test-'));
  const customHome = path.join(dir, 'custom-home');
  const env: NodeJS.ProcessEnv = { DMEMO_HOME: customHome };
  writeConfigFile(env, { DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' });

  const config = loadDmemoConfig(env);
  assert.equal(config.privateKey, KEY_A);
  assert.equal(dmemoConfigPath(env), path.join(customHome, 'config.json'));
});

test('loadDmemoConfig: never includes key material in a not-found error message', () => {
  const env = scratchEnv({ DMEMO_PRIVATE_KEY: '' });
  assert.throws(() => loadDmemoConfig(env), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes('0x'), 'no key material should appear when nothing was found');
    return true;
  });
});
