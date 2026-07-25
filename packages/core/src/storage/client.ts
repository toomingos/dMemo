import { ethers } from 'ethers';
import { Indexer, MemData, FixedPriceFlow__factory, tryDecrypt } from '@0gfoundation/0g-ts-sdk';
import { BLOCK_RANGE_CAP, type NetworkConfig } from './network.js';
import {
  defaultPointerCachePath,
  getPointerCacheEntry,
  savePointerCacheEntry,
  type PointerCacheEntry,
} from './pointerCache.js';

export interface StorageClientOptions {
  network: NetworkConfig;
  /** Hex-encoded private key (with or without 0x prefix). Doubles as the
   * ECIES memory key (D2) — zero extra secrets. */
  privateKey: string;
  pointerCachePath?: string;
  /** App-level upload timeout (gotcha 15: the SDK's `waitForLogEntry()` is
   * an unbounded retry loop with no timeout — this wraps it). */
  uploadTimeoutMs?: number;
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

const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

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
  private readonly flowIface: ethers.Interface;
  private readonly submitTopic: string;
  private readonly senderTopic: string;

  constructor(opts: StorageClientOptions) {
    this.network = opts.network;
    this.provider = new ethers.JsonRpcProvider(opts.network.rpcUrl);
    this.wallet = new ethers.Wallet(opts.privateKey, this.provider);
    this.indexer = new Indexer(opts.network.indexerUrl);
    this.pointerCachePath = opts.pointerCachePath ?? defaultPointerCachePath();
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
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
    const signerArg = this.wallet as unknown as Parameters<typeof this.indexer.upload>[2];
    const uploadPromise = this.indexer.upload(file, this.network.rpcUrl, signerArg, {
      encryption: { type: 'ecies', recipientPubKey },
    });
    const [result, err] = await withTimeout(
      uploadPromise,
      this.uploadTimeoutMs,
      () => new UploadTimeoutError(this.uploadTimeoutMs)
    );
    if (err) throw new Error(`0G upload error: ${err.message ?? String(err)}`);
    if (!result || !('rootHash' in result)) throw new Error('0G upload returned no result');
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

    return { txHash: result.txHash, rootHash: result.rootHash, txSeq: result.txSeq, uploadMs, costWei };
  }

  // -------------------------------------------------------------------
  // Download + mandatory Merkle self-verify + decrypt (gotcha 1)
  // -------------------------------------------------------------------
  async downloadAndVerify(rootHash: string): Promise<{ plaintext: Buffer; downloadMs: number; verifyMs: number; decryptMs: number }> {
    const tDl = performance.now();
    const [rawBlob, dlErr] = await this.indexer.downloadToBlob(rootHash, { proof: false });
    if (dlErr) throw new Error(`0G download error: ${dlErr.message ?? String(dlErr)}`);
    const ciphertext = Buffer.from(await rawBlob.arrayBuffer());
    const downloadMs = performance.now() - tDl;

    const tVerify = performance.now();
    const file = new MemData(ciphertext);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) throw new Error(`merkleTree() error: ${treeErr.message ?? String(treeErr)}`);
    const recomputedRoot = tree!.rootHash();
    const verifyMs = performance.now() - tVerify;
    if (recomputedRoot === null) {
      throw new MerkleVerifyError(rootHash, '(null — merkleTree().rootHash() returned no root)');
    }
    if (recomputedRoot.toLowerCase() !== rootHash.toLowerCase()) {
      throw new MerkleVerifyError(rootHash, recomputedRoot);
    }

    const tDecrypt = performance.now();
    const { bytes, decrypted } = tryDecrypt(ciphertext, { privateKey: this.wallet.privateKey });
    if (!decrypted) {
      throw new Error('decrypt failed: blob is not ECIES-encrypted to this wallet, or key mismatch');
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
   * Resolve the latest rootHash written by this wallet. Returns null for a
   * genuinely fresh wallet (no Submit logs ever, anywhere) — callers treat
   * that as "start a fresh store". Cache is consulted first (soft
   * optimization); on cache miss, paginates backwards in
   * `BLOCK_RANGE_CAP`-block windows to cover dormant wallets.
   */
  async resolveLatest(): Promise<ResolvedPointer | null> {
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
      return null; // fresh wallet, no prior writes anywhere
    }

    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    const latestLog = logs[logs.length - 1]!;
    const decoded = this.flowIface.parseLog(latestLog);
    if (!decoded) throw new Error('failed to decode Submit log');
    const txSeq = Number(decoded.args.submissionIndex);

    const [selectedNodes, selectErr] = await this.indexer.selectNodes(1);
    if (selectErr) throw new Error(`selectNodes error: ${selectErr.message ?? String(selectErr)}`);
    const node = selectedNodes[0];
    if (!node) throw new Error('selectNodes returned no nodes');
    const fileInfo = await node.getFileInfoByTxSeq(txSeq);
    if (!fileInfo) throw new Error(`storage node has no file info for txSeq ${txSeq}`);
    const rootHash = fileInfo.tx.dataMerkleRoot;

    const elapsedMs = performance.now() - t0;

    const entry: PointerCacheEntry = {
      network: this.network.network,
      wallet: this.wallet.address,
      lastBlock: latestLog.blockNumber,
      txSeq,
      rootHash,
    };
    savePointerCacheEntry(this.pointerCachePath, entry);

    return { rootHash, txSeq, blockNumber: latestLog.blockNumber, elapsedMs };
  }
}
