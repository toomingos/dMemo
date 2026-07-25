// `dmemo connect` — wallet-based onboarding.
//
// The contract with the user: they never see, type, paste, or store a private
// key, and their own funded wallet never holds memory data. What actually
// happens is:
//
//   browser                              node (this file)
//   -------                              ----------------
//   pick wallet (EIP-6963)
//   switch to 0G chain
//   POST /api/begin {address}      ->    derivationMessage(address, scope)
//   personal_sign  x2              ->
//   POST /api/signature {sig,sig2} ->    verifyAndDerive: recover both, prove
//                                        they match each other and the claimed
//                                        address, HKDF -> the dMemo account key
//                                  <-    { derivedAddress, needsFunding }
//   eth_sendTransaction (dust)     ->
//   POST /api/complete {txHash}    ->    await receipt, write config, wire hosts
//
// Note which direction the secret does NOT travel: the browser sends a
// signature, never a key, and gets back an address, never a key.
//
// Re-running this on another machine with the same wallet + scope reproduces
// the identical account (that is what the two-signature determinism gate in
// derive.ts exists to guarantee), so memories follow the wallet.

import { JsonRpcProvider, parseEther } from 'ethers';
import {
  rpcUrlFor,
  chainIdFor,
  chainIdHexFor,
  chainNameFor,
  checkBalance,
  faucetInstructions,
  CURRENCY_SYMBOL,
  FAUCET_URL,
} from './network.js';
import { writeDmemoConfig, inspectExistingKey, recoveryHint, type NetworkName } from './dmemoConfig.js';
import { installDetectedHosts, type InstalledHosts } from './installHosts.js';
import { derivationMessage, verifyAndDerive, DERIVATION_VERSION, type DerivedAccount } from './connect/derive.js';
import { runConnectServer } from './connect/server.js';
import { promptYesNo } from './prompt.js';

export interface ConnectOptions {
  env?: NodeJS.ProcessEnv;
  network?: NetworkName;
  /** Memory namespace. Part of the signed message, so a different scope on
   * the same wallet yields a different, fully isolated dMemo account. */
  scope?: string;
  /** Amount the page offers to send to the derived account, in ether units. */
  fundAmount?: string;
  skipHosts?: boolean;
  /** Print the URL but don't spawn a browser (headless/CI/remote shells). */
  noOpen?: boolean;
  port?: number;
  timeoutMs?: number;
  /** Skip the confirmation asked before replacing a locally-generated
   * (irreproducible) key. The old config is backed up regardless. */
  force?: boolean;
  log?: (line: string) => void;
}

export interface ConnectResult {
  /** The wallet the user connected — funds and proves identity, holds no memory. */
  walletAddress: string;
  /** The derived dMemo account — signs storage txs, is the stream identity, decrypts. */
  address: string;
  network: NetworkName;
  scope: string;
  configPath: string;
  fundingTxHash: string | null;
  hosts: InstalledHosts;
}

/** Below this, a fresh account cannot pay for even a few writes, so the page
 * offers to fund. Above it we assume the user knows what they're doing (this
 * is the second-machine path, where funding already happened elsewhere). */
const FUNDED_THRESHOLD_ETHER = '0.005';
const DEFAULT_FUND_AMOUNT_ETHER = '0.05';

