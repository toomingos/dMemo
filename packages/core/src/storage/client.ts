import { ethers } from 'ethers';
import { Indexer, MemData, FixedPriceFlow__factory, tryDecrypt } from '@0gfoundation/0g-ts-sdk';
import { BLOCK_RANGE_CAP, type NetworkConfig } from './network.js';
import {
  clearUploadMarker,
  defaultPointerCachePath,
  getAbandonedUpload,
  getPointerCacheEntry,
  markUploadAbandoned,
  recordUploadStarted,
  savePointerCacheEntry,
  type PointerCacheEntry,
} from './pointerCache.js';
import { wrapIndexerQuiet } from './quietIndexer.js';

export interface StorageClientOptions {
  network: NetworkConfig;
  /** Hex-encoded private key (with or without 0x prefix). Doubles as the
   * ECIES memory key (D2) — zero extra secrets. */
  privateKey: string;
  pointerCachePath?: string;
  /** App-level upload timeout (gotcha 15: the SDK's `waitForLogEntry()` is
   * an unbounded retry loop with no timeout — this wraps it). */
  uploadTimeoutMs?: number;
  /** App-level per-attempt download timeout (F6: a hung indexer or node
   * must not hang restore forever, and must surface as a
   * classifiably-transient failure rather than an indefinite stall — the
   * download-side analog of gotcha 15's upload timeout). */
  downloadTimeoutMs?: number;
  /** Test-only seam: inject a stand-in for the SDK's `Indexer` (e.g. a stub
   * whose `upload`/`downloadToBlob` resolve without touching the network,
   * for stdout-purity and other unit tests). Production callers must never
   * set this — omitting it (the default) constructs the real `Indexer`
   * exactly as before. */
  indexer?: Indexer;
  /** Test-only seam, same rationale as `indexer` — inject a stand-in for
   * the `ethers.JsonRpcProvider` used for cost accounting and pointer
   * resolution. Omitting it (the default) constructs the real provider. */
  provider?: ethers.JsonRpcProvider;
}

export interface UploadResult {
  txHash: string;
  rootHash: string;
  txSeq: number;
  uploadMs: number;
  costWei: bigint;
}

export interface ResolvedPointer {
  rootHash: string;
  txSeq: number;
  blockNumber: number;
  elapsedMs: number;
  /**
   * This pointer is newer than the last upload we confirmed, and this client
   * has a local record of abandoning an upload in that same block range — so
   * if it will not download, the overwhelmingly likely reason is that WE
   * submitted it and never finished pushing its segments, not that a real
   * blob is briefly unreachable. Restore uses this to walk back past its own
   * wreckage instead of refusing forever (see `resolveRestoreChain`).
   */
  orphanSuspect?: boolean;
}

export class UploadTimeoutError extends Error {
  constructor(ms: number) {
    super(`0G upload did not confirm within ${ms}ms (app-level timeout — see gotcha 15)`);
    this.name = 'UploadTimeoutError';
  }
}

export class MerkleVerifyError extends Error {
  constructor(expected: string, actual: string) {
    super(`Merkle self-verify FAILED: recomputed root ${actual} != expected on-chain root ${expected}`);
    this.name = 'MerkleVerifyError';
  }
}

export class DownloadTimeoutError extends Error {
  constructor(ms: number) {
    super(`0G download did not complete within ${ms}ms (app-level timeout)`);
    this.name = 'DownloadTimeoutError';
  }
}

/**
 * F6: a blob that could not be confirmed as durably-and-correctly present on
 * 0G Storage *right now*, after `DOWNLOAD_ATTEMPTS` tries. This is
 * deliberately NOT the same signal as `BlobCorruptError` — everything this
 * class covers (transport exceptions, indexer/node timeouts, the SDK's own
 * "not finalized" / "no storage node holds segment" / "failed to query
 * file" reports, and even a Merkle mismatch — `downloadToBlob`'s node
 * selection is randomized per call, gotcha 20a's "not merely propagation
 * lag" note applies here too) can *also* be explained by a transient
 * condition that a later attempt would clear. Callers must treat this as
 * "unavailable for now" (walk back to the previous blob), never as proof of
 * permanent data loss.
 */
export class BlobUnretrievableError extends Error {
  /** `'unretrievable'` when the SDK/Merkle layer positively reported the
   * data as absent/mismatched; `'transient'` for a raw transport failure or
   * timeout where we never even got a verdict. Both are walked back the
   * same way — this only affects the telemetry message. */
  readonly reason: 'transient' | 'unretrievable';
  constructor(rootHash: string, reason: 'transient' | 'unretrievable', causeMessage: string) {
    super(`blob ${rootHash} not retrievable after ${DOWNLOAD_ATTEMPTS} attempt(s) (${reason}): ${causeMessage}`);
    this.name = 'BlobUnretrievableError';
    this.reason = reason;
  }
}

