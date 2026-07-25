// T4.1 step 2: faucet link / funding instructions + balance poll.
// Testnet-only in practice (TASKS.md ground rules): mainnet is supported as
// a config value (one env-var switch, per D14) but this CLI never prints a
// mainnet faucet link — there isn't one.

import { JsonRpcProvider, formatEther } from 'ethers';
import type { NetworkName } from './dmemoConfig.js';

// TASKS.md "Global constants" table (live-verified July 2026).
export const TESTNET_RPC_URL = 'https://evmrpc-testnet.0g.ai';
export const MAINNET_RPC_URL = 'https://evmrpc.0g.ai';
export const TESTNET_CHAIN_ID = 16602;
export const MAINNET_CHAIN_ID = 16661;
export const FAUCET_URL = 'https://faucet.0g.ai';

export function rpcUrlFor(network: NetworkName): string {
  return network === 'mainnet' ? MAINNET_RPC_URL : TESTNET_RPC_URL;
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

export function faucetInstructions(address: string): string {
  return [
    `Fund your wallet on 0G testnet (Galileo, chain ${TESTNET_CHAIN_ID}):`,
    `  1. Open ${FAUCET_URL}`,
    `  2. Paste your wallet address: ${address}`,
    `  3. Claim (0.1 0G/day) — dMemo's flush cost is ~0.0012-0.003 0G per`,
    `     write, so a single faucet claim funds many memory writes.`,
  ].join('\n');
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
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
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
