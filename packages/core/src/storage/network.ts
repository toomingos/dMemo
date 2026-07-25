// Network tuple selection (D14) — single env var `DMEMO_NETWORK=testnet|mainnet`
// picks {rpc, indexer, flow address, router URL}. Values are the live-verified
// Phase 0 constants from TASKS.md's "Global constants" table.

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkConfig {
  network: NetworkName;
  chainId: number;
  rpcUrl: string;
  indexerUrl: string;
  /** FixedPriceFlow contract address. Not exported by the 0G SDK — hardcoded
   * per network (per TASKS.md gotchas). `undefined` means "not yet known for
   * this network" and must be supplied via override before any storage op
   * runs against it (see mainnet note below). */
  flowAddress?: string;
  routerUrl: string;
}

/**
 * `eth_getLogs` range cap on the public testnet RPC, live-measured at
 * ~4.78M blocks (~22 days @0.4s/block). Stay comfortably under it; halve on
 * RPC rejection (see client.ts `getLogsPaginated`).
 */
export const BLOCK_RANGE_CAP = 4_700_000;

const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    network: 'testnet',
    chainId: 16602,
    rpcUrl: 'https://evmrpc-testnet.0g.ai',
    indexerUrl: 'https://indexer-storage-testnet-turbo.0g.ai',
    flowAddress: '0x22e03a6a89b950f1c82ec5e74f8eca321a105296',
    routerUrl: 'https://router-api-testnet.integratenetwork.work/v1',
  },
  mainnet: {
    network: 'mainnet',
    chainId: 16661,
    rpcUrl: 'https://evmrpc.0g.ai',
    indexerUrl: 'https://indexer-storage-turbo.0g.ai',
    // NOT in TASKS.md's Global constants table (testnet-only value is given
    // there) and never live-verified this phase — deliberately left unset.
    // resolveNetworkConfig() throws if a caller reaches for mainnet without
    // supplying `flowAddressOverride`. Ground rule: never call mainnet
    // endpoints during Phase 1 verification.
    flowAddress: undefined,
    routerUrl: 'https://router-api.0g.ai/v1',
  },
};

export interface NetworkOverrides {
  rpcUrl?: string;
  indexerUrl?: string;
  flowAddress?: string;
  routerUrl?: string;
}

export function resolveNetworkConfig(network: NetworkName, overrides: NetworkOverrides = {}): NetworkConfig {
  const base = NETWORKS[network];
  if (!base) throw new Error(`unknown DMEMO_NETWORK: ${network}`);
  const merged: NetworkConfig = {
    ...base,
    rpcUrl: overrides.rpcUrl ?? base.rpcUrl,
    indexerUrl: overrides.indexerUrl ?? base.indexerUrl,
    flowAddress: overrides.flowAddress ?? base.flowAddress,
    routerUrl: overrides.routerUrl ?? base.routerUrl,
  };
  if (!merged.flowAddress) {
    throw new Error(
      `no FixedPriceFlow address known for network "${network}" — supply DMEMO_FLOW_ADDRESS ` +
        `(mainnet address was never live-verified in Phase 0/1; testnet works out of the box)`
    );
  }
  return merged;
}
