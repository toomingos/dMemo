// Ephemeral loopback server behind `dmemo fund`.
//
// Transport (127.0.0.1 bind, single-use token, Host/Origin checks, timeout)
// is shared with `dmemo connect` via `../loopback.ts` — see that file's
// header for the threat model. Two things are specific to funding:
//
//  1. CSP is widened by exactly one directive, `frame-src`, for exactly one
//     origin. `default-src 'none'` does NOT cover frames (frame-src falls
//     back through child-src to default-src, so it has to be named), and
//     nothing else is relaxed: the widget cannot run script in our page,
//     cannot be fetched by our script, and cannot read anything here.
//  2. Balance reads are cached. The page polls every 4s for a live display,
//     but that must not turn into an RPC call every 4s — the cache means the
//     poll rate and the RPC rate are independent knobs.

import { renderFundPage } from './page.js';
import { runLoopbackServer, str, STRICT_CSP, NotFoundError } from '../loopback.js';
import { TOKENFLIGHT_ORIGIN } from '../network.js';

export const FUND_CSP = `${STRICT_CSP}; frame-src ${TOKENFLIGHT_ORIGIN}`;

export interface FundBalance {
  balanceLabel: string;
  funded: boolean;
}

export interface FundServerOptions {
  address: string;
  network: 'testnet' | 'mainnet';
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  currencySymbol: string;
  fundAmountLabel: string;
  fundAmountWeiHex: string;
  /** Omitted on testnet — no fiat or cross-chain rail reaches chain 16602. */
  widgetUrl?: string;
  faucetUrl?: string;
  costLow: number;
  costHigh: number;
  valueHint?: string;
  /** Balance as of server start, so the page renders a real number
   * immediately instead of flashing a placeholder. */
  initialBalance: FundBalance;
  /** Reads the live balance. Called at most once per `balanceCacheMs`. */
  readBalance: () => Promise<FundBalance>;
  /** Minimum gap between real RPC reads. */
  balanceCacheMs?: number;
  timeoutMs?: number;
  port?: number;
  openBrowser?: boolean;
  log?: (line: string) => void;
  /** Called when the page reports a funding tx it just broadcast. */
  onSent?: (txHash: string) => void;
}

export interface FundServerResult {
  funded: boolean;
  skipped: boolean;
  balanceLabel: string;
}

const DEFAULT_BALANCE_CACHE_MS = 4000;

export async function runFundServer(opts: FundServerOptions): Promise<FundServerResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const cacheMs = opts.balanceCacheMs ?? DEFAULT_BALANCE_CACHE_MS;

  let latest: FundBalance = opts.initialBalance;
  let lastReadAt = Date.now();
  let inflight: Promise<FundBalance> | null = null;

  /** Cached read. Concurrent callers share one in-flight RPC rather than
   * stacking up, and a failed read keeps serving the last good value — a
   * flaky public RPC should not make the page look broken. */
  async function balance(): Promise<FundBalance> {
    if (Date.now() - lastReadAt < cacheMs) return latest;
    if (inflight) return await inflight;
    inflight = opts
      .readBalance()
      .then((next) => {
        latest = next;
        lastReadAt = Date.now();
        return next;
      })
      .catch(() => {
        // Back off the same as a success so a persistently failing RPC does
        // not get retried on every single poll.
        lastReadAt = Date.now();
        return latest;
      })
      .finally(() => {
        inflight = null;
      });
    return await inflight;
  }

  return await runLoopbackServer<FundServerResult>({
    csp: FUND_CSP,
    timeoutMs: opts.timeoutMs,
    port: opts.port,
    openBrowser: opts.openBrowser,
    log: opts.log,
    waitingMessage: 'Waiting for funds…',
    invalidTokenMessage: 'Invalid or missing token. Re-run `npx @dmemo/cli fund`.',
    renderPage: (token) =>
      renderFundPage({
        token,
        address: opts.address,
        network: opts.network,
        chainIdHex: opts.chainIdHex,
        chainName: opts.chainName,
        rpcUrl: opts.rpcUrl,
        currencySymbol: opts.currencySymbol,
        balanceLabel: opts.initialBalance.balanceLabel,
        fundAmountLabel: opts.fundAmountLabel,
        fundAmountWeiHex: opts.fundAmountWeiHex,
        widgetUrl: opts.widgetUrl,
        faucetUrl: opts.faucetUrl,
        costLow: opts.costLow,
        costHigh: opts.costHigh,
        valueHint: opts.valueHint,
      }),
    async handle({ pathname, body, finish }) {
      switch (pathname) {
        case '/api/balance':
          return await balance();

        case '/api/sent': {
          const txHash = str(body.txHash);
          if (txHash) {
            log(`  sent: ${txHash}`);
            opts.onSent?.(txHash);
          }
          return { ok: true };
        }

        case '/api/complete': {
          const skipped = body.skipped === true;
          // Trust the chain, not the page: re-read rather than believing a
          // `funded: true` the browser asserted.
          const current = skipped ? latest : await balance();
          finish({ funded: current.funded, skipped, balanceLabel: current.balanceLabel });
          return { ok: true };
        }

        case '/api/error': {
          const message = str(body.message);
          if (message) log(`  browser: ${message}`);
          return { ok: true };
        }

        default:
          throw new NotFoundError(pathname);
      }
    },
  });
}
