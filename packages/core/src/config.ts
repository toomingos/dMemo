import type { NetworkName, NetworkOverrides } from './storage/network.js';
import type { ExplicitEmbedderConfig } from './embedder.js';

// T1.6 — env surface (D14, D17). The memory leg (everything in this
// package) must work end-to-end with ZERO Router/inference credentials —
// ZEROG_API_KEY is read through here only so `dmemo doctor`-style tooling
// can report its presence, never touched by session/storage/journal logic.

export interface DmemoConfig {
  network: NetworkName;
  /** Wallet private key — doubles as the ECIES memory key (D2). Required:
   * there is no memory leg without a wallet. */
  privateKey: string;
  /** Verbatim-capture toggle (D17). Default false: no second LLM call to
   * infer/summarize memories: whatever is `add()`-ed is stored as-is. */
  infer: boolean;
  embedder?: ExplicitEmbedderConfig;
  /** K in the K=2-flushes-per-checkpoint cadence (Phase 0 T0.3 tuning). */
  checkpointEveryNFlushes: number;
  /** Size threshold (bytes) that also forces a checkpoint regardless of K. */
  checkpointSizeThresholdBytes: number;
  /** App-level upload timeout (gotcha 15). */
  uploadTimeoutMs: number;
  pointerCachePath?: string;
  networkOverrides: NetworkOverrides;
  /** 0G Router API key. Inference leg only (Phase 2) — never read by
   * anything in @dmemo/core's storage/session/journal path (D11
   * separability: memory works with zero Router key). */
  zerogApiKey?: string;
}

export type EnvSource = Record<string, string | undefined>;

const DEFAULT_CHECKPOINT_K = 2;
const DEFAULT_CHECKPOINT_SIZE_THRESHOLD_BYTES = 64 * 1024; // 64KB
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim().toLowerCase() === 'true' || value.trim() === '1';
}

export class MissingConfigError extends Error {
  constructor(varName: string) {
    super(`missing required env var: ${varName}`);
    this.name = 'MissingConfigError';
  }
}

/**
 * Load dMemo config from an env-like object (defaults to `process.env`).
 * Only `DMEMO_PRIVATE_KEY` is hard-required — everything else has a
 * documented default so the memory leg works out of the box on testnet
 * with zero other configuration (besides funding the wallet).
 */
export function loadConfigFromEnv(env: EnvSource = process.env): DmemoConfig {
  const privateKey = env.DMEMO_PRIVATE_KEY;
  if (!privateKey) throw new MissingConfigError('DMEMO_PRIVATE_KEY');

  const network = (env.DMEMO_NETWORK ?? 'testnet') as NetworkName;
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`invalid DMEMO_NETWORK "${network}" — must be "testnet" or "mainnet"`);
  }

  let embedder: ExplicitEmbedderConfig | undefined;
  if (env.DMEMO_EMBEDDER_PROVIDER) {
    embedder = { provider: env.DMEMO_EMBEDDER_PROVIDER, model: env.DMEMO_EMBEDDER_MODEL };
  }

  return {
    network,
    privateKey,
    infer: parseBoolEnv(env.DMEMO_INFER, false),
    embedder,
    checkpointEveryNFlushes: parseIntEnv(env.DMEMO_CHECKPOINT_K, DEFAULT_CHECKPOINT_K),
    checkpointSizeThresholdBytes: parseIntEnv(
      env.DMEMO_CHECKPOINT_SIZE_THRESHOLD_BYTES,
      DEFAULT_CHECKPOINT_SIZE_THRESHOLD_BYTES
    ),
    uploadTimeoutMs: parseIntEnv(env.DMEMO_UPLOAD_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS),
    pointerCachePath: env.DMEMO_POINTER_CACHE_PATH,
    networkOverrides: {
      rpcUrl: env.DMEMO_RPC_URL,
      indexerUrl: env.DMEMO_INDEXER_URL,
      flowAddress: env.DMEMO_FLOW_ADDRESS,
      routerUrl: env.DMEMO_ROUTER_URL,
    },
    zerogApiKey: env.ZEROG_API_KEY,
  };
}