/**
 * F6: a blob whose ciphertext bytes are cryptographically CONFIRMED (Merkle
 * root matches the on-chain value) to be exactly what is durably stored on
 * 0G, yet cannot be decrypted. Gotcha 6: the ECIES payload rides on
 * unauthenticated AES-CTR, so this codebase has no auth-tag signal the way
 * an AEAD cipher would — Merkle-verified-but-undecryptable is as close as
 * it gets to a definitive corruption signal, and unlike `BlobUnretrievableError`
 * it is NOT retried: the bytes are already confirmed identical to what was
 * uploaded, so a retry would deterministically reproduce the same failure.
 */
export class BlobCorruptError extends Error {
  constructor(rootHash: string, detail: string) {
    super(`blob ${rootHash} is corrupt: ${detail}`);
    this.name = 'BlobCorruptError';
  }
}

const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
/** Added to the upload budget per KB of payload. Live testnet checkpoints of
 * ~500 KB overran the flat 120 s ceiling; the segment push is roughly linear
 * in size, so the budget has to be too. */
const UPLOAD_TIMEOUT_MS_PER_KB = 600;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 45_000;
const DEFAULT_POINTER_CANDIDATES = 8;
/** Attempts per blob before a download/verify failure is treated as (even
 * transiently) unretrievable. Matches `runFlush()`'s existing "retry once"
 * convention (session.ts) rather than introducing a new backoff scheme. */
const DOWNLOAD_ATTEMPTS = 2;

/**
 * Recompute the on-chain dataMerkleRoot from a Submit event's submission
 * nodes (left-aligned subtree roots): right-fold keccak256, i.e.
 * root = nodes[n-1].root, then for i = n-2..0: root = keccak(nodes[i].root ‖ root).
 * Verified live against zgs_getFileInfo(...).tx.dataMerkleRoot (gotcha 20).
 * Deriving the root from the log itself removes the storage-node round-trip
 * (selectNodes + getFileInfoByTxSeq) from the restore critical path.
 */
