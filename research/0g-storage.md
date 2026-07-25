# 0G Storage — Research for dMemo Memory Backend

Scope: primitives (log vs KV), encryption, TypeScript SDK surface, minimal setup.
Repos cloned to `/private/tmp/claude-501/-Users-tomasdomingos-dMemo/15587102-be28-4ef7-8ec7-35a0239acba5/scratchpad/repos/`:
`0g-ts-sdk` (`@0gfoundation/0g-storage-ts-sdk`, npm pkg `@0gfoundation/0g-ts-sdk`), `0g-storage-kv`, `0g-storage-ts-starter-kit`.

## a) High-level overview

```mermaid
flowchart LR
  subgraph Write path (log layer, used by both file upload and KV)
    A[Client: ZgFile / MemData] -->|merkleTree + encrypt| B[Indexer.upload]
    B -->|selects nodes| C[Storage Nodes]
    B -->|flow.submit tx, pays pricePerSector| D[(0G Chain: Flow contract)]
  end
  subgraph Read path
    D -.->|log entries| E[KV Node\n(self-hosted or 3rd-party,\nreplays log into local DB)]
    C -->|segments + Merkle proof| F[Indexer.download / downloadToBlob]
    E -->|RPC getValue/getNext| G[KvClient]
  end
```

- **Log layer**: append-only file storage. `ZgFile`/`MemData` → Merkle tree → erasure-coded segments → `Indexer.upload()` submits one on-chain tx to the `FixedPriceFlow` contract and pushes segments to storage nodes. Root hash = content-addressed ID. Immutable once written.
- **KV layer**: not a separate storage engine — it's files-with-tags on the log layer. A `Batcher` packs KV `set()` operations into a `StreamData` blob, which is itself submitted as one on-chain log-layer tx (same `flow.submit` path, same per-sector pricing). A **KV Node** (separate Rust service, `zgs_kv`) watches the chain, downloads those tagged log entries, and replays them into a local mutable DB that serves `getValue`/`getNext`/`getPrev` over its own RPC (default port 6789). Reads never touch the chain directly — they hit the KV Node's local reconstruction.
- **Encryption**: client-side, in the TS SDK itself (`src.ts/common/encryption.ts`, `EncryptedFile`), not a network/protocol feature. AES-256-CTR (symmetric) or ECIES (secp256k1 ECDH → HKDF → AES-256-CTR, encrypt-to-pubkey). Ciphertext + a small header is what actually gets uploaded — "the 0G network never sees plaintext" (0g-storage-ts-starter-kit/README.md:155).
- **Hot router** (`src.ts/hot/HotRouterClient.ts`): an optional read-side prefetch/cache layer (`/prefetch`, `/file/status`) fronting the log layer to reduce download latency. No equivalent exists for writes.

## b) Key decisions and reasoning

