# 0G Storage — Pointer Strategy Follow-up (dMemo)

Scope: how a plug-and-play dMemo client resolves "what is my latest memory rootHash?" at
session start, **without** running the `zgs_kv` Rust daemon. Builds on
`research/0g-storage.md`. Repos used (scratchpad):
`0g-ts-sdk` (v1.2.9), `0g-storage-kv`, `0g-storage-ts-starter-kit`, and newly cloned
`0g-storage-contracts` (Solidity source for `Flow.sol` / `FixedPriceFlow.sol`).
Live RPC calls made against testnet (`https://evmrpc-testnet.0g.ai`, chain ID 16602) and
the turbo indexer/storage nodes — addresses and numbers below are real, not looked up from docs.

## a) High-level overview — every native pointer strategy

```mermaid
flowchart TB
  subgraph "1a. eth_getLogs (chain-native)"
    A1[Client] -->|"eth_getLogs(Flow addr,\ntopics=[Submit, sender])"| A2[Public EVM RPC]
    A2 -->|decode log.data| A3["submissionIndex (txSeq)"]
    A3 -->|"indexer.selectNodes(1) ->\nnode.getFileInfoByTxSeq(txSeq)"| A4["rootHash = fileInfo.tx.dataMerkleRoot"]
  end
  subgraph "1c. Pointer contract (new, tiny)"
    C1[Client] -->|after upload: setLatest(rootHash) tx| C2[PointerRegistry.sol]
    C1 -->|session start: latestOf(wallet) eth_call| C2
  end
  subgraph "1d. Self/3rd-party-hosted 0G-KV"
    D1[Client] -->|set key=agentId, value=rootHash| D2[Batcher.exec -> chain tx]
    D3[zgs_kv daemon] -->|replays chain log| D4[(local DB)]
    D1 -->|getValue RPC :6789| D3
  end
  subgraph "1b. Indexer / Explorer API"
    B1[Client] -.->|"no address-based query exists"| B2["indexer_getFileLocations(rootHash)\n(rootHash required as input)"]
  end
```

- **1a — direct chain query**: the `FixedPriceFlow.Submit` event is indexed by `sender`. A client
  with only an RPC URL + its own wallet address can filter logs and decode `submissionIndex` (the
  storage-layer txSeq), then resolve the true file root via a storage node
  (`indexer.selectNodes(1)` → `node.getFileInfoByTxSeq(txSeq)` → `fileInfo.tx.dataMerkleRoot`) —
  no extra infra beyond the RPC + indexer the client already talks to, no extra tx. **Corrected**
  (spike, c2-blob.mjs, live testnet run): `nodes[0].root` in the Submit event is only a subtree
  root, not the file root, whenever chunk count isn't a power of two — do not decode the root hash
  directly from the log.
- **1c — pointer contract**: one extra ~tiny tx per flush that writes `wallet → latest rootHash`
  into a purpose-built mapping contract dMemo deploys. O(1) `eth_call` read, no log-scanning ever.
- **1d — 0G-KV**: architecturally the "official" KV pointer pattern, but requires an always-on
  Rust daemon (self-hosted or trusted third party) — see `0g-storage.md` for the full cost
  breakdown; this doc adds the exact config surface.
- **1b — indexer/explorer**: confirmed **does not exist**. Both `Indexer` RPC methods and
  `docs.0g.ai` are root-hash-in, not address-in.

## b) Key decisions and reasoning

### 1a. `eth_getLogs` by signer address — verified end-to-end on live testnet