function submissionRootFromNodes(nodes: readonly { root: string }[]): string {
  if (nodes.length === 0) throw new Error('Submit event submission has no merkle nodes');
  let root = nodes[nodes.length - 1]!.root;
  for (let i = nodes.length - 2; i >= 0; i--) {
    root = ethers.keccak256(ethers.concat([nodes[i]!.root, root]));
  }
  return root;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Thin client over `@0gfoundation/0g-ts-sdk` implementing exactly the
 * upload/download/pointer-resolution patterns proven live in
 * `spike/c2-blob.mjs` and `spike/c3-mem0-loop.mjs`, plus:
 *  - native ECIES-to-wallet-pubkey encryption instead of the spike's
 *    process-local AES-256-CTR key (T1.2 asks for the SDK-native option now
 *    that it's confirmed to exist: `UploadOption.encryption =
 *    { type: 'ecies', recipientPubKey }` / `tryDecrypt(bytes, { privateKey })`).
 *  - a local pointer cache (soft optimization, never load-bearing).
 *  - an app-level upload timeout (gotcha 15).
 *
 * IMPORTANT (gotcha 1, hard requirement): Merkle self-verification always
 * happens on the *raw ciphertext* bytes as downloaded — never on the
 * convenience `downloadToBlob(..., { decryption })` path, which would return
 * already-decrypted bytes and make the on-chain rootHash impossible to
 * recompute. `downloadAndVerify()` downloads raw, verifies, THEN decrypts
 * via the SDK's own `tryDecrypt` primitive (the same function
 * `downloadToBlob`'s convenience path calls internally).
 */
export class StorageClient {
  readonly network: NetworkConfig;
  readonly wallet: ethers.Wallet;
  readonly provider: ethers.JsonRpcProvider;
  readonly indexer: Indexer;
  private readonly pointerCachePath: string;
  private readonly uploadTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly flowIface: ethers.Interface;
  private readonly submitTopic: string;
  private readonly senderTopic: string;

  constructor(opts: StorageClientOptions) {
    this.network = opts.network;
    this.provider = opts.provider ?? new ethers.JsonRpcProvider(opts.network.rpcUrl);
    this.wallet = new ethers.Wallet(opts.privateKey, this.provider);
    // wrapIndexerQuiet: hand out the Indexer PRE-WRAPPED (structural fix —
    // see quietIndexer.ts) so every method call reachable through
    // `this.indexer`, present today or added later, is automatically routed
    // through the quiet-stdout patch. No call site below (or added in the
    // future) needs to remember to wrap itself.
    this.indexer = wrapIndexerQuiet(opts.indexer ?? new Indexer(opts.network.indexerUrl));
    this.pointerCachePath = opts.pointerCachePath ?? defaultPointerCachePath();
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.flowIface = new ethers.Interface(FixedPriceFlow__factory.abi);
    this.submitTopic = this.flowIface.getEvent('Submit')!.topicHash;
    this.senderTopic = ethers.zeroPadValue(this.wallet.address, 32);
  }

  get address(): string {
    return this.wallet.address;
  }

  async getBalanceWei(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  // -------------------------------------------------------------------
  // Upload (encrypt via native ECIES-to-own-pubkey, then indexer.upload)
  // -------------------------------------------------------------------
  async upload(plaintext: Uint8Array): Promise<UploadResult> {
    const file = new MemData(plaintext);
    const recipientPubKey = this.wallet.signingKey.publicKey; // 0x04... uncompressed hex
    const t0 = performance.now();

    // Cast needed: @0gfoundation/0g-ts-sdk's .d.ts pins ethers' `Signer` type
    // via an explicit `resolution-mode: "import"` reference, which under
    // pnpm + NodeNext resolves to a structurally-identical but nominally
    // distinct duplicate of the `ethers` types this file resolves — a known
    // dual-package-hazard TS quirk, not a real type mismatch (same `ethers`
    // version, same `Wallet` class, at runtime there is exactly one). Deriving
    // the cast target from the call site itself (rather than naming
    // `ethers.Signer` directly) sidesteps the duplicate-identity problem.
    // Mark the upload in flight BEFORE it can mine a Submit tx. From here on,
    // any pointer this wallet gains above the last confirmed one may be our
    // own — and if we never clear this marker, restore needs to know that.
    // Written first precisely so a hard crash (not just a timeout) still
    // leaves the evidence behind. See `AbandonedUploadEntry`.
    const fromBlock = await this.provider.getBlockNumber().catch(() => 0);
    recordUploadStarted(this.pointerCachePath, {
      network: this.network.network,
      wallet: this.wallet.address,
      fromBlock,
      startedAt: Date.now(),
      bytes: plaintext.byteLength,
    });

    const signerArg = this.wallet as unknown as Parameters<typeof this.indexer.upload>[2];
    // No withQuietSdkStdout here: `this.indexer` is already pre-wrapped
    // (see the constructor / quietIndexer.ts) — the SDK's own progress
    // lines from inside upload() never reach real stdout, with no
    // per-call-site wrapping to remember.
    const uploadPromise = this.indexer.upload(file, this.network.rpcUrl, signerArg, {
      encryption: { type: 'ecies', recipientPubKey },
    });
    // Scale the budget with payload size: a checkpoint is orders of magnitude
    // larger than a delta, and a flat ceiling that comfortably fits a 3 KB
    // delta will strand a 500 KB checkpoint mid-upload — which, per above,
    // costs a real transaction fee and poisons the chain head.
    const timeoutMs = this.uploadTimeoutMs + Math.ceil(plaintext.byteLength / 1024) * UPLOAD_TIMEOUT_MS_PER_KB;

    // Every exit from here that is not a confirmed upload has to promote the
    // in-flight marker to an abandonment — the timeout rejects out of the
    // await, so the failure paths cannot be left to fall through.
    let result: Awaited<typeof uploadPromise>[0];
    try {
      const [r, err] = await withTimeout(uploadPromise, timeoutMs, () => new UploadTimeoutError(timeoutMs));
      if (err) throw new Error(`0G upload error: ${err.message ?? String(err)}`);
      if (!r || !('rootHash' in r)) throw new Error('0G upload returned no result');
      result = r;
    } catch (e) {
      markUploadAbandoned(this.pointerCachePath, this.network.network, this.wallet.address, (e as Error).message);
      throw e;
    }
    const uploadMs = performance.now() - t0;

    let costWei = 0n;
    try {
      const receipt = await this.provider.getTransactionReceipt(result.txHash);
      const tx = await this.provider.getTransaction(result.txHash);
      const effectiveGasPrice = receipt?.gasPrice ?? tx?.gasPrice ?? 0n;
      const gasUsed = receipt?.gasUsed ?? 0n;
      const storageFeeWei = tx?.value ?? 0n;
      costWei = gasUsed * effectiveGasPrice + storageFeeWei;
    } catch (e) {
      console.warn(`[dmemo] could not compute upload cost breakdown (non-fatal): ${(e as Error).message}`);
    }

    const latestBlock = await this.provider.getBlockNumber();
    savePointerCacheEntry(this.pointerCachePath, {
      network: this.network.network,
      wallet: this.wallet.address,
      lastBlock: latestBlock,
      txSeq: result.txSeq,
      rootHash: result.rootHash,
    });
    // Confirmed: this pointer is real and we are about to chain onto it, so
    // nothing above the cached pointer is our wreckage any more.
    clearUploadMarker(this.pointerCachePath, this.network.network, this.wallet.address);

    return { txHash: result.txHash, rootHash: result.rootHash, txSeq: result.txSeq, uploadMs, costWei };
  }

  // -------------------------------------------------------------------
  // Download + mandatory Merkle self-verify + decrypt (gotcha 1)
  // -------------------------------------------------------------------
  /**
   * Download `rootHash`, self-verify it against the Merkle root, and
   * decrypt — or throw one of two classifiably-distinct errors (F6):
   *
   *  - `BlobUnretrievableError`: nothing conclusive about this blob's
   *    *content* could be established after `DOWNLOAD_ATTEMPTS` tries — a
   *    transport failure, an app-level timeout, an SDK-reported
   *    not-finalized/no-covering-set condition, or a Merkle mismatch (which
   *    `downloadToBlob`'s randomized node selection can also produce from a
   *    single bad node). None of these prove the data is gone — only that
   *    it isn't obtainable *right now* — so this is never corruption.
   *  - `BlobCorruptError`: the Merkle root matched (these ARE the exact
   *    on-chain bytes) but they don't decrypt. Deterministic, so not
   *    retried — see the class doc for why this is dMemo's closest
   *    equivalent to an AEAD auth-tag failure despite AES-CTR having none
   *    (gotcha 6).
   */
  async downloadAndVerify(rootHash: string): Promise<{ plaintext: Buffer; downloadMs: number; verifyMs: number; decryptMs: number }> {
    let downloadMs = 0;
    let verifyMs = 0;
    let ciphertext: Buffer | null = null;
    let lastErr: Error = new Error('unreachable');
    let lastReason: 'transient' | 'unretrievable' = 'transient';

    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const tDl = performance.now();
        // No withQuietSdkStdout here either: downloadToBlob() is exactly
        // the call site that emitted the live-observed noise ("Getting
        // file locations for root hash...", "Found N locations for...",
        // "Selected N of M nodes for...", indexer/Indexer.js:296/298/313),
        // but `this.indexer` being pre-wrapped already keeps it off real
        // stdout — see quietIndexer.ts.
        const [rawBlob, dlErr] = await withTimeout(
          this.indexer.downloadToBlob(rootHash, { proof: false }),
          this.downloadTimeoutMs,
          () => new DownloadTimeoutError(this.downloadTimeoutMs)
        );
        if (dlErr) throw new Error(`0G download error: ${dlErr.message ?? String(dlErr)}`);
        const bytes = Buffer.from(await rawBlob.arrayBuffer());
        downloadMs = performance.now() - tDl;

        const tVerify = performance.now();
        const file = new MemData(bytes);
        const [tree, treeErr] = await file.merkleTree();
        if (treeErr) throw new Error(`merkleTree() error: ${treeErr.message ?? String(treeErr)}`);
        const recomputedRoot = tree!.rootHash();
        verifyMs = performance.now() - tVerify;
        if (recomputedRoot === null) {
          throw new MerkleVerifyError(rootHash, '(null — merkleTree().rootHash() returned no root)');
        }
        if (recomputedRoot.toLowerCase() !== rootHash.toLowerCase()) {
          throw new MerkleVerifyError(rootHash, recomputedRoot);
        }

        ciphertext = bytes;
        break;
      } catch (e) {
        lastErr = e as Error;
        // A positive verdict from the Merkle/SDK layer (mismatch) is
        // reported distinctly from "we never got far enough to ask"
        // (transport exception/timeout) — both are still retried the same
        // way; this only changes the final classification if every attempt
        // fails the same way.
        lastReason = e instanceof MerkleVerifyError ? 'unretrievable' : 'transient';
      }
    }
    if (ciphertext === null) {
      throw new BlobUnretrievableError(rootHash, lastReason, lastErr.message);
    }

    const tDecrypt = performance.now();
    const { bytes, decrypted } = tryDecrypt(ciphertext, { privateKey: this.wallet.privateKey });
    if (!decrypted) {
      throw new BlobCorruptError(
        rootHash,
        'decrypt failed: blob is not ECIES-encrypted to this wallet, or key mismatch'
      );
    }
    const decryptMs = performance.now() - tDecrypt;

    return { plaintext: Buffer.from(bytes), downloadMs, verifyMs, decryptMs };
  }

  // -------------------------------------------------------------------
  // Pointer resolution (eth_getLogs -> txSeq -> dataMerkleRoot), gotcha 2/8
  // -------------------------------------------------------------------
  private async getLogsPaginated(fromBlock: number, toBlock: number): Promise<ethers.Log[]> {
    let lo = fromBlock;
    const hi = toBlock;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await this.provider.getLogs({
          address: this.network.flowAddress,
          topics: [this.submitTopic, this.senderTopic],
          fromBlock: lo,
          toBlock: hi,
        });
      } catch (e) {
        const span = hi - lo;
        const nextLo = hi - Math.floor(span / 2);
        if (nextLo <= lo) throw e;
        lo = nextLo;
      }
    }
    throw new Error('exhausted eth_getLogs range retries');
  }

  /**
   * Resolve the newest pointer candidates written by this wallet, newest
   * first. Returns [] for a genuinely fresh wallet (no Submit logs ever,
   * anywhere) — callers treat that as "start a fresh store". Cache is
   * consulted first (soft optimization); on cache miss, paginates backwards
   * in `BLOCK_RANGE_CAP`-block windows to cover dormant wallets.
   *
   * Returns *candidates* rather than a single pointer because a Submit log
   * lands on-chain when the upload transaction is mined — BEFORE segment
   * data is durable on the storage nodes. A crashed or failed upload
   * therefore leaves a dangling pointer that shadows the last good blob
   * (gotcha 20); restore must be able to walk back. rootHash is computed
   * locally from the event's submission nodes — no storage-node RPC.
   */
  async resolveCandidates(maxCandidates = DEFAULT_POINTER_CANDIDATES): Promise<ResolvedPointer[]> {
    const t0 = performance.now();
    const cached = getPointerCacheEntry(this.pointerCachePath, this.network.network, this.wallet.address);

    const latestBlock = await this.provider.getBlockNumber();
    let toBlock = latestBlock;
    let fromBlock = cached ? cached.lastBlock : Math.max(0, latestBlock - BLOCK_RANGE_CAP);

    let logs: ethers.Log[] = [];
    // Widen the search window backwards from the cache point (or from the
    // most recent BLOCK_RANGE_CAP window) until we find at least one log or
    // exhaust the chain back to genesis — covers dormant wallets whose last
    // write predates the first window.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      logs = await this.getLogsPaginated(fromBlock, toBlock);
      if (logs.length > 0) break;
      if (fromBlock <= 0) break;
      toBlock = fromBlock - 1;
      fromBlock = Math.max(0, toBlock - BLOCK_RANGE_CAP);
      if (toBlock <= 0) break;
    }

    if (logs.length === 0) {
      return []; // fresh wallet, no prior writes anywhere
    }

    logs.sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index); // newest first
    const elapsedMs = performance.now() - t0;
    // A pointer is our own suspected wreckage only if we hold a local record
    // of an upload we started and never confirmed, and the pointer sits at or
    // after the block that upload began in. Both conditions are first-person
    // facts about this client — a wallet with no abandonment marker gets the
    // old, maximally conservative behaviour.
    const abandoned = getAbandonedUpload(this.pointerCachePath, this.network.network, this.wallet.address);
    const orphanFromBlock = abandoned ? abandoned.fromBlock : Number.POSITIVE_INFINITY;
    const candidates: ResolvedPointer[] = [];
    for (const log of logs.slice(0, maxCandidates)) {
      const decoded = this.flowIface.parseLog(log);
      if (!decoded) continue;
      const txSeq = Number(decoded.args.submissionIndex);
      const nodes = decoded.args.submission.nodes as readonly { root: string }[];
      candidates.push({
        rootHash: submissionRootFromNodes(nodes),
        txSeq,
        blockNumber: log.blockNumber,
        elapsedMs,
        orphanSuspect: log.blockNumber >= orphanFromBlock,
      });
    }
    if (candidates.length === 0) throw new Error('failed to decode any Submit log');
    return candidates;
  }

  /** Persist a known-good pointer to the local cache (soft optimization). */
  savePointer(p: Pick<ResolvedPointer, 'rootHash' | 'txSeq' | 'blockNumber'>): void {
    const entry: PointerCacheEntry = {
      network: this.network.network,
      wallet: this.wallet.address,
      lastBlock: p.blockNumber,
      txSeq: p.txSeq,
      rootHash: p.rootHash,
    };
    savePointerCacheEntry(this.pointerCachePath, entry);
  }
}
