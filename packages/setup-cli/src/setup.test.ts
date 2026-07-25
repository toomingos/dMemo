// F3 regression suite: `dmemo setup` must never cost a user their wallet.
//
// Every case runs against a throwaway DMEMO_HOME with `skipHosts` on and the
// balance check off, so nothing here touches a real dotfile or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetup } from './setup.js';
import { readDmemoConfig, dmemoConfigPath, addressForKey } from './dmemoConfig.js';

const KEY_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const KEY_B = '0x2222222222222222222222222222222222222222222222222222222222222222';

function scratchEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-setup-test-'));
  return { DMEMO_HOME: path.join(dir, '.dmemo') };
}

function backupsIn(env: NodeJS.ProcessEnv): string[] {
  const dir = path.dirname(dmemoConfigPath(env));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bak')) : [];
}

/** Non-interactive, host-free, network-free, silent. */
function opts(env: NodeJS.ProcessEnv, extra: Parameters<typeof runSetup>[0] = {}) {
  const lines: string[] = [];
  return {
    args: { env, yes: true, skipHosts: true, checkBalanceOnce: false, log: (l: string) => lines.push(l), ...extra },
    lines,
  };
}

test('a first run generates a wallet and writes the config', async () => {
  const env = scratchEnv();
  const { args } = opts(env);
  const result = await runSetup(args);

  assert.equal(result.walletReused, false);
  assert.equal(result.backupPath, null);
  assert.ok(result.address.startsWith('0x'));
  assert.equal(readDmemoConfig(env)?.DMEMO_ADDRESS, result.address);
});

test('re-running setup keeps the configured wallet', async () => {
  const env = scratchEnv();
  const first = await runSetup(opts(env).args);
  const { args, lines } = opts(env);
  const second = await runSetup(args);

  assert.equal(second.walletReused, true, 'a plain re-run must not mint a new wallet');
  assert.equal(second.address, first.address);
  assert.equal(second.backupPath, null);
  assert.equal(backupsIn(env).length, 0, 'nothing was displaced, so nothing needed backing up');
  assert.ok(lines.some((l) => l.includes('Keeping it')), 'the user must be told the wallet was kept');
});

test('re-running setup preserves a mainnet config instead of demoting it to testnet', async () => {
  const env = scratchEnv();
  await runSetup(opts(env, { network: 'mainnet' }).args);
  const second = await runSetup(opts(env).args);
  assert.equal(second.network, 'mainnet');
  assert.equal(readDmemoConfig(env)?.DMEMO_NETWORK, 'mainnet');
});

test('--import-key of a DIFFERENT key refuses unattended, and changes nothing', async () => {
  const env = scratchEnv();
  const first = await runSetup(opts(env, { importKey: KEY_A }).args);

  await assert.rejects(
    () => runSetup(opts(env, { importKey: KEY_B }).args),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--force/);
      assert.ok(!err.message.includes(KEY_A.slice(2)) && !err.message.includes(KEY_B.slice(2)));
      return true;
    }
  );

  assert.equal(readDmemoConfig(env)?.DMEMO_PRIVATE_KEY, KEY_A, 'the refusal must be a no-op');
  assert.equal(readDmemoConfig(env)?.DMEMO_ADDRESS, first.address);
  assert.equal(backupsIn(env).length, 0);
});

test('--new-wallet refuses unattended without --force', async () => {
  const env = scratchEnv();
  const first = await runSetup(opts(env).args);
  await assert.rejects(() => runSetup(opts(env, { newWallet: true }).args), /--force/);
  assert.equal(readDmemoConfig(env)?.DMEMO_ADDRESS, first.address);
});

test('--force replaces the wallet and leaves a restorable backup', async () => {
  const env = scratchEnv();
  await runSetup(opts(env, { importKey: KEY_A }).args);
  const { args, lines } = opts(env, { importKey: KEY_B, force: true });
  const result = await runSetup(args);

  assert.equal(result.walletReused, false);
  assert.equal(result.address, addressForKey(KEY_B));
  assert.ok(result.backupPath, 'a forced replacement must still back up');
  assert.equal(readDmemoConfig(env)?.DMEMO_PRIVATE_KEY, KEY_B);

  const backup = JSON.parse(fs.readFileSync(result.backupPath as string, 'utf8'));
  assert.equal(backup.DMEMO_PRIVATE_KEY, KEY_A);
  assert.ok(
    lines.some((l) => l.includes('replaces the wallet')),
    'the user must be warned even when they forced it'
  );
  assert.ok(lines.some((l) => l.includes(result.backupPath as string)), 'the backup path must be printed');
});

test('--import-key of the ALREADY configured key is not a replacement', async () => {
  const env = scratchEnv();
  await runSetup(opts(env, { importKey: KEY_A }).args);
  const { args, lines } = opts(env, { importKey: KEY_A });
  const result = await runSetup(args);

  assert.equal(result.backupPath, null);
  assert.equal(backupsIn(env).length, 0);
  assert.ok(lines.some((l) => l.includes('already the configured one')));
});

test('no run of setup ever prints key material', async () => {
  const env = scratchEnv();
  const first = opts(env, { importKey: KEY_A });
  await runSetup(first.args);
  const second = opts(env, { importKey: KEY_B, force: true });
  await runSetup(second.args);

  for (const line of [...first.lines, ...second.lines]) {
    assert.ok(!line.includes(KEY_A.slice(2)), `leaked key material: ${line}`);
    assert.ok(!line.includes(KEY_B.slice(2)), `leaked key material: ${line}`);
  }
});
