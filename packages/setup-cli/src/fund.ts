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
  fundingHelp,
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
import { bold, dim, lime, outcome, status, symbols, wrap } from './theme.js';

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
  /** Set by `setup`, which runs this as its step 3. Suppresses the standalone
   * banner and the closing rule — inside setup those are the wrapper's job,
   * and printing a second "▪ dMemo fund" header mid-wizard reads as a
   * different program starting. */
  embedded?: boolean;
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

  const sym = symbols();
  const embedded = opts.embedded === true;
  /** `  account   0x…` — the same dim-key/bright-value column setup uses. */
  const field = (key: string, value: string, note?: string): string =>
    `  ${dim(key.padEnd(7))}  ${value}${note ? `  ${dim(note)}` : ''}`;

  if (!embedded) {
    log(
      `${lime(sym.mark)} ${bold('dMemo fund')} ` +
        `${dim(`${sym.bullet} ${chainNameFor(network)} (chain ${chainIdFor(network)})`)}`
    );
    log('');
  }
  log(field('account', address));

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
    log(
      status(
        'skip',
        'balance check failed',
        `(assuming unfunded) ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }

  const writesNote = (wei: bigint): string =>
    `${sym.bullet} ~${writesFor(wei).toLocaleString('en-US')} memory writes`;

  if (balanceWei >= threshold) {
    log(field('balance', `${balanceLabel} ${CURRENCY_SYMBOL}`, writesNote(balanceWei)));
    log('');
    log(status('ok', 'already funded', 'nothing to do'));
    if (!embedded) {
      log('');
      log(outcome('Funded', `${balanceLabel} ${CURRENCY_SYMBOL}`));
      log('');
    }
    return { address, network, funded: true, skipped: false, balanceLabel, alreadyFunded: true };
  }

  log(field('balance', `${balanceLabel} ${CURRENCY_SYMBOL}`, balanceWei === 0n ? '— empty' : undefined));
  log('');
  log(
    dim(
      wrap(
        `Each memory write costs about ${COST_PER_WRITE_0G_LOW}–${COST_PER_WRITE_0G_HIGH} ${CURRENCY_SYMBOL}, so a small amount lasts a long time.`,
        2
      )
    )
  );
  log('');

  if (network === 'testnet') {
    // Neither the fiat nor the cross-chain rail lists chain 16602, so the
    // page must not offer them. The faucet is the only route.
    log(status('skip', 'card and cross-chain funding are mainnet-only'));
    log(
      dim(
        wrap(
          `Those rails do not reach chain ${chainIdFor(network)}. The faucet is the way in, and the page opening now links straight to it.`,
          4
        )
      )
    );
    log('');
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

  // Three terminal states, one message each. The old code answered the
  // "skipped" case twice — a generic "send 0G to <address>" *and* the full
  // faucet procedure — which on testnet is actively wrong: there is nothing
  // to send from. `fundingHelp()` is now the single source for "still empty".
  if (result.funded) {
    log(
      status(
        'ok',
        'funded',
        `${result.balanceLabel} ${CURRENCY_SYMBOL} ${writesNote(parseEther(result.balanceLabel))}`
      )
    );
    if (!embedded) {
      log('');
      log(outcome('Funded', `${result.balanceLabel} ${CURRENCY_SYMBOL}`));
    }
  } else if (result.skipped) {
    log(status('skip', 'not funded', 'you closed the page without funding'));
    log(fundingHelp(address, network));
  } else {
    log(status('skip', 'not funded', 'nothing arrived while the page was open'));
    if (network === 'mainnet') {
      log(
        dim(
          wrap(
            `A card or cross-chain purchase can still be settling — it lands at ${address} on its own, with nothing more to do here.`,
            4
          )
        )
      );
    }
    log(fundingHelp(address, network));
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
