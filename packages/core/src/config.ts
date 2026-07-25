import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// --- F1: file-backed config fallback ---------------------------------------
//
// `loadConfigFromEnv` above is intentionally env-only (T1.6) — it stays the
// one place that parses/validates the env surface, and every host adapter
// that already has its own env (Claude Code/Codex hooks via
// `@dmemo/node-adapter`'s `loadDmemoEnv`, OpenClaw via its own config block)
// keeps working through it unchanged.
//
// `loadDmemoConfig` below is the layer on top: it looks at `process.env`
// first and, ONLY if `DMEMO_PRIVATE_KEY` isn't already there, falls back to
// `${DMEMO_HOME:-~/.dmemo}/config.json` — the exact file
// `@dmemo/setup-cli`'s `writeDmemoConfig` writes (same path resolution,
// same flat env-var-shaped JSON, same 0600-on-disk file; this module never
// writes it, only reads it). A real env var always wins, matching every
// other host adapter's precedence (explicit arg > env var > file > default)
// and the near-universal CLI convention. This is the one thing OpenCode's
// plugin was missing: it called `loadConfigFromEnv(process.env)` directly
// and so never saw a config written by `dmemo setup`.
//
// Deliberate placement here rather than in `@dmemo/node-adapter`: that
// package is `private: true` and Claude-Code/Codex-specific (bundled into
// `.cjs` hook scripts); publishable packages like `@dmemo/opencode-plugin`
// and `@dmemo/openclaw-plugin` cannot depend on it without pulling in
// hook-only machinery (marker files, debug logging, `CLAUDE_PLUGIN_OPTION_*`
// mapping) and would break `npm install` for external consumers (a private
// package doesn't get published). Every host adapter already depends on
// `@dmemo/core`, so putting the ONE extra reader here adds no new
// dependency anywhere and gives every non-Node-adapter host the same
// primitive. This does couple `@dmemo/core` to `node:fs`/`node:os` — but
// core already isn't portable to non-Node/Bun runtimes (`better-sqlite3`,
// `fastembed`, `pg` are all native/Node-only, and `runtime/bunSqliteCompat.ts`
// exists specifically because core runs in-process under OpenCode's Bun
// host), so this adds no new portability constraint.

/** Mirrors `@dmemo/setup-cli`'s `dmemoHome`/`dmemoConfigPath` exactly (same
 * env var, same default) so a config written by `dmemo setup` is found here
 * without any extra wiring. */
export function dmemoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DMEMO_HOME ?? path.join(os.homedir(), '.dmemo');
}

export function dmemoConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dmemoHome(env), 'config.json');
}

/**
 * Reads and parses `${DMEMO_HOME:-~/.dmemo}/config.json`. Never throws:
 * a missing file (nothing configured yet) and a malformed file (hand-edited,
 * truncated, ...) both just come back as `null` — the caller falls through
 * to env-only behavior either way, exactly like every other host adapter's
 * reader (`loadDmemoEnv`, OpenClaw's `dmemoConfigFile`).
 */
export function readDmemoConfigFile(env: NodeJS.ProcessEnv = process.env): Record<string, string> | null {
  try {
    const raw = fs.readFileSync(dmemoConfigPath(env), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
}

function hasPrivateKey(env: EnvSource): boolean {
  return Boolean(env.DMEMO_PRIVATE_KEY && env.DMEMO_PRIVATE_KEY.trim() !== '');
}

/**
 * Thrown when NEITHER a real environment variable NOR the config file on
 * disk has a usable `DMEMO_PRIVATE_KEY`. Names the exact path this process
 * looked for and points at the fix — never key material (there is none to
 * leak: this only fires when nothing was found).
 */
export class ConfigNotFoundError extends MissingConfigError {
  readonly configPath: string;

  constructor(configPath: string) {
    super('DMEMO_PRIVATE_KEY');
    this.name = 'ConfigNotFoundError';
    this.configPath = configPath;
    this.message =
      `dMemo is not configured: no DMEMO_PRIVATE_KEY in the environment, and no config file at ` +
      `${configPath}. Run \`npx dmemo setup\` (or \`dmemo connect\`) to configure a wallet.`;
  }
}

/**
 * Per-key merge, env wins: a key present (and not `undefined`) in `env`
 * is never overwritten by the file, but any key ONLY the file has (e.g.
 * `DMEMO_NETWORK` set via `dmemo setup` with no matching env var) still
 * comes through. Mirrors `@dmemo/node-adapter`'s `loadDmemoEnv` merge loop
 * exactly (`if (process.env[key] === undefined) process.env[key] = value`)
 * so the precedence rule is identical across every host, not just for
 * `DMEMO_PRIVATE_KEY`.
 */
function mergeFileUnderEnv(fileEnv: Record<string, string>, env: EnvSource): EnvSource {
  const merged: EnvSource = { ...env };
  for (const [key, value] of Object.entries(fileEnv)) {
    if (merged[key] === undefined && typeof value === 'string') {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Load dMemo config the way every host should: a real environment variable
 * wins if present; otherwise fall back to `${DMEMO_HOME:-~/.dmemo}/config.json`
 * (written by `dmemo setup`/`dmemo connect`); otherwise throw
 * `ConfigNotFoundError` naming the path it looked for. Reuses
 * `loadConfigFromEnv` for all parsing/validation/defaulting once the
 * effective env is assembled — this function's only job is resolving
 * env-vs-file precedence, not re-implementing config shape. The file is
 * always consulted (even when `DMEMO_PRIVATE_KEY` is already in env) so a
 * setting the environment doesn't cover (e.g. `DMEMO_NETWORK`) still comes
 * from the file — matching Claude Code/Codex's behavior via
 * `loadDmemoEnv`, not just the private-key case.
 */
export function loadDmemoConfig(env: EnvSource = process.env): DmemoConfig {
  const fileEnv = readDmemoConfigFile(env as NodeJS.ProcessEnv);
  const effective: EnvSource = fileEnv ? mergeFileUnderEnv(fileEnv, env) : env;
  if (!hasPrivateKey(effective)) {
    throw new ConfigNotFoundError(dmemoConfigPath(env as NodeJS.ProcessEnv));
  }
  return loadConfigFromEnv(effective);
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
