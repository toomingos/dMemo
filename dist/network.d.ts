import type { NetworkName } from './dmemoConfig.js';
export declare const TESTNET_RPC_URL = "https://evmrpc-testnet.0g.ai";
export declare const MAINNET_RPC_URL = "https://evmrpc.0g.ai";
export declare const TESTNET_CHAIN_ID = 16602;
export declare const MAINNET_CHAIN_ID = 16661;
export declare const FAUCET_URL = "https://faucet.0g.ai";
export declare function rpcUrlFor(network: NetworkName): string;
export declare function chainIdFor(network: NetworkName): number;
export declare function chainNameFor(network: NetworkName): string;
/** EIP-3085/3326 want the chain id as a 0x-prefixed minimal hex string. */
export declare function chainIdHexFor(network: NetworkName): string;
export declare const CURRENCY_SYMBOL = "0G";
export declare function faucetInstructions(address: string): string;
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
export declare function checkBalance(address: string, network: NetworkName, opts?: {
    rpcUrl?: string;
    timeoutMs?: number;
}): Promise<BalanceCheckResult>;
//# sourceMappingURL=network.d.ts.map