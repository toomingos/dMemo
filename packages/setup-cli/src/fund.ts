// `dmemo fund` — get 0G into the dMemo account, whatever the user is
// starting from.
//
// This is the gap `connect` left open. Its step 4 could only move native 0G
// from an already-funded browser wallet on 0G, which covers exactly one kind
// of user. The four real starting points are:
//
//   has 0G on 0G           -> eth_sendTransaction (unchanged, no third party)
//   has funds on Base/Arb/… -> Khalani cross-chain swap, delivered as native 0G
//   has no crypto           -> card / Apple Pay / Google Pay via Transak
//   has no wallet at all    -> same card path; an address is just an address,
//                              so nothing needs to be installed
//
// The last one is the point worth stating plainly: `dmemo setup` generates an
// address locally, and a card purchase can deliver 0G straight to it. A user
// who has never touched crypto never installs a wallet.
//
// What this file does NOT do is call the funding rails itself. The fiat API
// is origin-allowlisted and rejects loopback, so pricing and checkout happen
// in a hosted widget the page embeds. Node's only job is to serve the page,
// read balances, and decide when the money arrived. See
// research/0g-pay-funding.md.

import { parseEther, formatEther, getAddress } from 'ethers';
import {
  rpcUrlFor,
  chainIdFor,
  chainIdHexFor,
  chainNameFor,
  checkBalance,
  tokenflightWidgetUrl,
  approximateWritesForUsd,
  faucetInstructions,
  CURRENCY_SYMBOL,
  FAUCET_URL,
  FIAT_MIN_USD,
  FIAT_MAX_USD,
  FIAT_DEFAULT_USD,
  COST_PER_WRITE_0G_LOW,
  COST_PER_WRITE_0G_HIGH,
} from './network.js';
import { readDmemoConfig, type NetworkName } from './dmemoConfig.js';
import { runFundServer } from './fund/server.js';