| Fact | Value | Reference |
|---|---|---|
| `Submit` event signature | `Submit(address indexed sender, bytes32 indexed identity, uint256 submissionIndex, uint256 startPos, uint256 length, (uint256 length, bytes tags, (bytes32 root, uint256 height)[] nodes) submission)` | `0g-ts-sdk/src.ts/contracts/flow/factories/FixedPriceFlow__factory.ts:317-353` (ABI), emitted at `0g-storage-contracts/contracts/dataFlow/Flow.sol:225` |
| `sender` **is indexed** (topic1) | Confirmed in ABI (`indexed: true`) and by a live filtered query | same ABI file; live test below |
| `identity` **is indexed** (topic2) but is `submission.digest()` — a content digest computed on-chain, not a client-chosen tag | `Flow.sol:217`: `digest = submission.digest();` then `emit Submit(submission.submitter, digest, ...)` | `0g-storage-contracts/contracts/dataFlow/Flow.sol:204-225` |
| ~~`submission.data.nodes[].root` is the per-node Merkle root; for files ≤ 1 segment (≤256KB, i.e. all dMemo memory snapshots) there is exactly **one** node, and its `root` equals the top-level `file.merkleTree().rootHash()`~~ — **DISPROVEN on live testnet**: a 2,169-byte blob (9 chunks of 256B) emitted **2** subtree nodes in the `Submit` event, because `splitNodes()` splits by power-of-two **chunk** counts (9 → 8+1), not by segment count. `nodes[0].root` is only a subtree root, NOT the file root, whenever chunk count is not a power of two. | Live testnet run: 9-chunk (2,169-byte) upload → `submission.nodes.length === 2`, not 1 | spike (c2-blob.mjs / c1b-fund-and-chat.mjs, live testnet run) |
| **Correct root-resolution flow** (verified working live): decode `submissionIndex` from the `Submit` event — this equals the storage-layer txSeq — then `indexer.selectNodes(1)` → `node.getFileInfoByTxSeq(txSeq)` → `fileInfo.tx.dataMerkleRoot` is the true file root, matching `file.merkleTree().rootHash()` from upload | Verified end-to-end on live testnet, SDK `@0gfoundation/0g-ts-sdk@1.2.8` | spike (c2-blob.mjs, live testnet run) |
| `getFlowRootByTxSeq(txSeq)` exists but returns the **global flow-wide root** at that txSeq (`$.rootByTxSeq[index] = $.tree.root()`), not the file's own root — useless for discovery without already knowing txSeq | `Flow.sol:222`; `FixedPriceFlow.ts:625-629` (`getFlowRootByTxSeq`) |
| **Live verification**: fetched real `Flow` contract address from a testnet storage node's `zgs_getStatus`, computed the canonical `Submit` topic0 from the extracted ABI, then ran `eth_getLogs` filtered by `[topic0, sender-topic]` against `https://evmrpc-testnet.0g.ai` | Flow addr `0x22e03a6a89b950f1c82ec5e74f8eca321a105296` (chain 16602); topic0 `0x167ce04d2aa1981994d3a31695da0d785373335b1078cec239a1a3a2c7675555`; a real decoded log returned `sender=0xC14EF0F...48C9`, `nodes=[{root:0xb65af0...228d, height:0}]`; filtering by that sender's topic returned only that sender's 10 submissions in 173ms | live RPC calls, this session |
| **Block-range cap on the public RPC**: binary-searched the max `fromBlock`→`toBlock` span accepted by `evmrpc-testnet.0g.ai` before it rejects with an opaque range error | **≈4.78M blocks ≈ 22 days** of history at the chain's 0.4s/block rate, per single `eth_getLogs` call; within that window, filtered queries return in **170–540ms** | live RPC calls, this session (binary search, not documented anywhere) |
| Setup cost | **Zero** extra infra — only an RPC URL (already required for everything else) and the wallet address | — |
| Trust | Same trust level as reading any chain state via a public RPC (light-client-verifiable in principle; practically trusting the RPC operator, same as `Indexer.upload`'s own tx submission path) | — |

**Cold-start caveat (the one real gap)**: a wallet that hasn't written in >22 days needs either
(a) a locally cached checkpoint (`lastKnownBlock`/`txSeq`) from a previous session to jump straight
to the right window — a *cache*, not a hard dependency, safe to lose — or (b) paginated backward
`eth_getLogs` calls in ≤4.78M-block windows until a `Submit` log is found (each call still free,
sub-second, no extra infra — just more round-trips for dormant wallets).

### 1b. Indexer / explorer "files by address" API — confirmed does not exist

| Surface checked | Result | Reference |
|---|---|---|
| `Indexer` class RPC methods | `indexer_getShardedNodes`, `indexer_getNodeLocations`, `indexer_getFileLocations(rootHash)` — all either global-topology or **rootHash-keyed**. No address parameter anywhere. | `0g-ts-sdk/src.ts/indexer/Indexer.ts:46-69` |
| `docs.0g.ai` Storage SDK page | Explicitly confirmed (fetched live): "does not document" any uploader-address query; all file ops are by root hash | `https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk` (fetched this session) |
| ChainScan explorer | Has a generic `open/api` surface (`chainscan-galileo.0g.ai/open/api`) for standard block-explorer queries (accounts/txs), which *could* substitute for `eth_getLogs` in a UI, but it's a third-party-style REST wrapper around the same chain data 1a already gets natively — no added capability, added dependency | web search, this session |

Conclusion: nothing here beats 1a; the indexer is a **content-addressed file locator**, not an
address-indexed catalog. Use `eth_getLogs`, not an indexer/explorer, for discovery.

### 1c. Minimal pointer contract — real ecosystem precedent found (INFT / ERC-7857)

| Question | Finding | Reference |
|---|---|---|
| Does 0G's own ecosystem use this pattern? | **Yes.** The `AgenticID` contract (0G's ERC-7857 "INFT" standard) stores exactly `tokenId → encryptedURI` (a 0G Storage pointer) and `tokenId → metadataHash` in on-chain mappings, updated via `mint(encryptedURI, metadataHash)` and re-verified on `transfer(from, to, tokenId, sealedKey, proof)`. Storage upload and the on-chain pointer write are explicitly **separate transactions** in the reference flow. | `https://docs.0g.ai/developer-hub/building-on-0g/inft/integration` (fetched live, this session) |
| What would dMemo's version cost? | One extra `nonpayable` call per flush: `setLatest(bytes32 rootHash)` on a `mapping(address => bytes32)` (or `mapping(bytes32 agentId => bytes32 rootHash)` if keying by agent rather than wallet). Cost = one plain `SSTORE`-class tx (no storage-fee/sector pricing — that only applies to `Flow.submit`), i.e. materially cheaper than the memory-write tx itself. Read is one `eth_call`, O(1), no range caps, works for dormant wallets. | Derived from ERC-7857 pattern + standard EVM `SSTORE` cost model |
| Can it be folded into the same tx as the upload? | No — `Indexer.upload()` calls `FixedPriceFlow.submit()` directly; that contract is immutable/fixed and not extensible by dMemo, so any pointer write is necessarily a second transaction from the same signer (can be fired back-to-back, doesn't need to be awaited before the next agent turn). | `0g-ts-sdk/src.ts/transfer/Uploader.ts:110-117` (`submitLogEntryNoReceipt`) |

### 1d. 0G-KV, self- or dMemo-operated — operational specifics (expands `0g-storage.md`)

| Requirement | Detail | Reference |
|---|---|---|
| Hardware | 4 GB RAM, 2 CPU cores minimum, disk sized to the streams watched | `0g-storage-kv/README.md:5-11` |
| Config surface | `stream_ids` — a **static, pre-declared list** of 32-byte stream IDs to watch (no dynamic "watch all streams for address X" mode); `blockchain_rpc_endpoint` + `log_contract_address` (the Flow contract) for chain sync; `indexer_url` or static `zgs_node_urls` for segment fetch; RPC served on `0.0.0.0:6789` | `0g-storage-kv/README.md:15-79` (`config_example.toml`) |
| `KvClient` API surface | `getValue/get/getNext/getPrev/getFirst/getLast(streamId, key, ...)`, `getHoldingStreamIds()`, `isWriterOfStream`/`isAdmin` — **no address-based discovery method**; you must already know the `streamId` | `0g-ts-sdk/src.ts/kv/client.ts:18-212` |
| Is it a fit as a "pragmatic centralized default"? | Yes, functionally — dMemo could run one `zgs_kv` instance, pre-register one stream per tenant/agent, and treat it as a managed pointer service. Since payloads are client-side-encrypted before upload (per `0g-storage.md`), running this centrally is non-custodial (dMemo never sees plaintext) but **is** a trust/availability dependency the client didn't have with 1a/1c — an off-chain single point of failure sitting in front of an otherwise trustless chain read. | Same as `0g-storage.md` §KV findings |

### 1e. Other native mechanisms considered and ruled out

| Mechanism | Why it doesn't help for discovery |
|---|---|
| `tags` field on `SubmissionData` | Client-settable arbitrary bytes (default `'0x'`), but **not indexed** in the event — can't be used as an `eth_getLogs` topic filter, only inspected after decoding a log you already have. Useful as an app-level namespace tag *after* filtering by sender, not as a discovery key itself. | `0g-ts-sdk/src.ts/transfer/types.ts:16,38`; ABI shows `tags` as non-indexed |
| `HotRouterClient` (`/prefetch`, `/file/status`) | Read-side cache warmer for already-known root hashes; has no address/discovery surface | `0g-ts-sdk/src.ts/hot/HotRouterClient.ts` (per `0g-storage.md`) |
| `getFlowRootByTxSeq` | Requires the txSeq already known; returns the flow-wide root, not the file's | see 1a table above |

## c) `with_proof` default — verified in source, and a correctness gap found

| Question | Finding | Reference |
|---|---|---|
| Default when omitted | **`false`** — every download entry point defaults `proof`/`withProof` to `false` if the caller doesn't pass it. | `Indexer.download(rootHash, filePath, proof = false)` at `0g-ts-sdk/src.ts/indexer/Indexer.ts:297-301`; `Indexer.downloadToBlob(...)` at `Indexer.ts:443-446` (`opts.proof ?? false`); `Downloader.download(..., proof = false)` at `0g-ts-sdk/src.ts/transfer/Downloader.ts:88-92`; `Downloader.downloadToBlob(..., proof = false)` at `Downloader.ts:296-299` |
| How to force it on | Pass the third positional arg `true` to `indexer.download(rootHash, path, true)`, or `opts.proof = true` to `indexer.downloadToBlob(rootHash, { proof: true })` | same files |
| **Does `proof: true` actually verify anything?** | **No — not in this SDK version.** The `proof` flag is threaded through the entire call chain (`download → downloadFile → downloadFileHelper → downloadTask`) but at the one place verification would happen, the parameter is renamed `_proof` (unused) with an explicit `// TODO: add proof check` comment. No Merkle proof is fetched or checked regardless of what the caller passes. | `0g-ts-sdk/src.ts/transfer/Downloader.ts:458-465` (`downloadTask(..., _proof: boolean)`, comment at line 458) |
| Cross-check against docs | `docs.0g.ai`'s TS SDK page documents `withProof = true` as "enables Merkle proof verification" — i.e. **the documentation describes the intended behavior, which the current published `@0gfoundation/0g-ts-sdk@1.2.9` code does not implement.** | `https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk` (fetched live, this session) vs. code above |

**Implication for dMemo**: content-addressing (rootHash = hash of ciphertext) already gives
tamper-evidence for free at the application layer — if a client fetches by rootHash and re-derives
the same hash from the bytes it received, that alone catches corruption/tampering without needing
the SDK's proof path at all. Given the proof path is currently non-functional, dMemo **must not**
rely on `proof: true` for integrity and should instead re-verify the downloaded ciphertext's hash
client-side (or wait for an upstream fix) if proof-of-inclusion matters.

## d) Real on-chain cost — live `eth_call`, testnet Galileo

| Item | Live value | How obtained |
|---|---|---|
| `FixedPriceFlow` address (testnet, turbo) | `0x22e03a6a89b950f1c82ec5e74f8eca321a105296` | `zgs_getStatus` RPC to a turbo-indexer-listed storage node (`networkIdentity.flowAddress`) |
| `Market` (`FixedPrice`) address | `0x26c8f001C94b0fd287DB5397F05EF8Bd8EF2cF4B` | live `eth_call flow.market()` |
| `pricePerSector()` | **30,733,644,962 wei** ≈ 3.0734e-8 0G | live `eth_call market.pricePerSector()`, `https://evmrpc-testnet.0g.ai` |
| Sector size | 1 sector = `DEFAULT_CHUNK_SIZE` = 256 bytes | `0g-ts-sdk/src.ts/constant.ts:3`; `sectors += 1 << node.height` in `calculatePrice`, `0g-ts-sdk/src.ts/transfer/utils.ts:20-30` |
| Current gas price | 4,000,000,007 wei ≈ 4 Gwei | live `provider.getFeeData()` |

Storage-fee-only cost for small dMemo memory writes (chunks round up to next power of 2, per
`calculatePrice`/`splitNodes`):

| Payload size | Padded sectors | Storage fee (0G) |
|---|---|---|
| 4 KB | 16 | 0.00000049 |
| 16 KB | 64 | 0.00000197 |
| 64 KB | 256 | 0.00000787 |
| 256 KB (segment ceiling) | 1024 | 0.00003147 |

**Caveat**: this is the `pricePerSector` **storage fee** only (paid as `msg.value` into the
Reward contract via `FixedPrice.chargeFee`, `0g-storage-contracts/contracts/market/FixedPrice.sol:35-50`).
The **gas fee** for the `submit()` transaction itself (base 21000 + calldata + Merkle-node storage
writes) was not empirically measured in this pass (would require a funded signer executing a real
state-changing tx, out of scope for a read-only research pass) — but at ~4 Gwei, even a modest
150–300k gas submit tx costs **0.0006–0.0012 0G**, i.e. roughly **20–2500x the storage fee** for
these small payloads. For dMemo's cost model: **gas dominates, not `pricePerSector`** — consistent
with `0g-storage.md`'s prior finding that per-write cost is "one blockchain tx," not a cheap DB
update.

## Ranked recommendation for dMemo

| Rank | Strategy | Why |
|---|---|---|
| **1** | **Hybrid: local checkpoint cache + `eth_getLogs` by `sender`, with an optional pointer contract as an O(1) fallback for cold/dormant wallets** | Zero new infra beyond the RPC URL every dMemo client already needs. Verified live: sub-second, correctly filters to just the caller's submissions, decodes `submissionIndex` (txSeq) from the log and resolves the true file root via `indexer.selectNodes(1)` → `node.getFileInfoByTxSeq(txSeq)` → `fileInfo.tx.dataMerkleRoot` (spike, c2-blob.mjs, live testnet run) — **not** `nodes[0].root`, which is only a subtree root when chunk count isn't a power of two. The only real gap — the ~22-day/4.78M-block `eth_getLogs` window on the public RPC — is fully closed by caching `{lastBlock, txSeq, rootHash}` client-side after every successful write (a soft cache, safe to lose, not a plug-and-play violation) or, for cross-device/cold-start cases, by strategy 1c. |
| **2** | **Minimal pointer contract (`mapping(address\|bytes32 agentId => bytes32 rootHash)`)** | Real 0G ecosystem precedent (INFT/ERC-7857 `AgenticID`). Removes the range-cap/cold-start edge case entirely — O(1) read regardless of dormancy. Costs one extra small tx per flush, materially cheaper than the memory-write tx itself (plain `SSTORE`, no per-sector storage fee). Recommended as dMemo's own tiny contract, deployed once, not a 0G-provided service — keeps the "no daemon" property while removing 1a's only weakness. Best paired with #1, not instead of it. |
| **3** | **0G-KV, dMemo-operated (centralized-but-non-custodial)** | Functionally adequate and matches the "official" KV abstraction, but requires dMemo to run and keep alive a stateful Rust daemon with a static per-tenant `stream_ids` allowlist — a real operational burden and a new availability dependency neither #1 nor #2 has. Reasonable as an optional convenience layer (e.g. for teams that already want a KV-shaped read API) but not the default/primary mechanism. |
| **4** | **Indexer/explorer "by address" API** | Ruled out — confirmed not to exist anywhere in the SDK or `docs.0g.ai`. |

**Bottom line**: dMemo does not need 0G-KV, an indexer feature, or any off-chain service to answer
"what's my latest rootHash." The `FixedPriceFlow.Submit` event's indexed `sender` field, combined
with `eth_getLogs` against the same public RPC dMemo already depends on, is sufficient and was
verified live end-to-end this session. Add a two-line pointer contract only to eliminate the
cold-start log-scanning edge case — it costs less than the memory write it's tracking.

---

## Decisions (settled)

| # | Decision | Detail |
|---|---|---|
| D8 | Pointer resolution: `eth_getLogs` by sender + local cache | Live-verified 173ms discovery. Root resolved via `submissionIndex` (txSeq) → `getFileInfoByTxSeq` → `tx.dataMerkleRoot` — **not** `nodes[0].root`, disproven live (spike, c2-blob.mjs). Optional tiny pointer contract (ERC-7857 precedent) for O(1) cold start later |
| D9 | Encryption: ECIES to wallet pubkey; **self-verify merkle root on download** | ts-sdk `with_proof` is a no-op (verified) — dMemo re-verifies content hash itself |
