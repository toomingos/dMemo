// T4.1 step 3: write `~/.dmemo/config.json`. File name/shape/location must
// match exactly what `@dmemo/node-adapter`'s `src/lib/settings.ts`
// (`loadDmemoEnv`) and every other host adapter already expect: a flat JSON
// object whose keys are the exact env var names `@dmemo/core`'s
// `loadConfigFromEnv` reads (`DMEMO_PRIVATE_KEY`, `DMEMO_NETWORK`, ...) at
// `${DMEMO_HOME:-~/.dmemo}/config.json`, file mode 0600 (contains a private
// key).
//
// `DMEMO_PRIVATE_KEY` is not a rotatable credential. It is the ONLY key that
// can decrypt this wallet's blobs on 0G Storage, so replacing it does not
// "reconfigure" anything — it orphans every memory ever written. This module
// therefore treats a key swap the way `solana-keygen new` and
// `gramine-sgx-gen-private-key` treat an existing key file: refuse by
// default, require an explicit opt-in, and never destroy the old value
// without leaving a copy behind.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';

export type NetworkName = 'testnet' | 'mainnet';

export interface DmemoConfigFile {
  DMEMO_PRIVATE_KEY: string;
  DMEMO_NETWORK: NetworkName;
  [key: string]: string | undefined;
}

/** Mirrors `@dmemo/node-adapter`'s `DMEMO_HOME` resolution exactly (env
 * override for sandboxed testing, `~/.dmemo` otherwise) so a config written
 * by this CLI is found by every host adapter without any extra wiring. */
export function dmemoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DMEMO_HOME ?? path.join(os.homedir(), '.dmemo');
}

export function dmemoConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dmemoHome(env), 'config.json');
}

export interface WriteConfigOptions {
  /**
   * Permit this write to replace an existing, DIFFERENT `DMEMO_PRIVATE_KEY`.
   * Without it such a write throws `ExistingKeyError` and touches nothing.
   * Writing the SAME key back is never a replacement and never needs this
   * (that is what keeps an idempotent `dmemo setup` re-run safe).
   */
  allowKeyReplacement?: boolean;
}

export interface WriteConfigResult {
  path: string;
  created: boolean;
  merged: boolean;
  /** Timestamped 0600 copy taken before this write destroyed anything
   * (a key swap, or an unparseable file), or null if nothing was at risk. */
  backupPath: string | null;
  /** True if this write swapped `DMEMO_PRIVATE_KEY` for a different value. */
  keyReplaced: boolean;
}

/** Everything about an on-record key that is safe to show a human. Carries no
 * key material — only the address it derives to and its provenance. */
export interface ExistingKeyInfo {
  configPath: string;
  /** Address of the stored key. Null only if the stored value is unparseable. */
  address: string | null;
  /** `'connect'` for a key derived from a wallet signature (reproducible by
   * reconnecting the same wallet + scope), otherwise `'generated'` for a
   * random or imported key, which exists nowhere else in the universe. */
  source: 'connect' | 'generated';
  scope?: string;
  connectedWallet?: string;
  network?: string;
}

/** Thrown instead of clobbering a key the caller did not explicitly consent
 * to replace. Never carries key material — address and provenance only. */
export class ExistingKeyError extends Error {
  readonly existing: ExistingKeyInfo;
  readonly incomingAddress: string | null;

  constructor(existing: ExistingKeyInfo, incomingAddress: string | null) {
    super(
      `Refusing to overwrite the wallet already configured in ${existing.configPath}.\n` +
        `  on record: ${existing.address ?? '<unreadable key>'} (${existing.source})\n` +
        `  incoming:  ${incomingAddress ?? '<unreadable key>'}\n` +
        'That key is the only thing that can decrypt this wallet\'s memories on 0G — ' +
        'replacing it orphans every memory written under it.'
    );
    this.name = 'ExistingKeyError';
    this.existing = existing;
    this.incomingAddress = incomingAddress;
  }
}

/** `0x`-prefixed lowercase, so two spellings of the same key compare equal. */
function normalizeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withPrefix = /^0x/i.test(trimmed) ? trimmed : `0x${trimmed}`;
  return withPrefix.toLowerCase();
}

/** Address for a private key, or null if it isn't one. Never throws, and
 * never includes the key in anything it returns. */
export function addressForKey(key: unknown): string | null {
  const normalized = normalizeKey(key);
  if (!normalized) return null;
  try {
    return new Wallet(normalized).address;
  } catch {
    return null;
  }
}

function readRawConfig(configPath: string): { parsed: Record<string, unknown> | null; exists: boolean } {
  if (!fs.existsSync(configPath)) return { parsed: null, exists: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { parsed: parsed as Record<string, unknown>, exists: true };
    }
  } catch {
    // fall through — an unparseable file still exists and still deserves a backup
  }
  return { parsed: null, exists: true };
}

/**
 * Describes the key currently on record, or null if there is none. Callers
 * use this to decide whether they are about to do something destructive
 * BEFORE they do any work (generate a wallet, spawn a browser, ...).
 */
