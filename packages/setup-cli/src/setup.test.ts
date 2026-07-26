// F3 regression suite: `dmemo setup` must never cost a user their wallet.
//
// Every case runs against a throwaway DMEMO_HOME with `skipHosts` on and
// funding skipped, so nothing here touches a real dotfile or the network.
// `skipFunding` matters: without it the funding step reads the account
// balance over RPC, which would make this suite hit the public 0G endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { runSetup, type SetupOptions, type SetupResult } from './setup.js';
import { readDmemoConfig, dmemoConfigPath, addressForKey } from './dmemoConfig.js';
import { derivationMessage } from './connect/derive.js';

const KEY_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const KEY_B = '0x2222222222222222222222222222222222222222222222222222222222222222';

/** Stands in for the user's browser wallet. */
const SIGNER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

/** Unroutable on purpose: the connect path reads a balance, and this suite
 * must never reach the public 0G RPC. Refused instantly, and the read is
 * non-fatal by design, so the flow carries on unfunded. */
const DEAD_RPC = 'http://127.0.0.1:1/never-called';

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
    args: {
      env,
      yes: true,
      skipHosts: true,
      skipFunding: true,
      checkBalanceOnce: false,
      log: (l: string) => lines.push(l),
      ...extra,
    },
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

// --- step 1 via a connected wallet ---------------------------------------
//
// The whole point of this path is that the user never types a private key, so
// these drive the real loopback server the way a browser would: sign the
// message the CLI hands back, twice, and post the signatures.

interface ConnectRun {
  result: Promise<SetupResult>;
  lines: string[];
}

/** Starts a connect-mode setup and drives its loopback page to completion. */
function driveConnect(env: NodeJS.ProcessEnv, extra: SetupOptions = {}): ConnectRun {
  const lines: string[] = [];
  const scope = extra.scope ?? 'default';
  let driven = false;

  const result = runSetup({
    env,
    yes: true,
    skipHosts: true,
    skipFunding: true,
    walletMode: 'connect',
    noOpen: true,
    rpcUrl: DEAD_RPC,
    // Short on purpose: if the drive below ever fails, the flow dies here
    // rather than sitting on the default ten-minute wait.
    timeoutMs: 15_000,
    log(line: string) {
      lines.push(line);
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})/.exec(line);
      if (!match || driven) return;
      driven = true;
      // Swallowed deliberately: a failure here surfaces as the connect step
      // timing out, which is a far clearer failure than an unhandled
      // rejection tearing down an unrelated test.
      void completeFlow(`http://127.0.0.1:${match[1]!}`, match[2]!, scope).catch(() => {});
    },
    ...extra,
  });

  return { result, lines };
}

/** What the browser page does, minus the browser: fetch the message, sign it
 * twice, hand both back, then decline the in-page funding offer. */
async function completeFlow(origin: string, token: string, scope: string): Promise<void> {
  const post = (p: string, body: unknown) =>
    fetch(`${origin}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dmemo-token': token },
      body: JSON.stringify(body),
    });

  const begin = await post('/api/begin', { address: SIGNER.address });
  const { message } = (await begin.json()) as { message: string };
  if (message !== derivationMessage(SIGNER.address, scope)) {
    throw new Error('the CLI did not ask for the message it builds');
  }

  // ethers signs deterministically (RFC 6979), which is exactly the property
  // the two-signature gate in derive.ts checks for.
  const signature = await SIGNER.signMessage(message);
  await post('/api/signature', {
    address: SIGNER.address,
    signature,
    signatureRepeat: signature,
  });
  await post('/api/complete', { txHash: null, skipped: true });
}

test('connecting a wallet derives an account without ever handling the wallet key', async () => {
  const env = scratchEnv();
  const { result, lines } = driveConnect(env);
  const setup = await result;

  assert.equal(setup.keySource, 'connect');
  assert.equal(setup.walletAddress, SIGNER.address);
  assert.equal(setup.scope, 'default');
  assert.notEqual(
    setup.address.toLowerCase(),
    SIGNER.address.toLowerCase(),
    'the dMemo account must be derived, never the connected wallet itself'
  );

  const config = readDmemoConfig(env);
  assert.equal(config?.DMEMO_KEY_SOURCE, 'connect');
  assert.equal(config?.DMEMO_CONNECTED_WALLET, SIGNER.address);
  assert.equal(config?.DMEMO_SCOPE, 'default');
  assert.equal(config?.DMEMO_ADDRESS, setup.address);

  // The connected wallet's key is the one thing that must never appear —
  // not in the transcript, and above all not in the config we just wrote.
  const written = fs.readFileSync(dmemoConfigPath(env), 'utf8');
  assert.ok(!written.includes(SIGNER.privateKey.slice(2)), 'wallet key leaked into the config');

  const derivedKey = config?.DMEMO_PRIVATE_KEY as string | undefined;
  assert.ok(derivedKey, 'the derived key must have been persisted');
  for (const line of lines) {
    assert.ok(!line.includes(SIGNER.privateKey.slice(2)), `wallet key leaked: ${line}`);
    assert.ok(!line.includes(derivedKey.slice(2)), `derived key leaked: ${line}`);
  }
});

test('the same wallet and scope reproduce the same account on a fresh machine', async () => {
  const first = await driveConnect(scratchEnv()).result;
  const second = await driveConnect(scratchEnv()).result;
  assert.equal(second.address, first.address, 'memories must follow the wallet');
});

test('a different scope on the same wallet is a different, isolated account', async () => {
  const base = await driveConnect(scratchEnv()).result;
  const work = await driveConnect(scratchEnv(), { scope: 'work' }).result;
  assert.notEqual(work.address, base.address);
  assert.equal(work.scope, 'work');
});

test('connect refuses to replace a generated wallet unattended, without opening a browser', async () => {
  const env = scratchEnv();
  const first = await runSetup(opts(env).args);

  const lines: string[] = [];
  await assert.rejects(
    () =>
      runSetup({
        env,
        yes: true,
        skipHosts: true,
        skipFunding: true,
        walletMode: 'connect',
        noOpen: true,
        rpcUrl: DEAD_RPC,
        log: (l: string) => lines.push(l),
      }),
    /--force/
  );

  // The gate must fire BEFORE the loopback server starts: a user who is about
  // to be refused should never have been asked to pick a wallet and sign.
  assert.ok(
    !lines.some((l) => l.includes('http://127.0.0.1:')),
    'a browser flow was started for a run that was always going to be refused'
  );
  assert.equal(readDmemoConfig(env)?.DMEMO_ADDRESS, first.address, 'the refusal must be a no-op');
  assert.equal(backupsIn(env).length, 0);
});

test('--yes never selects the browser flow on its own', async () => {
  const env = scratchEnv();
  const { args, lines } = opts(env);
  const result = await runSetup(args);

  assert.equal(result.keySource, 'generated');
  assert.equal(result.walletAddress, null);
  assert.ok(
    !lines.some((l) => l.includes('http://127.0.0.1:')),
    'an unattended run must never spawn a wallet page'
  );
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