| Question | Finding | Reference |
|---|---|---|
| Log vs KV for a small, frequently-mutated memory DB | KV is the intended primitive, but it is a **replay-based log abstraction**, not a real KV store: every `set()` still costs one full on-chain log-layer transaction (same fee/latency profile as a file upload), and reads depend on a **separate, self-run (or trusted third-party) KV Node process** rebuilding local state from the chain log. | `0g-storage-kv/README.md:1-79`; `0g-ts-sdk/src.ts/kv/batcher.ts:29-50` (Batcher.exec → Uploader.uploadFile, i.e. same tx path as file upload) |
| Does 0G-KV support fetch→update natively? | Semantically yes (`getValue` then `set`+`exec` to write a new value under the same key; the KV Node reconciles history via `version`), matching the "fetch state, mutate, write back" pattern dMemo wants. But it is **not free/instant**: writes are blockchain txs (block-time confirmation, gas + storage fee), and reads require an indexing service that isn't part of core 0G infra — the only endpoint the SDK README shows is a third-party test IP (`http://3.101.147.150:6789`), not an official 0G-hosted endpoint. No public/managed KV Node was found for testnet or mainnet in docs.0g.ai or the repos. | `0g-ts-sdk/README.md:99-107`; `0g-ts-sdk/src.ts/kv/client.ts:18-56` (chunked reassembly via `getValue`); web search — no official hosted KV Node found |
| Is encryption native or client-side? | Client-side, built into the TS SDK (not a 0G-network feature). Two SDK-native modes, wire-compatible with the Go SDK: `aes256` (32-byte key, 17-byte header `[v=0x01][nonce:16]`) and `ecies` (recipient secp256k1 pubkey, 50-byte header `[v=0x02][ephemeralPub:33][nonce:16]`). AES-256-**CTR**, no AEAD/authentication tag — code explicitly notes CTR has no integrity check and defends only against mis-decrypting non-encrypted files, not tampering. | `0g-ts-sdk/src.ts/common/encryption.ts:1-21,94-138`; `0g-ts-sdk/src.ts/indexer/decryption.ts:36-46` (comment on AES-CTR lacking authentication); `0g-storage-ts-starter-kit/README.md:153-165` |
| Recommended practice | Use `UploadOption.encryption` (`{type:'aes256', key}` or `{type:'ecies', recipientPubKey}`) at upload; `indexer.downloadToBlob({decryption})` at download — `indexer.download()` (disk-writing path) has **no decryption hook**. `peekHeader()` lets you detect the mode before fetching the body. This is a native SDK feature, not custom logic dMemo needs to build — for dMemo we'd only need to decide the AES key (likely per-agent/per-tenant, derived or stored outside 0G) and call these functions directly. | `0g-storage-ts-starter-kit/README.md:239-291` (direct-SDK code sample, incl. the "no decryption" gotcha) |
| TS SDK upload/download surface | `Indexer.upload(file, rpcUrl, signer, opts?) -> [{txHash,rootHash,txSeq} \| {txHashes[],rootHashes[]}, Error\|null]`; `Indexer.download(rootHash, outPath, withProof) -> Error\|null` (Node fs-based, no decrypt); `Indexer.downloadToBlob(rootHash\|rootHash[], opts) -> [Blob, Error\|null]` (supports decrypt, works in browser). `MemData` lets you upload strings/buffers without touching disk — closest fit for a memory blob. | `0g-ts-sdk/src.ts/indexer/Indexer.ts:104-140`; `0g-storage-ts-starter-kit/README.md:411-429` |
| KV surface | `KvClient.getValue/get/getNext/getPrev/getFirst/getLast(streamId, key, ...)`; writes go through `Batcher.streamDataBuilder.set(streamId, key, value)` then `batcher.exec()` (still a chain tx). No direct "update single key with one RPC call" — every mutation is a log append + KV-node replay. | `0g-ts-sdk/src.ts/kv/client.ts:1-219`; `0g-ts-sdk/src.ts/kv/batcher.ts:1-51` |
| Size limits | Per-write batch: `MAX_SET_SIZE = 65536` reads+writes; per-key: `MAX_KEY_SIZE = 1<<24` (16.7MB, generous ceiling not a real target); per-RPC read chunk: `MAX_QUERY_SIZE = 256KB` (larger values are paged via repeated `getValue` calls). Underlying chunk/segment size: `DEFAULT_CHUNK_SIZE=256B`, `DEFAULT_SEGMENT_SIZE=256KB` (256B × 1024 chunks); `SMALL_FILE_SIZE_THRESHOLD=256KB` triggers a different upload path for small files. | `0g-ts-sdk/src.ts/kv/constants.ts:1-5`; `0g-ts-sdk/src.ts/constant.ts:1-12` |
| Latency / cost for small, frequent writes | Every write (file upload *or* KV `set`) = **one on-chain transaction** to the `FixedPriceFlow` contract, priced per storage "sector" (`pricePerSector × sectors`, sectors = padded power-of-2 chunk count — i.e. tiny writes still get rounded up and billed/padded). This means: gas cost per write, block-confirmation latency per write (not "millisecond" as marketing/architecture pages loosely imply — that latency claim applies to *reads* off an already-synced KV Node, not to write-then-read consistency), and no batching discount unless you deliberately group multiple KV keys into a single `Batcher.exec()` call before submitting. For a "fetch→mutate→write-back" loop on every LLM completion, this is closer to "one blockchain tx per memory mutation" than a cheap DB update. | `0g-ts-sdk/src.ts/transfer/utils.ts:20-30` (`calculatePrice`); `0g-ts-sdk/src.ts/contracts/market/FixedPrice.ts:39-43,316,332` (`pricePerSector`/`setPricePerSector`); docs.0g.ai concepts page (KV = "fast key-based retrieval", no numeric SLA found) |
| Read-path caching | `HotRouterClient` (`/prefetch`, `/file/status`, `waitForCached`) is a read-side cache-warming helper sitting in front of the log layer — reduces *download* latency for hot root hashes, orthogonal to KV and to write cost. | `0g-ts-sdk/src.ts/hot/HotRouterClient.ts:50-134` |

### Minimal environment setup

