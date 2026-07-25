import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Local pointer cache (~/.dmemo/pointer-cache.json). Pure soft optimization —
// losing it must never lose data (T1.2): resolveLatest() falls back to a
// full eth_getLogs scan when the cache is missing, corrupt, or stale.

export interface PointerCacheEntry {
  network: string;
  wallet: string;
  lastBlock: number;
  txSeq: number;
  rootHash: string;
}

type PointerCacheFile = Record<string, PointerCacheEntry>;

function cacheKey(network: string, wallet: string): string {
  return `${network}:${wallet.toLowerCase()}`;
}

export function defaultPointerCachePath(): string {
  return path.join(os.homedir(), '.dmemo', 'pointer-cache.json');
}

function readCacheFile(cachePath: string): PointerCacheFile {
  try {
    const text = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as PointerCacheFile;
    return {};
  } catch {
    // Missing file, bad permissions, corrupt JSON — all treated as "no cache".
    return {};
  }
}

export function getPointerCacheEntry(
  cachePath: string,
  network: string,
  wallet: string
): PointerCacheEntry | undefined {
  try {
    const file = readCacheFile(cachePath);
    return file[cacheKey(network, wallet)];
  } catch {
    return undefined;
  }
}

export function savePointerCacheEntry(cachePath: string, entry: PointerCacheEntry): void {
  try {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true });
    const file = readCacheFile(cachePath);
    file[cacheKey(entry.network, entry.wallet)] = entry;
    fs.writeFileSync(cachePath, JSON.stringify(file, null, 2), 'utf8');
  } catch (e) {
    // Cache is a soft optimization — never let a write failure break the
    // caller (e.g. read-only filesystem, disk full).
    console.warn(`[dmemo] pointer cache write failed (non-fatal): ${(e as Error).message}`);
  }
}
