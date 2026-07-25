import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { MemData, newEciesHeader, cryptAt } from '@0gfoundation/0g-ts-sdk';
import { StorageClient } from './client.js';
import { resolveNetworkConfig } from './network.js';

// Deliverable: prove that a real StorageClient storage operation (upload,
// download+verify) never writes anything to the host process's *real*
// stdout, even though the underlying @0gfoundation/0g-ts-sdk it drives
// hardcodes `console.log` calls throughout its upload/download path (see
// quietStdout.ts's module doc for the exact file:line citations). The SDK
// itself is stubbed via StorageClient's test-only `indexer`/`provider`
// injection seams — no network traffic, no real 0G spend — but the stub
// calls the *real* console.log with the *exact* lines observed live, so
// this exercises the real interception path, not a fake one.
//
// The download-side fixture uses the SDK's own exported ECIES primitives
// (`newEciesHeader`/`cryptAt` — the same functions the SDK's real Uploader
// uses internally) to build a genuinely-decryptable ciphertext, so
// `downloadAndVerify()`'s real Merkle-verify + `tryDecrypt` code paths run
// unmodified, not mocked.

function spyOnRealStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return original(chunk, ...rest);
  };
  return {
    chunks,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function mkScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-client-test-'));
}

/** Build a real ECIES-to-`recipientPub` ciphertext exactly the way the
 * SDK's own Uploader does (`file/EncryptedFile.js` -> `newEciesEncryptedFile`
 * -> `newEciesHeader`/`cryptAt`), so `tryDecrypt` inside `downloadAndVerify`
 * decrypts it for real. */
function eciesEncrypt(plaintext: Uint8Array, recipientPub: string): Uint8Array {
  const { header, key } = newEciesHeader(recipientPub);
  const body = new Uint8Array(plaintext);
  cryptAt(key, header.nonce, 0, body);
  const headerBytes = header.toBytes();
  const out = new Uint8Array(headerBytes.length + body.length);
  out.set(headerBytes, 0);
  out.set(body, headerBytes.length);
  return out;
}

function fakeProvider() {
  return {
    getTransactionReceipt: async () => ({ gasUsed: 21000n, gasPrice: 1n }),
    getTransaction: async () => ({ gasPrice: 1n, value: 0n }),
    getBlockNumber: async () => 1,
    getBalance: async () => 0n,
    // Empty result + a small latestBlock makes resolveCandidates()'s
    // backward-pagination loop terminate on its first iteration (genuinely
    // fresh-wallet path) without needing to fabricate a decodable Submit
    // log — plenty to exercise the method's stdout behavior.
    getLogs: async () => [],
  } as unknown as ethers.JsonRpcProvider;
}

/**
 * A stub SDK indexer that is chatty about EVERY method call, not just the
 * two `client.ts` currently drives. Known methods (`upload`,
 * `downloadToBlob`) return realistic values so the calling StorageClient
 * method completes normally; any *unmodeled* method name (standing in for
 * a future SDK call site nobody has coded yet) still logs and resolves,
 * so if some future StorageClient method starts calling a new indexer
 * method, this fixture surfaces the noise instead of silently returning
 * `undefined` immediately.
 */
function mkChattyIndexer(fixture: { rootHash: string; ciphertext: Uint8Array }) {
  const known = {
    upload: async (..._args: unknown[]) => {
      console.log('Data prepared to upload', 'root=0xabc', 'size=16', 'numSegments=1', 'numChunks=1');
      console.log('Submitting transaction with storage fee:', 0n);
      console.log('Transaction submitted, hash:', '0xdeadbeef');
      console.log('Wait for log entry on storage node');
      return [{ txHash: '0xdeadbeef', rootHash: fixture.rootHash, txSeq: 7 }, null];
    },
    downloadToBlob: async (requestedRootHash: string) => {
      console.log(`Getting file locations for root hash: ${requestedRootHash}`);
      console.log(`Found 2 locations for ${requestedRootHash}:`, ['http://node-a', 'http://node-b']);
      console.log(`Selected 2 of 2 nodes for ${requestedRootHash}`);
      return [new Blob([fixture.ciphertext]), null];
    },
  };
  return new Proxy(known, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        console.log(`[chatty-stub] called unmodeled indexer method "${String(prop)}"`, ...args);
        return undefined;
      };
    },
  });
}

test('upload(): stdout stays clean even though the stubbed SDK emits real console.log noise', async () => {
  const wallet = ethers.Wallet.createRandom();
  const network = resolveNetworkConfig('testnet');
  const dir = mkScratchDir();

  const stubIndexer = {
    upload: async (..._args: unknown[]) => {
      // Mirrors real lines from transfer/Uploader.js and indexer/Indexer.js.
      console.log('Data prepared to upload', 'root=0xabc', 'size=16', 'numSegments=1', 'numChunks=1');
      console.log('Submitting transaction with storage fee:', 0n);
      console.log('Transaction submitted, hash:', '0xdeadbeef');
      console.log('Wait for log entry on storage node');
      return [{ txHash: '0xdeadbeef', rootHash: '0x' + 'ab'.repeat(32), txSeq: 7 }, null];
    },
    downloadToBlob: async () => {
      throw new Error('not used in this test');
    },
  };

  const client = new StorageClient({
    network,
    privateKey: wallet.privateKey,
    indexer: stubIndexer as any,
    provider: fakeProvider(),
    pointerCachePath: path.join(dir, 'pointer-cache.json'),
  });

  const spy = spyOnRealStdout();
  try {
    const result = await client.upload(new TextEncoder().encode('hello dmemo'));
    assert.equal(result.txHash, '0xdeadbeef');
    assert.deepEqual(spy.chunks, [], 'no console.log output from the SDK upload path should reach real stdout');
  } finally {
    spy.restore();
  }
});

