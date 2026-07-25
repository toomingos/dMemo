// Ephemeral loopback server behind `dmemo connect`.
//
// The transport (127.0.0.1 bind, single-use token, Host/Origin checks, CSP,
// timeout) lives in `../loopback.ts` and is shared with `dmemo fund` — see
// that file's header for the threat model. What is specific to `connect` and
// therefore stays here is the route table below.
//
// The derived private key never crosses this boundary in either direction:
// the browser sends a signature, Node derives the key from it, and only the
// resulting address is sent back for display and funding.

import { renderConnectPage } from './page.js';
import { runLoopbackServer, str, NotFoundError } from '../loopback.js';

export interface SignaturePayload {
  address: string;
  signature: string;
  signatureRepeat: string;
}

export interface SignatureResponse {
  derivedAddress: string;
  needsFunding: boolean;
  balanceLabel: string;
}

export interface CompletePayload {
  txHash: string | null;
  skipped?: boolean;
}

export interface ConnectServerOptions {
  scope: string;
  network: 'testnet' | 'mainnet';
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  currencySymbol: string;
  fundAmountLabel: string;
  fundAmountWeiHex: string;
  faucetUrl?: string;
  timeoutMs?: number;
  /** Bind port. 0 (default) = let the OS pick a free ephemeral port. */
  port?: number;
  openBrowser?: boolean;
  log?: (line: string) => void;
  /** Text the wallet is asked to sign, built in Node for a single source of truth. */
  buildMessage: (address: string) => string;
  onSignature: (payload: SignaturePayload) => Promise<SignatureResponse>;
  onComplete: (payload: CompletePayload) => Promise<void>;
}

export interface ConnectServerResult {
  completed: true;
  txHash: string | null;
  skipped: boolean;
}

export async function runConnectServer(opts: ConnectServerOptions): Promise<ConnectServerResult> {
  const log = opts.log ?? ((line: string) => console.log(line));

  return await runLoopbackServer<ConnectServerResult>({
    timeoutMs: opts.timeoutMs,
    port: opts.port,
    openBrowser: opts.openBrowser,
    log: opts.log,
    waitingMessage: 'Waiting for your wallet…',
    invalidTokenMessage: 'Invalid or missing token. Re-run `npx dmemo connect`.',
    renderPage: (token) =>
      renderConnectPage({
        token,
        scope: opts.scope,
        network: opts.network,
        chainIdHex: opts.chainIdHex,
        chainName: opts.chainName,
        rpcUrl: opts.rpcUrl,
        currencySymbol: opts.currencySymbol,
        fundAmountLabel: opts.fundAmountLabel,
        fundAmountWeiHex: opts.fundAmountWeiHex,
        faucetUrl: opts.faucetUrl,
      }),
    async handle({ pathname, body, finish }) {
      switch (pathname) {
        case '/api/begin': {
          const address = str(body.address);
          if (!address) throw new Error('address required');
          return { message: opts.buildMessage(address) };
        }
        case '/api/signature': {
          const payload: SignaturePayload = {
            address: str(body.address),
            signature: str(body.signature),
            signatureRepeat: str(body.signatureRepeat),
          };
          return await opts.onSignature(payload);
        }
        case '/api/complete': {
          const txHash = typeof body.txHash === 'string' ? body.txHash : null;
          const skipped = body.skipped === true;
          await opts.onComplete({ txHash, skipped });
          finish({ completed: true, txHash, skipped });
          return { ok: true };
        }
        case '/api/error': {
          // The page reports recoverable wallet errors (user rejected, wrong
          // network) so the terminal isn't silent while the user stares at a
          // red message in the browser. Never fatal: they can retry in the
          // same page.
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