| Item | Testnet (Galileo) | Mainnet (Aristotle) |
|---|---|---|
| Chain ID | 16602 | 16661 |
| EVM RPC | `https://evmrpc-testnet.0g.ai` | `https://evmrpc.0g.ai` (3rd-party RPC recommended for prod) |
| Indexer (turbo) | `https://indexer-storage-testnet-turbo.0g.ai` | `https://indexer-storage-turbo.0g.ai` |
| Indexer (standard) | `https://indexer-storage-testnet-standard.0g.ai` (under maintenance) | `https://indexer-storage.0g.ai` (under maintenance) |
| Explorer | `https://chainscan-galileo.0g.ai` | `https://chainscan.0g.ai` |
| Faucet | `https://faucet.0g.ai`, Google Cloud faucet — 0.1 0G/day | n/a |
| KV Node | **None official** — must self-host `zgs_kv` (Rust, `cargo build --release`) or point at a third-party instance | same |

Source: `0g-storage-ts-starter-kit/src/config.ts:39-64`, `README.md:362-405`; `0g-storage-kv/README.md:5-79`.

**Scriptability**: Log-layer upload/download is near-zero-setup — install SDK + ethers, set `PRIVATE_KEY`/`NETWORK`/`STORAGE_MODE` in `.env`, fund via faucet, call `indexer.upload`/`download`. The `0g-storage-ts-starter-kit` is a ready-made wrapper (`uploadFile`, `downloadFile`, `uploadData`, `peekHeader`, `generateAes256Key`, `pubKeyFromPrivateKey`) dMemo could vendor directly instead of writing our own upload/download/encrypt glue. **KV is not near-zero-setup**: it requires running (or trusting) an always-on indexing service with its own DB, separate from the SDK/indexer/RPC triad — this is a real plug-and-play cost for dMemo's target agents (personal/coding agents shouldn't need to operate a Rust daemon).

## Implication for dMemo

- Treat 0G Storage as an **encrypted, content-addressed log of memory snapshots**, not a mutable database: write full/delta memory blobs via `MemData` + `indexer.upload()` with `EncryptionOption`, track the latest `rootHash` per agent/tenant in whatever lightweight index dMemo already needs (e.g., 0G-KV *if* we accept operating a KV Node, or a non-0G pointer store), rather than relying on 0G-KV as the source of truth for "current state." This avoids depending on an unofficial/self-hosted KV Node for the read-hot path.
- If 0G-KV is used anyway (e.g., because some component of dMemo wants a KV-shaped abstraction), budget for: (1) hosting `zgs_kv` ourselves as part of dMemo's infra, (2) one on-chain tx per memory mutation (cost + block-time latency), not a cheap in-memory update.
- Encryption is a straight lift from the SDK (`EncryptedFile`/`UploadOption.encryption`/`DownloadOption.decryption`) — no custom crypto needed, but note AES-CTR has no authentication tag, so if tamper-evidence matters for memory integrity, that needs to be layered on top (e.g., sign the plaintext or root hash) rather than assumed from the encryption itself.

## Open questions (not resolved by docs/code)

1. No numeric SLA found for KV Node replay lag (chain-confirmation → KV Node "sees" the update) — docs only assert "millisecond-level" reads off an already-synced node, not end-to-end write visibility latency.
2. No official/managed KV Node endpoint for testnet or mainnet was found anywhere in docs.0g.ai or the 0glabs/0gfoundation repos — only a third-party example IP in the SDK README. Unclear if 0G Labs intends to operate one, or if every KV consumer is expected to self-host.
3. Actual `pricePerSector` value (USD/0G cost per write) was not found on-chain or in docs during this pass — would need a direct RPC call to the deployed `FixedPrice` contract (`pricePerSector()`) on testnet/mainnet to get real numbers for cost modeling.

---

## Decisions (settled)

Open question 3 above (pricePerSector) was resolved by live RPC in `followup-pointer-strategy.md`.

| # | Decision | Detail |
|---|---|---|
| D2 | Storage: 0G log layer, encrypted blobs | 0G is its own EVM L1 (testnet Galileo 16602 / mainnet Aristotle 16661). ~0.001 0G per flush, gas-dominated, size-independent ≤256KB |
| D3 | Persistence: **delta log + checkpoint** | Flush = encrypted delta per completion; consolidated checkpoint every K flushes **or** size threshold, whichever first. K tuned by Phase-0 benchmark. Cold start = 1 checkpoint + <K deltas (~1–5s, constant) |
| D4 | Flush cadence: **per completion, not per session** | Turn/completion = unit of durability. "Session end" = unreliable housekeeping only (final flush, RAM wipe). Crash loses ≤1 turn. Checkpoint counter is flush-based → works for always-on agents |
| D14 | **Testnet (Galileo) first** | Chain 16602, `evmrpc-testnet.0g.ai`, faucet. Mainnet (Aristotle 16661) = env-var switch, full endpoint parity |