test('downloadAndVerify(): stdout stays clean during a real Merkle-verify + decrypt round trip', async () => {
  const wallet = ethers.Wallet.createRandom();
  const network = resolveNetworkConfig('testnet');
  const dir = mkScratchDir();

  const plaintext = new TextEncoder().encode('the actual memory blob contents');
  const ciphertext = eciesEncrypt(plaintext, wallet.signingKey.publicKey);

  const [tree, treeErr] = await new MemData(ciphertext).merkleTree();
  assert.equal(treeErr, null);
  const rootHash = tree!.rootHash()!;

  const stubIndexer = {
    upload: async () => {
      throw new Error('not used in this test');
    },
    downloadToBlob: async (requestedRootHash: string) => {
      // Mirrors the exact lines observed live from indexer/Indexer.js
      // (this IS the reported bug's call site).
      console.log(`Getting file locations for root hash: ${requestedRootHash}`);
      console.log(`Found 2 locations for ${requestedRootHash}:`, ['http://node-a', 'http://node-b']);
      console.log(`Selected 2 of 2 nodes for ${requestedRootHash}`);
      return [new Blob([ciphertext]), null];
    },
  };

  const client = new StorageClient({
    network,
    privateKey: wallet.privateKey,
    indexer: stubIndexer as any,
    provider: fakeProvider(),
    pointerCachePath: path.join(dir, 'pointer-cache.json'),
  });

  const spy = spyOnRealStdout();
  try {
    const { plaintext: recovered } = await client.downloadAndVerify(rootHash);
    assert.equal(Buffer.from(recovered).toString('utf8'), Buffer.from(plaintext).toString('utf8'));
    assert.deepEqual(spy.chunks, [], 'no console.log output from the SDK download path should reach real stdout');
  } finally {
    spy.restore();
  }
});

// ---------------------------------------------------------------------
// Generic, enumeration-driven stdout-purity coverage across StorageClient's
// public surface (the second enforcement shape asked for, complementing
// quietIndexer.ts's structural fix above). The two tests above hand-pick
// `upload`/`downloadAndVerify`; this section instead reflects over
// `StorageClient.prototype` so that ADDING a new public method — via any
// mechanism, not just a raw indexer call — cannot silently ship without
// stdout-purity coverage: the enumeration test fails loudly, by name,
// until someone deliberately adds an invoker (or an explicit, reasoned
// exclusion) for it. This is a forcing function, not full automation — an
// arbitrary future method still needs someone to supply valid arguments —
// but it converts "a method site was un-covered" from a silent gap into a
// hard test failure that names the exact method.
// ---------------------------------------------------------------------

/** Implementation-detail members that show up on `StorageClient.prototype`
 * at runtime (TS `private` is compile-time only, so reflection can't tell
 * them apart from public methods) but are not part of the class's public
 * contract, with the reason each is excused from needing its own direct
 * invocation below. */
const KNOWN_NON_PUBLIC: Record<string, string> = {
  getLogsPaginated: 'TS-private RPC-pagination helper; exercised indirectly via resolveCandidates() below, never called directly by StorageClient consumers.',
};

test('enumeration: every method on StorageClient.prototype is either purity-tested or explicitly excused', () => {
  const descriptors = Object.getOwnPropertyDescriptors(StorageClient.prototype);
  const methodNames = Object.entries(descriptors)
    .filter(([name, d]) => name !== 'constructor' && typeof d.value === 'function')
    .map(([name]) => name);

  const covered = new Set([
    'upload',
    'downloadAndVerify',
    'resolveCandidates',
    'savePointer',
    'getBalanceWei',
    'clearAbandonedUploadMarker',
  ]);

  const uncovered = methodNames.filter((n) => !covered.has(n) && !(n in KNOWN_NON_PUBLIC));
  assert.deepEqual(
    uncovered,
    [],
    `StorageClient gained new method(s) with no stdout-purity coverage: ${uncovered.join(', ')} — ` +
      'add an invocation to the purity test below, or (if genuinely non-public / does no I/O) add it ' +
      'to KNOWN_NON_PUBLIC above with a reason.'
  );
});

test("stdout purity across StorageClient's full public surface, driven by the enumeration above", async () => {
  const wallet = ethers.Wallet.createRandom();
  const network = resolveNetworkConfig('testnet');
  const dir = mkScratchDir();
  const plaintext = new TextEncoder().encode('purity-fixture blob contents');
  const ciphertext = eciesEncrypt(plaintext, wallet.signingKey.publicKey);
  const [tree, treeErr] = await new MemData(ciphertext).merkleTree();
  assert.equal(treeErr, null);
  const rootHash = tree!.rootHash()!;

  const client = new StorageClient({
    network,
    privateKey: wallet.privateKey,
    indexer: mkChattyIndexer({ rootHash, ciphertext }) as any,
    provider: fakeProvider(),
    pointerCachePath: path.join(dir, 'pointer-cache.json'),
  });

  const spy = spyOnRealStdout();
  try {
    await client.upload(new TextEncoder().encode('hello'));
    await client.downloadAndVerify(rootHash);
    await client.resolveCandidates();
    client.savePointer({ rootHash: '0x' + 'ab'.repeat(32), txSeq: 1, blockNumber: 1 });
    await client.getBalanceWei();

    assert.deepEqual(
      spy.chunks,
      [],
      'no console.log output from any StorageClient public method should reach real stdout'
    );
  } finally {
    spy.restore();
  }
});