export async function runConnect(opts: ConnectOptions = {}): Promise<ConnectResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  // Mainnet by default — see the note in setup.ts. An existing config's
  // network is NOT consulted here on purpose: connect derives a fresh
  // account, so there is no prior install to avoid demoting.
  const network: NetworkName = opts.network ?? (env.DMEMO_NETWORK as NetworkName) ?? 'mainnet';
  const scope = opts.scope ?? env.DMEMO_SCOPE ?? 'default';
  const fundAmount = opts.fundAmount ?? DEFAULT_FUND_AMOUNT_ETHER;
  const rpcUrl = rpcUrlFor(network);

  log('dMemo connect — derive your memory key from a wallet signature\n');
  log(`Network: ${chainNameFor(network)} (chain ${chainIdFor(network)})`);
  log(`Scope:   ${scope}\n`);

  // Consent gate, asked BEFORE a browser is spawned or anything is signed.
  //
  // Only a locally-generated key earns a prompt. The asymmetry is the whole
  // point: a connect-derived account is reproducible forever from the same
  // wallet + scope, so replacing one is undoable; a `dmemo setup` key is
  // random and exists nowhere but this file, so replacing one is not.
  const existing = inspectExistingKey(env);
  if (existing && existing.source !== 'connect') {
    log('!! A locally-generated wallet is already configured.');
    log(`   on record: ${existing.address ?? '<unreadable key>'}`);
    log('   Connecting derives a different account; memories encrypted to the');
    log('   key on record are not readable by it — ever.');
    log('   The old config will be backed up, and that backup is the only copy.');
    log('');
    if (!opts.force) {
      if (!process.stdin.isTTY) {
        throw new Error(
          `Refusing to replace the configured wallet ${existing.address ?? ''} without confirmation.\n` +
            'Re-run on a terminal, or pass --force (the old config is backed up either way).'
        );
      }
      const ok = await promptYesNo('Continue and replace it?', false);
      if (!ok) throw new Error('Aborted — the configured wallet is untouched.');
      log('');
    }
  }

  let walletAddress = '';
  let derived: DerivedAccount | null = null;
  let configPath = '';
  let hosts: InstalledHosts = {};

  const result = await runConnectServer({
    scope,
    network,
    chainIdHex: chainIdHexFor(network),
    chainName: chainNameFor(network),
    rpcUrl,
    currencySymbol: CURRENCY_SYMBOL,
    fundAmountLabel: fundAmount,
    fundAmountWeiHex: '0x' + parseEther(fundAmount).toString(16),
    faucetUrl: network === 'testnet' ? FAUCET_URL : undefined,
    port: opts.port,
    timeoutMs: opts.timeoutMs,
    openBrowser: !opts.noOpen,
    log,
    buildMessage: (address) => derivationMessage(address, scope),

    async onSignature({ address, signature, signatureRepeat }) {
      // Throws on a non-deterministic wallet or a signature that doesn't
      // recover to `address`; the server turns that into a 400 the page
      // renders verbatim, which is exactly the message the user needs.
      const { account } = verifyAndDerive(address, scope, signature, signatureRepeat);
      walletAddress = address;
      derived = account;
      log(`  wallet connected: ${address}`);
      log(`  signature is deterministic ✓`);
      log(`  derived dMemo account: ${account.address}`);

      let balanceWei = 0n;
      let balanceLabel = '0.0';
      try {
        const balance = await checkBalance(account.address, network);
        balanceWei = balance.balanceWei;
        balanceLabel = balance.balanceFormatted;
      } catch (err) {
        // A flaky public RPC must not strand the flow — offering to fund an
        // already-funded account is harmless, the reverse is not.
        log(`  balance check failed (assuming unfunded): ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        derivedAddress: account.address,
        needsFunding: balanceWei < parseEther(FUNDED_THRESHOLD_ETHER),
        balanceLabel,
      };
    },

    async onComplete({ txHash, skipped }) {
      if (!derived) throw new Error('internal: completion before key derivation');
      const account: DerivedAccount = derived;

      if (txHash) {
        log(`  funding tx ${txHash} — waiting for confirmation…`);
        const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
        try {
          const receipt = await provider.waitForTransaction(txHash, 1, 120_000);
          if (!receipt) log('  funding tx not confirmed within 120s — it may still land.');
          else if (receipt.status === 0) log('  funding tx reverted — fund the account manually (see below).');
          else log('  funding confirmed ✓');
        } catch (err) {
          log(`  could not confirm funding tx (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          provider.destroy();
        }
      } else if (skipped) {
        log('  funding skipped.');
      }

      const written = writeDmemoConfig(
        {
          DMEMO_PRIVATE_KEY: account.privateKey,
          DMEMO_NETWORK: network,
          DMEMO_SCOPE: scope,
          DMEMO_ADDRESS: account.address,
          // Provenance, so `dmemo connect` can tell a derived account from a
          // `dmemo setup` generated one, and so the user can see which wallet
          // to reconnect on another machine. Neither is read by core.
          DMEMO_KEY_SOURCE: 'connect',
          DMEMO_KEY_VERSION: String(DERIVATION_VERSION),
          DMEMO_CONNECTED_WALLET: walletAddress,
        },
        env,
        // Consent for the irreproducible case was taken above, before the
        // browser opened; a connect-derived key being replaced by another
        // connect-derived key is recoverable by reconnecting the old wallet.
        { allowKeyReplacement: true }
      );
      configPath = written.path;
      log(`  wrote ${configPath} (mode 0600)`);
      if (written.backupPath && existing) {
        log(`  replaced the previous account ${existing.address ?? ''}`);
        for (const line of recoveryHint(existing, written.backupPath).split('\n')) log(`  ${line}`);
      }

      if (!opts.skipHosts) hosts = installDetectedHosts(env, (line) => log(`  ${line}`));
    },
  });

  if (!derived) throw new Error('connect finished without deriving an account');
  const account: DerivedAccount = derived;

  log('');
  log('✔ dMemo is connected.');
  log('');
  log(`  Wallet         ${walletAddress}`);
  log(`  dMemo account  ${account.address}`);
  log(`  Network        ${chainNameFor(network)}`);
  log(`  Scope          ${scope}`);
  log(`  Config         ${configPath}`);
  log('');
  log('  Reconnect the same wallet on another machine to get the same account');
  log('  and the same memories. The private key is never displayed or stored');
  log('  anywhere but the config file above.');

  if (!result.txHash && network === 'testnet') {
    log('');
    log(faucetInstructions(account.address));
  }
  log('');
  log('Restart your coding agents to pick up the new config.');

  return {
    walletAddress,
    address: account.address,
    network,
    scope,
    configPath,
    fundingTxHash: result.txHash,
    hosts,
  };
}
