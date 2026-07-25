import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDmemoConfig, readDmemoConfig, dmemoConfigPath } from './dmemoConfig.js';

function scratchEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-config-test-'));
  return { DMEMO_HOME: path.join(dir, '.dmemo') };
}

test('writeDmemoConfig creates the file with mode 0600', () => {
  const env = scratchEnv();
  const result = writeDmemoConfig({ DMEMO_PRIVATE_KEY: '0xabc', DMEMO_NETWORK: 'testnet' }, env);
  assert.equal(result.created, true);
  const stat = fs.statSync(result.path);
  assert.equal(stat.mode & 0o777, 0o600);
  const contents = readDmemoConfig(env);
  assert.equal(contents?.DMEMO_PRIVATE_KEY, '0xabc');
});

test('writeDmemoConfig merges into an existing file without dropping other keys', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: '0xabc', DMEMO_NETWORK: 'testnet', DMEMO_EMBEDDER_PROVIDER: 'custom' }, env);
  const second = writeDmemoConfig({ DMEMO_PRIVATE_KEY: '0xdef' }, env);
  assert.equal(second.created, false);
  const contents = readDmemoConfig(env);
  assert.equal(contents?.DMEMO_PRIVATE_KEY, '0xdef');
  assert.equal(contents?.DMEMO_EMBEDDER_PROVIDER, 'custom', 'unrelated keys must survive a merge');
});

test('dmemoConfigPath respects DMEMO_HOME override', () => {
  const env = scratchEnv();
  assert.equal(dmemoConfigPath(env), path.join(env.DMEMO_HOME as string, 'config.json'));
});
