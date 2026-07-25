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

/**
 * A record that THIS client submitted an upload it never saw confirm.
 *
 * `indexer.upload()` mines the Submit transaction *before* pushing segment
 * data, so an upload abandoned after that point (app-level timeout, crash,
 * network drop) leaves a paid-for, permanently empty pointer at the head of
 * the wallet's Submit log. Restore's refuse-don't-degrade rule cannot tell
 * that apart from someone else's blob being briefly unreachable, so without
 * this marker the wallet wedges: every later session refuses to open, forever.
 *
 * The marker is what makes the difference knowable — it is strictly local,
 * first-person knowledge ("I started an upload here and never confirmed it"),
 * never a guess about a blob some other machine wrote. Losing the file only
 * costs us the hint and restores today's conservative behaviour.
 */
export interface AbandonedUploadEntry {
  network: string;
  wallet: string;
  /** Block height when the upload started — every dangling pointer is at or after it. */
  fromBlock: number;
  startedAt: number;
  bytes: number;
  /** Absent while the upload is still in flight. */
  abandonedAt?: number;
  detail?: string;
}

type PointerCacheFile = Record<string, PointerCacheEntry | AbandonedUploadEntry>;

function cacheKey(network: string, wallet: string): string {
  return `${network}:${wallet.toLowerCase()}`;
}

// Namespaced so the file stays one flat map and older readers, which only ever
// look up `${network}:${wallet}`, ignore these keys instead of tripping on them.
function abandonedKey(network: string, wallet: string): string {
  return `abandoned-upload:${network}:${wallet.toLowerCase()}`;
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
    return file[cacheKey(network, wallet)] as PointerCacheEntry | undefined;
  } catch {
    return undefined;
  }
}

function writeCacheKey(cachePath: string, key: string, value: PointerCacheEntry | AbandonedUploadEntry | null): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const file = readCacheFile(cachePath);
    if (value === null) delete file[key];
    else file[key] = value;
    fs.writeFileSync(cachePath, JSON.stringify(file, null, 2), 'utf8');
  } catch (e) {
    // Cache is a soft optimization — never let a write failure break the
    // caller (e.g. read-only filesystem, disk full).
    console.warn(`[dmemo] pointer cache write failed (non-fatal): ${(e as Error).message}`);
  }
}

/** Note an upload as in flight from `fromBlock`, before its tx can be mined. */
export function recordUploadStarted(cachePath: string, entry: Omit<AbandonedUploadEntry, 'abandonedAt' | 'detail'>): void {
  writeCacheKey(cachePath, abandonedKey(entry.network, entry.wallet), entry);
}

/** The upload confirmed: its pointer is real, so drop the in-flight marker. */
export function clearUploadMarker(cachePath: string, network: string, wallet: string): void {
  writeCacheKey(cachePath, abandonedKey(network, wallet), null);
}

/** The upload never confirmed: promote the in-flight marker to an abandonment. */
export function markUploadAbandoned(cachePath: string, network: string, wallet: string, detail: string): void {
  const existing = getAbandonedUpload(cachePath, network, wallet);
  if (!existing) return; // nothing was in flight — nothing to blame on us
  writeCacheKey(cachePath, abandonedKey(network, wallet), { ...existing, abandonedAt: Date.now(), detail });
}

export function getAbandonedUpload(
  cachePath: string,
  network: string,
  wallet: string
): AbandonedUploadEntry | undefined {
  try {
    const entry = readCacheFile(cachePath)[abandonedKey(network, wallet)] as AbandonedUploadEntry | undefined;
    return entry && typeof entry.fromBlock === 'number' ? entry : undefined;
  } catch {
    return undefined;
  }
}

export function savePointerCacheEntry(cachePath: string, entry: PointerCacheEntry): void {
  writeCacheKey(cachePath, cacheKey(entry.network, entry.wallet), entry);
}
