// The browser half of "connect a wallet", with nothing else attached.
//
// WHY THIS FILE EXISTS. This logic used to live inside `connect.ts`'s
// `runConnect`, tangled together with the config write and the host install:
// the loopback server's `onComplete` callback wrote `~/.dmemo/config.json` and
// ran the installers *from inside the browser request handler*. That made it
// impossible to reuse from `dmemo setup`, which has to write the config as its
// own numbered step and install hosts as another.
//
// So the split is: this file gets you a wallet and nothing more. It opens the
// browser, verifies the signatures, derives the account, and waits for the
// funding transaction if the user sent one. What to DO with that account —
// persist it, back up what it replaced, wire up hosts — belongs to the caller.
//
// The secret still never crosses the browser boundary in either direction:
// the page sends a signature, Node derives the key from it, and only the
// resulting address is sent back for display and funding.

import { JsonRpcProvider, parseEther } from 'ethers';
import {
  rpcUrlFor,
  chainIdHexFor,
  chainNameFor,
  blockExplorerFor,
  checkBalance,
  CURRENCY_SYMBOL,
  FAUCET_URL,
} from '../network.js';
import type { NetworkName } from '../dmemoConfig.js';
import { derivationMessage, verifyAndDerive, type DerivedAccount } from './derive.js';
import { runConnectServer } from './server.js';
import { dim, status, wrap } from '../theme.js';

/** Below this, a fresh account cannot pay for even a few writes, so the page
 * offers to fund. Above it we assume the user knows what they're doing (this
 * is the second-machine path, where funding already happened elsewhere). */
export const FUNDED_THRESHOLD_ETHER = '0.005';
export const DEFAULT_FUND_AMOUNT_ETHER = '0.05';

export interface AcquireOptions {
  network: NetworkName;
  /** Memory namespace. Part of the signed message, so a different scope on
   * the same wallet yields a different, fully isolated dMemo account. */
  scope: string;
  /** Amount the page offers to send to the derived account, in ether units. */
  fundAmount?: string;
  /** Print the URL but don't spawn a browser (headless/CI/remote shells). */
  noOpen?: boolean;
  port?: number;
  timeoutMs?: number;
  /** Override the chain's default RPC endpoint — for a private/rate-limited
   * node, and for tests that must not reach the public one. */
  rpcUrl?: string;
  log: (line: string) => void;
}

export interface AcquiredWallet {
  /** The wallet the user connected — funds and proves identity, holds no memory. */
  walletAddress: string;
  /** The derived dMemo account — signs storage txs, is the stream identity,
   * decrypts. Its `privateKey` is for the caller to persist and nothing else. */
  account: DerivedAccount;
  /** Set when the user funded from the connected wallet inside the page. */
  fundingTxHash: string | null;
  /** Whether the account held enough to write when the page checked. Only a
   * snapshot — the caller re-reads the balance after any funding tx lands. */
  fundedAtConnect: boolean;
  balanceLabel: string | null;
}

/**
 * Runs the loopback connect flow to completion and returns the derived
 * account. Throws if the browser never finishes (timeout), if the wallet
 * signs non-deterministically, or if a signature doesn't recover to the
 * claimed address.
 */
export async function acquireWalletViaBrowser(opts: AcquireOptions): Promise<AcquiredWallet> {
  const { log, network, scope } = opts;
  const rpcUrl = opts.rpcUrl ?? rpcUrlFor(network);
  const fundAmount = opts.fundAmount ?? DEFAULT_FUND_AMOUNT_ETHER;

  let walletAddress = '';
  let derived: DerivedAccount | null = null;
  let fundedAtConnect = false;
  let balanceLabel: string | null = null;

  const result = await runConnectServer({
    scope,
    network,
    chainIdHex: chainIdHexFor(network),
    chainName: chainNameFor(network),
    rpcUrl,
    blockExplorerUrl: blockExplorerFor(network),
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

      log(status('ok', `connected ${address}`));
      log(status('ok', 'signature is deterministic', '— this wallet reproduces the same account anywhere'));

      let balanceWei = 0n;
      try {
        const balance = await checkBalance(account.address, network, { rpcUrl });
        balanceWei = balance.balanceWei;
        balanceLabel = balance.balanceFormatted;
      } catch (err) {
        // A flaky public RPC must not strand the flow — offering to fund an
        // already-funded account is harmless, the reverse is not.
        log(
          status(
            'skip',
            'balance check failed',
            `(assuming unfunded) ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }

      fundedAtConnect = balanceWei >= parseEther(FUNDED_THRESHOLD_ETHER);
      return {
        derivedAddress: account.address,
        needsFunding: !fundedAtConnect,
        balanceLabel: balanceLabel ?? '0.0',
      };
    },

    // Everything the old `onComplete` did beyond this — writing the config,
    // backing up what it replaced, installing hosts — is the caller's job now.
    // All that is left is waiting for the money to actually land, because the
    // page cannot do that itself.
    async onComplete({ txHash, skipped }) {
      if (!derived) throw new Error('internal: completion before key derivation');
      if (txHash) await waitForFunding(txHash, rpcUrl, log);
      else if (skipped) log(status('skip', 'funding skipped in the browser'));
    },
  });

  if (!derived) throw new Error('connect finished without deriving an account');

  return {
    walletAddress,
    account: derived,
    fundingTxHash: result.txHash,
    fundedAtConnect,
    balanceLabel,
  };
}

/** Non-fatal by construction: the account and its key are already safe at this
 * point, and a tx that doesn't confirm inside two minutes may still land. The
 * caller re-reads the balance regardless. */
async function waitForFunding(txHash: string, rpcUrl: string, log: (line: string) => void): Promise<void> {
  log(`  ${dim('funding tx')}  ${txHash}`);
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  try {
    const receipt = await provider.waitForTransaction(txHash, 1, 120_000);
    if (!receipt) log(status('skip', 'not confirmed within 120s', '— it may still land'));
    else if (receipt.status === 0) log(status('bad', 'funding tx reverted', '— fund the account another way'));
    else log(status('ok', 'funding confirmed'));
  } catch (err) {
    log(status('skip', 'could not confirm the funding tx', `(non-fatal) ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    provider.destroy();
  }
}

/** The one explanation of what connecting a wallet actually does, printed
 * before the browser opens so the user knows what they are about to be asked
 * to sign. Shared by every caller so they cannot describe it differently. */
export function connectPreamble(): string {
  return dim(
    wrap(
      'Your browser will open. Pick a wallet, then sign one message twice — ' +
        'it authorizes no transaction and costs no gas. dMemo derives your ' +
        'memory key from that signature, so your private key is never typed, ' +
        'pasted, or shared. Signing with the same wallet on another machine ' +
        'restores the same memories.',
      4
    )
  );
}
