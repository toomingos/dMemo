// T4.1 step 2: faucet link / funding instructions + balance poll.
// Testnet-only in practice (TASKS.md ground rules): mainnet is supported as
// a config value (one env-var switch, per D14) but this CLI never prints a
// mainnet faucet link — there isn't one.

import { JsonRpcProvider, Network, formatEther } from 'ethers';
import type { NetworkName } from './dmemoConfig.js';
import { dim, indent, wrap } from './theme.js';

// TASKS.md "Global constants" table (live-verified July 2026).
export const TESTNET_RPC_URL = 'https://evmrpc-testnet.0g.ai';
export const MAINNET_RPC_URL = 'https://evmrpc.0g.ai';
export const TESTNET_CHAIN_ID = 16602;
export const MAINNET_CHAIN_ID = 16661;
export const FAUCET_URL = 'https://faucet.0g.ai';
export const MAINNET_EXPLORER_URL = 'https://chainscan.0g.ai';
export const TESTNET_EXPLORER_URL = 'https://chainscan-galileo.0g.ai';

export function rpcUrlFor(network: NetworkName): string {
  return network === 'mainnet' ? MAINNET_RPC_URL : TESTNET_RPC_URL;
}

/**
 * Block explorer for `wallet_addEthereumChain`. Optional in EIP-3085, but a
 * chain added without one gives the user no way to click through to the
 * funding transaction they just signed — the wallet renders a dead tx hash.
 */
export function blockExplorerFor(network: NetworkName): string {
  return network === 'mainnet' ? MAINNET_EXPLORER_URL : TESTNET_EXPLORER_URL;
}

export function chainIdFor(network: NetworkName): number {
  return network === 'mainnet' ? MAINNET_CHAIN_ID : TESTNET_CHAIN_ID;
}

export function chainNameFor(network: NetworkName): string {
  return network === 'mainnet' ? '0G Mainnet' : '0G Galileo Testnet';
}

/** EIP-3085/3326 want the chain id as a 0x-prefixed minimal hex string. */
export function chainIdHexFor(network: NetworkName): string {
  return '0x' + chainIdFor(network).toString(16);
}

export const CURRENCY_SYMBOL = '0G';

/**
 * The single answer to "how do I get funds on testnet". Deliberately the ONLY
 * instruction any testnet path prints: pairing this with a generic "send 0G to
 * <address>, or run `dmemo fund` again" gave two different answers to one
 * question, and the generic one is useless here — there is nothing to send
 * from on a chain whose only source of funds is this faucet.
 *
 * Callers indent it as a block; the line breaks carry meaning, so it goes
 * through `indent()`, never `wrap()`.
 */
export function faucetInstructions(address: string): string {
  return [
    `Testnet faucet — the only rail that reaches chain ${TESTNET_CHAIN_ID}:`,
    `  1. Open ${FAUCET_URL}`,
    `  2. Paste your address: ${address}`,
    `  3. Claim — 0.1 0G/day, and one claim covers dozens of memory writes`,
    `     (each costs ~${COST_PER_WRITE_0G_LOW}-${COST_PER_WRITE_0G_HIGH} 0G).`,
  ].join('\n');
}

/**
 * The one and only answer to "the account is still empty, now what". Every
 * path that ends unfunded — `setup --skip-funding`, `setup --yes`, declining
 * the prompt, closing the funding page, a poll that never saw funds — calls
 * exactly this, so a user cannot be told two different things depending on
 * which door they came through.
 *
 * Returns a formatted, indented block ready to hand straight to `log()`.
 */
export function fundingHelp(address: string, network: NetworkName): string {
  if (network === 'testnet') return dim(indent(faucetInstructions(address), 4));
  return dim(
    wrap(
      `Run \`npx @dmemo/cli fund\` to add ${CURRENCY_SYMBOL} — card, Apple Pay, crypto from another chain, or a wallet you already have. \`npx @dmemo/cli balance\` checks the account any time.`,
      4
    )
  );
}

// --- Funding rails (`dmemo fund`) ---------------------------------------
//
// See research/0g-pay-funding.md for the live verification behind all of
// this. Two things worth restating here, because they are counter-intuitive:
//
//  1. 0G Pay (pc.0g.ai) does NOT help us. It sells compute credits on the
//     Router ledger for inference; those credits cannot pay storage gas.
//     What we use is the Khalani/TokenFlight settlement layer underneath it.
//  2. The fiat API is origin-allowlisted and rejects 127.0.0.1, so the CLI
//     cannot quote a card purchase itself. The hosted widget reads its whole
//     configuration from query params, so an iframe makes those calls from
//     its own allowlisted origin. That is why this is a URL builder and not
//     an API client.

