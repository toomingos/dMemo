import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeDmemoConfig,
  readDmemoConfig,
  dmemoConfigPath,
  inspectExistingKey,
  addressForKey,
  ExistingKeyError,
} from './dmemoConfig.js';

function scratchEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-config-test-'));
  return { DMEMO_HOME: path.join(dir, '.dmemo') };
}

// Two throwaway, structurally-valid secp256k1 keys. Test fixtures only —
// never funded, never used against a real network.
const KEY_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const KEY_B = '0x2222222222222222222222222222222222222222222222222222222222222222';

function backupsIn(env: NodeJS.ProcessEnv): string[] {
  const dir = path.dirname(dmemoConfigPath(env));
  return fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));
}

test('writeDmemoConfig creates the file with mode 0600', () => {
  const env = scratchEnv();
  const result = writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' }, env);
  assert.equal(result.created, true);
  assert.equal(result.backupPath, null);
  assert.equal(result.keyReplaced, false);
  const stat = fs.statSync(result.path);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(readDmemoConfig(env)?.DMEMO_PRIVATE_KEY, KEY_A);
});

test('writeDmemoConfig merges into an existing file without dropping other keys', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet', DMEMO_EMBEDDER_PROVIDER: 'custom' }, env);
  const second = writeDmemoConfig({ DMEMO_NETWORK: 'mainnet' }, env);
  assert.equal(second.created, false);
  const contents = readDmemoConfig(env);
  assert.equal(contents?.DMEMO_NETWORK, 'mainnet');
  assert.equal(contents?.DMEMO_PRIVATE_KEY, KEY_A, 'a write that omits the key must never disturb it');
  assert.equal(contents?.DMEMO_EMBEDDER_PROVIDER, 'custom', 'unrelated keys must survive a merge');
});

test('dmemoConfigPath respects DMEMO_HOME override', () => {
  const env = scratchEnv();
  assert.equal(dmemoConfigPath(env), path.join(env.DMEMO_HOME as string, 'config.json'));
});

// --- F3: the wallet-overwrite guard ---------------------------------------

test('refuses to replace an existing key, and writes nothing when it refuses', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' }, env);

  assert.throws(
    () => writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_B }, env),
    (err: unknown) => {
      assert.ok(err instanceof ExistingKeyError);
      assert.equal(err.existing.address, addressForKey(KEY_A));
      assert.equal(err.incomingAddress, addressForKey(KEY_B));
      assert.ok(!err.message.includes(KEY_A.slice(2)), 'the error must not leak key material');
      assert.ok(!err.message.includes(KEY_B.slice(2)), 'the error must not leak key material');
      return true;
    }
  );

  assert.equal(readDmemoConfig(env)?.DMEMO_PRIVATE_KEY, KEY_A, 'a refused write must be a no-op');
  assert.equal(backupsIn(env).length, 0, 'a refused write must not leave a backup behind');
});

test('writing the SAME key back is not a replacement and needs no opt-in', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' }, env);
  // Different spelling of the identical key: unprefixed and upper-cased.
  const again = writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A.slice(2).toUpperCase() }, env);
  assert.equal(again.keyReplaced, false);
  assert.equal(again.backupPath, null);
  assert.equal(backupsIn(env).length, 0);
});

test('allowKeyReplacement replaces the key and backs the old config up at 0600', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' }, env);
  const result = writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_B }, env, { allowKeyReplacement: true });

  assert.equal(result.keyReplaced, true);
  assert.ok(result.backupPath, 'a replacement must leave a backup');
  assert.equal(readDmemoConfig(env)?.DMEMO_PRIVATE_KEY, KEY_B);

  const backup = JSON.parse(fs.readFileSync(result.backupPath as string, 'utf8'));
  assert.equal(backup.DMEMO_PRIVATE_KEY, KEY_A, 'the backup must hold the key that was displaced');
  assert.equal(fs.statSync(result.backupPath as string).mode & 0o777, 0o600);
});

test('successive replacements never overwrite an earlier backup', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' }, env);
  const first = writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_B }, env, { allowKeyReplacement: true });
  const second = writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A }, env, { allowKeyReplacement: true });

  assert.notEqual(first.backupPath, second.backupPath);
  assert.equal(backupsIn(env).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(first.backupPath as string, 'utf8')).DMEMO_PRIVATE_KEY, KEY_A);
  assert.equal(JSON.parse(fs.readFileSync(second.backupPath as string, 'utf8')).DMEMO_PRIVATE_KEY, KEY_B);
});

test('an unparseable config is backed up rather than silently discarded', () => {
  const env = scratchEnv();
  const configPath = dmemoConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // A config with a hand-edited trailing comma still contains the only copy
  // of a key — losing it must not be the price of a malformed edit.
  fs.writeFileSync(configPath, `{ "DMEMO_PRIVATE_KEY": "${KEY_A}", }\n`, { mode: 0o600 });

  const result = writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_B, DMEMO_NETWORK: 'testnet' }, env);
  assert.ok(result.backupPath, 'the unreadable original must be preserved');
  assert.ok(fs.readFileSync(result.backupPath as string, 'utf8').includes(KEY_A));
  assert.equal(readDmemoConfig(env)?.DMEMO_PRIVATE_KEY, KEY_B);
});

test('the config write is atomic — no temp files survive a successful write', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' }, env);
  const leftovers = fs
    .readdirSync(path.dirname(dmemoConfigPath(env)))
    .filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

// --- inspectExistingKey ----------------------------------------------------

test('inspectExistingKey returns null when there is no config or no key', () => {
  const env = scratchEnv();
  assert.equal(inspectExistingKey(env), null);
  writeDmemoConfig({ DMEMO_NETWORK: 'testnet' }, env);
  assert.equal(inspectExistingKey(env), null);
});

test('inspectExistingKey reports the address and provenance, never the key', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_NETWORK: 'testnet' }, env);
  const generated = inspectExistingKey(env);
  assert.equal(generated?.source, 'generated');
  assert.equal(generated?.address, addressForKey(KEY_A));
  assert.ok(!JSON.stringify(generated).includes(KEY_A.slice(2)));

  writeDmemoConfig(
    { DMEMO_PRIVATE_KEY: KEY_B, DMEMO_KEY_SOURCE: 'connect', DMEMO_SCOPE: 'work', DMEMO_CONNECTED_WALLET: '0xdead' },
    env,
    { allowKeyReplacement: true }
  );
  const connected = inspectExistingKey(env);
  assert.equal(connected?.source, 'connect');
  assert.equal(connected?.scope, 'work');
  assert.equal(connected?.connectedWallet, '0xdead');
});

test('inspectExistingKey trusts the key over a stale recorded address', () => {
  const env = scratchEnv();
  writeDmemoConfig({ DMEMO_PRIVATE_KEY: KEY_A, DMEMO_ADDRESS: '0x00000000000000000000000000000000deadbeef' }, env);
  assert.equal(inspectExistingKey(env)?.address, addressForKey(KEY_A));
});