export function inspectExistingKey(env: NodeJS.ProcessEnv = process.env): ExistingKeyInfo | null {
  const configPath = dmemoConfigPath(env);
  const { parsed } = readRawConfig(configPath);
  if (!parsed) return null;
  const key = normalizeKey(parsed.DMEMO_PRIVATE_KEY);
  if (!key) return null;

  const stored = typeof parsed.DMEMO_ADDRESS === 'string' ? parsed.DMEMO_ADDRESS : null;
  return {
    configPath,
    // Prefer the derived address over the recorded one: a hand-edited config
    // can easily have a DMEMO_ADDRESS that no longer matches its key, and the
    // key is the thing that actually decides which memories are reachable.
    address: addressForKey(key) ?? stored,
    source: parsed.DMEMO_KEY_SOURCE === 'connect' ? 'connect' : 'generated',
    scope: typeof parsed.DMEMO_SCOPE === 'string' ? parsed.DMEMO_SCOPE : undefined,
    connectedWallet:
      typeof parsed.DMEMO_CONNECTED_WALLET === 'string' ? parsed.DMEMO_CONNECTED_WALLET : undefined,
    network: typeof parsed.DMEMO_NETWORK === 'string' ? parsed.DMEMO_NETWORK : undefined,
  };
}

/** How to get back a key that was just replaced — recovery advice tailored to
 * how the old key came into existence. */
export function recoveryHint(existing: ExistingKeyInfo, backupPath: string | null): string {
  const lines: string[] = [];
  if (backupPath) lines.push(`The previous config was copied to ${backupPath} (mode 0600).`);
  if (existing.source === 'connect' && existing.connectedWallet) {
    lines.push(
      `That account was derived from wallet ${existing.connectedWallet}` +
        `${existing.scope ? ` with scope "${existing.scope}"` : ''} — ` +
        '`npx dmemo connect` with the same wallet and scope reproduces it exactly.'
    );
  } else if (backupPath) {
    lines.push(
      'That key was generated locally and exists nowhere else, so that backup is the only copy — ' +
        'restore it over config.json to get those memories back.'
    );
  } else {
    // Pre-replacement: there is no backup to point at yet, so promise one
    // rather than referring to a file that does not exist.
    lines.push(
      'That key was generated locally and exists nowhere else; a timestamped backup ' +
        'will be written before it is replaced.'
    );
  }
  return lines.join('\n');
}

/** `config.json.2026-07-25T14-32-05-123Z.bak` — sorts chronologically, has no
 * characters that are illegal in a filename on any supported platform. */
function backupPathFor(configPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${configPath}.${stamp}.bak`;
}

/**
 * Copies `configPath` aside before we destroy it. COPYFILE_EXCL so a backup
 * can never overwrite a backup — on collision (two writes inside the same
 * millisecond) we suffix rather than lose the earlier one.
 */
function backupConfig(configPath: string, now: Date): string {
  const base = backupPathFor(configPath, now);
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? base : `${base}.${attempt}`;
    try {
      fs.copyFileSync(configPath, candidate, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(candidate, 0o600);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 100) continue;
      throw err;
    }
  }
}

/**
 * Write the config so a crash mid-write cannot truncate it. `wx` on the temp
 * file is the exclusive-open the Node fs docs recommend over an `existsSync`
 * pre-check (no TOCTOU window); the rename that follows is atomic within the
 * directory, so readers see either the whole old file or the whole new one.
 */
function writeConfigAtomic(configPath: string, contents: string): void {
  const dir = path.dirname(configPath);
  const tmpPath = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Belt and braces: `mode` on open is masked by umask, and the file may
    // pre-date a umask change on a retry path.
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* never created, or already renamed away */
    }
    throw err;
  }
}

/**
 * Writes (or merges into) `~/.dmemo/config.json`. Existing keys not
 * mentioned in `updates` are preserved (an idempotent re-run of `dmemo setup`
 * shouldn't clobber e.g. a hand-set `DMEMO_EMBEDDER_PROVIDER`). File mode is
 * forced to 0600 on every write since it may contain a private key.
 *
 * Throws `ExistingKeyError` — writing nothing — if `updates` carries a
 * `DMEMO_PRIVATE_KEY` that differs from the one already on record and the
 * caller did not pass `allowKeyReplacement`. When a replacement IS permitted,
 * or when the existing file is unparseable, the old file is copied to a
 * timestamped 0600 backup first.
 */
export function writeDmemoConfig(
  updates: Partial<DmemoConfigFile>,
  env: NodeJS.ProcessEnv = process.env,
  options: WriteConfigOptions = {}
): WriteConfigResult {
  const home = dmemoHome(env);
  const configPath = dmemoConfigPath(env);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const { parsed, exists } = readRawConfig(configPath);
  const created = !exists;
  const existing: Record<string, unknown> = parsed ?? {};

  const currentKey = normalizeKey(existing.DMEMO_PRIVATE_KEY);
  const incomingKey = normalizeKey(updates.DMEMO_PRIVATE_KEY);
  const keyReplaced = Boolean(currentKey && incomingKey && currentKey !== incomingKey);

  if (keyReplaced && !options.allowKeyReplacement) {
    const info = inspectExistingKey(env);
    throw new ExistingKeyError(
      info ?? { configPath, address: addressForKey(currentKey), source: 'generated' },
      addressForKey(incomingKey)
    );
  }

  // Two ways this write loses data the user can't get back: swapping the key,
  // or merging on top of a file we failed to parse (whose contents we are
  // about to silently drop). Both earn a backup.
  const unreadable = exists && parsed === null;
  let backupPath: string | null = null;
  if (exists && (keyReplaced || unreadable)) {
    backupPath = backupConfig(configPath, new Date());
  }

  const merged = { ...existing, ...updates };
  writeConfigAtomic(configPath, JSON.stringify(merged, null, 2) + '\n');

  return { path: configPath, created, merged: !created, backupPath, keyReplaced };
}

export function readDmemoConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  const configPath = dmemoConfigPath(env);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}
