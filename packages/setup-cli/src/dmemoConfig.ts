// T4.1 step 3: write `~/.dmemo/config.json`. File name/shape/location must
// match exactly what `@dmemo/node-adapter`'s `src/lib/settings.ts`
// (`loadDmemoEnv`) and every other host adapter already expect: a flat JSON
// object whose keys are the exact env var names `@dmemo/core`'s
// `loadConfigFromEnv` reads (`DMEMO_PRIVATE_KEY`, `DMEMO_NETWORK`, ...) at
// `${DMEMO_HOME:-~/.dmemo}/config.json`, file mode 0600 (contains a private
// key).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export interface WriteConfigResult {
  path: string;
  created: boolean;
  merged: boolean;
}

/**
 * Writes (or merges into) `~/.dmemo/config.json`. Existing keys not
 * mentioned in `updates` are preserved (idempotent re-run of `dmemo setup`
 * shouldn't clobber e.g. a hand-set `DMEMO_EMBEDDER_PROVIDER`). File mode is
 * forced to 0600 on every write since it may contain a private key.
 */
export function writeDmemoConfig(
  updates: Partial<DmemoConfigFile>,
  env: NodeJS.ProcessEnv = process.env
): WriteConfigResult {
  const home = dmemoHome(env);
  const configPath = dmemoConfigPath(env);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  let existing: Record<string, unknown> = {};
  let created = true;
  if (fs.existsSync(configPath)) {
    created = false;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') existing = parsed;
    } catch {
      // Corrupt existing file — overwrite rather than crash the wizard.
      existing = {};
    }
  }

  const merged = { ...existing, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  // Force the mode even if the file already existed with looser perms
  // (fs.writeFileSync only applies `mode` when *creating* the file).
  fs.chmodSync(configPath, 0o600);

  return { path: configPath, created, merged: !created };
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