export interface FundOptions {
  env?: NodeJS.ProcessEnv;
  /** Fund this address instead of the one in the config. Used by `setup`,
   * which already knows the address it just wrote. */
  address?: string;
  network?: NetworkName;
  /** Prefilled fiat amount for the card path, in USD. */
  usd?: number;
  /** Amount the "send from a wallet" button offers, in 0G. */
  fundAmount?: string;
  noOpen?: boolean;
  port?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface FundResult {
  address: string;
  network: NetworkName;
  funded: boolean;
  skipped: boolean;
  balanceLabel: string;
  /** True when the balance was already sufficient and no browser was opened. */
  alreadyFunded: boolean;
}

/** Same threshold `connect` uses: below this an account cannot pay for even a
 * handful of writes. */
const FUNDED_THRESHOLD_ETHER = '0.005';
const DEFAULT_FUND_AMOUNT_ETHER = '0.05';

export async function runFund(opts: FundOptions = {}): Promise<FundResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));

  const config = readDmemoConfig(env);
  const rawAddress =
    opts.address ?? (typeof config?.DMEMO_ADDRESS === 'string' ? config.DMEMO_ADDRESS : '');
  if (!rawAddress) {
    throw new Error('No wallet address on record. Run `npx @dmemo/cli setup` or `npx @dmemo/cli connect` first.');
  }

  // Hard-fail rather than proceed. Everything downstream — the widget's
  // locked `recipient`, the wallet send button — points real money at this
  // string, and a balance read failing is NOT a safe way to discover it is
  // malformed: that path shrugs and shows "0.0", which looks like an
  // unfunded account rather than a broken one.
  let address: string;
  try {
    address = getAddress(rawAddress.trim());
  } catch {
    throw new Error(
      `The address on record is not a valid Ethereum address: ${rawAddress}\n` +
        'Refusing to open a funding flow that could send funds nowhere. Check\n' +
        'DMEMO_ADDRESS in ~/.dmemo/config.json, or re-run `npx @dmemo/cli connect`.'
    );
  }

  const network: NetworkName =
    opts.network ??
    (env.DMEMO_NETWORK as NetworkName) ??
    (config?.DMEMO_NETWORK as NetworkName) ??
    'mainnet';

  const usd = clampUsd(opts.usd ?? FIAT_DEFAULT_USD);
  const fundAmount = opts.fundAmount ?? DEFAULT_FUND_AMOUNT_ETHER;
  const threshold = parseEther(FUNDED_THRESHOLD_ETHER);

  log(`dMemo fund — ${chainNameFor(network)} (chain ${chainIdFor(network)})\n`);
  log(`  Account  ${address}`);

  // --- already funded? short-circuit without opening anything -------------
  let balanceWei = 0n;
  let balanceLabel = '0.0';
  try {
    const balance = await checkBalance(address, network);
    balanceWei = balance.balanceWei;
    balanceLabel = balance.balanceFormatted;
  } catch (err) {
    // Offering to fund an already-funded account wastes a click; refusing to
    // fund an empty one strands the user. Assume unfunded.
    log(`  balance check failed (assuming unfunded): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (balanceWei >= threshold) {
    log(`  Balance  ${balanceLabel} ${CURRENCY_SYMBOL} — already funded, nothing to do.\n`);
    log(`  That is roughly ${writesFor(balanceWei).toLocaleString('en-US')} memory writes.`);
    return { address, network, funded: true, skipped: false, balanceLabel, alreadyFunded: true };
  }

  log(`  Balance  ${balanceLabel} ${CURRENCY_SYMBOL}\n`);
  log(
    `Each memory write costs about ${COST_PER_WRITE_0G_LOW}–${COST_PER_WRITE_0G_HIGH} ${CURRENCY_SYMBOL}, ` +
      `so a small\namount lasts a long time.\n`
  );

  if (network === 'testnet') {
    // Neither the fiat nor the cross-chain rail lists chain 16602, so the
    // page must not offer them. The faucet is the only route.
    log('Testnet: card and cross-chain funding are mainnet-only — those rails');
    log('do not reach chain 16602. The faucet is the way in.\n');
  }

  const result = await runFundServer({
    address,
    network,
    chainIdHex: chainIdHexFor(network),
    chainName: chainNameFor(network),
    rpcUrl: rpcUrlFor(network),
    currencySymbol: CURRENCY_SYMBOL,
    fundAmountLabel: fundAmount,
    fundAmountWeiHex: '0x' + parseEther(fundAmount).toString(16),
    widgetUrl:
      network === 'mainnet'
        ? tokenflightWidgetUrl({
            recipient: address,
            amountUsd: usd,
            titleText: 'Fund your dMemo account',
          })
        : undefined,
    faucetUrl: network === 'testnet' ? FAUCET_URL : undefined,
    costLow: COST_PER_WRITE_0G_LOW,
    costHigh: COST_PER_WRITE_0G_HIGH,
    valueHint: `$${usd} ≈ ${approximateWritesForUsd(usd).toLocaleString('en-US')} memory writes`,
    initialBalance: { balanceLabel, funded: balanceWei >= threshold },
    readBalance: async () => {
      const balance = await checkBalance(address, network);
      return {
        balanceLabel: balance.balanceFormatted,
        funded: balance.balanceWei >= threshold,
      };
    },
    port: opts.port,
    timeoutMs: opts.timeoutMs,
    openBrowser: !opts.noOpen,
    log,
  });

  log('');
  if (result.funded) {
    log(`✔ Funded — ${result.balanceLabel} ${CURRENCY_SYMBOL}.`);
    log(`  Roughly ${writesFor(parseEther(result.balanceLabel)).toLocaleString('en-US')} memory writes.`);
  } else if (result.skipped) {
    log('Funding skipped — the account is still empty.');
    log(`  Send ${CURRENCY_SYMBOL} to ${address} on ${chainNameFor(network)},`);
    log('  or run `npx @dmemo/cli fund` again. `npx @dmemo/cli balance` checks it any time.');
    if (network === 'testnet') {
      log('');
      log(faucetInstructions(address));
    }
  } else {
    log('No funds arrived yet.');
    log(`  If a card or cross-chain purchase is still settling it will land at ${address}`);
    log('  on its own — check with `npx @dmemo/cli balance`.');
  }
  log('');

  return {
    address,
    network,
    funded: result.funded,
    skipped: result.skipped,
    balanceLabel: result.balanceLabel,
    alreadyFunded: false,
  };
}

/** Transak's floor and ceiling, from a live quote. Out-of-range values are
 * clamped rather than rejected — the number is a convenience prefill, not
 * something worth failing a command over. */
function clampUsd(usd: number): number {
  if (!Number.isFinite(usd)) return FIAT_DEFAULT_USD;
  return Math.min(FIAT_MAX_USD, Math.max(FIAT_MIN_USD, Math.round(usd)));
}

function writesFor(balanceWei: bigint): number {
  return Math.round(Number(formatEther(balanceWei)) / COST_PER_WRITE_0G_HIGH);
}