/** Hosted TokenFlight widget. dMemo's ONLY external network dependency, and
 * it is loaded lazily — see `fund/page.ts`. */
export const TOKENFLIGHT_ORIGIN = 'https://embed.tokenflight.ai';
export const TOKENFLIGHT_WIDGET_URL = `${TOKENFLIGHT_ORIGIN}/widget/`;

/** CAIP-19-ish token id the widget expects. The zero address is native 0G
 * (the gas token) rather than an ERC-20 — that is what storage fees are paid
 * in, so it is what we must deliver. */
export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Transak's floor and ceiling, from a live `/v1/fiat/quote` response
 * (`minFiatAmount` / `maxFiatAmount`). */
export const FIAT_MIN_USD = 5;
export const FIAT_MAX_USD = 3000;

/** $25 is the default because the fee curve flattens there: $5 costs 24.8%
 * in fees, $25 costs 8.8%, $100 costs 5.9%. Even $5 buys thousands of
 * writes, so this is about not wasting the user's money, not about access. */
export const FIAT_DEFAULT_USD = 25;

/** Observed flush cost, for translating 0G into something a user can reason
 * about. Quoted as a range because it varies with blob size. */
export const COST_PER_WRITE_0G_LOW = 0.0012;
export const COST_PER_WRITE_0G_HIGH = 0.003;

/** Rough writes-per-dollar, using the high end of the cost range and the $25
 * quote (127.62 0G for $25). Deliberately conservative and deliberately
 * round — this is framing for a human, not an invoice. */
export function approximateWritesForUsd(usd: number): number {
  const zeroGPerUsd = 127.62 / 25;
  return Math.round((usd * zeroGPerUsd) / COST_PER_WRITE_0G_HIGH);
}

export interface TokenflightWidgetOptions {
  /** Locked destination — funds can only ever land in the dMemo account. */
  recipient: string;
  /** Prefilled fiat amount. Omit to let the widget choose. */
  amountUsd?: number;
  /** 'card' | 'crypto', or both. Controls which tab the widget opens on. */
  methods?: Array<'card' | 'crypto'>;
  theme?: 'light' | 'dark';
  titleText?: string;
}

/**
 * Builds the widget URL. Every field that could redirect funds away from the
 * dMemo account is pinned and marked non-editable: `recipient`,
 * `recipient-editable=false`, `to-token`, `lock-to-token=true`. The user
 * chooses what they pay with; they cannot change where it lands.
 *
 * Mainnet only by construction — chain 16661 is hard-coded because the
 * testnet chain (16602) is not on any of these rails. `fund.ts` must not
 * call this for testnet.
 */
export function tokenflightWidgetUrl(opts: TokenflightWidgetOptions): string {
  const params = new URLSearchParams({
    'to-token': `eip155:${MAINNET_CHAIN_ID}:${NATIVE_TOKEN_ADDRESS}`,
    'lock-to-token': 'true',
    recipient: opts.recipient,
    'recipient-editable': 'false',
    'trade-type': 'EXACT_INPUT',
    theme: opts.theme ?? 'dark',
    'hide-powered-by': 'false',
  });
  if (opts.methods?.length) params.set('methods', JSON.stringify(opts.methods));
  if (opts.amountUsd !== undefined) params.set('amount', String(opts.amountUsd));
  if (opts.titleText) params.set('title-text', opts.titleText);
  return `${TOKENFLIGHT_WIDGET_URL}?${params.toString()}`;
}

export interface BalanceCheckResult {
  address: string;
  network: NetworkName;
  balanceWei: bigint;
  balanceFormatted: string;
  funded: boolean;
}

/** Zero-spend read-only balance check — never touches the private key,
 * never signs anything. Timeouts fast (this is a UX nicety, not something
 * the setup flow should hang on if the public RPC is flaky). */
export async function checkBalance(
  address: string,
  network: NetworkName,
  opts: { rpcUrl?: string; timeoutMs?: number } = {}
): Promise<BalanceCheckResult> {
  const rpcUrl = opts.rpcUrl ?? rpcUrlFor(network);
  // A concrete static network, not `staticNetwork: true`: we already know the
  // chain id, so this skips the eth_chainId detection round-trip entirely.
  // `true` still detects once, and against an unreachable RPC that detection
  // retries and prints its own warning before our timeout ever fires.
  const provider = new JsonRpcProvider(rpcUrl, Network.from(chainIdFor(network)), {
    staticNetwork: true,
  });
  const timeoutMs = opts.timeoutMs ?? 8000;

  const balanceWei = await Promise.race([
    provider.getBalance(address),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`balance check timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]).finally(() => {
    provider.destroy();
  });

  return {
    address,
    network,
    balanceWei,
    balanceFormatted: formatEther(balanceWei),
    funded: balanceWei > 0n,
  };
}
