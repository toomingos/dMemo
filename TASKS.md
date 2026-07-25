# dMemo — Implementation Task Spec (agent handoff)

Derived from `research/SYNTHESIS.md` + all per-topic reports. All 18 design decisions (D1–D18)
are settled — **do not re-litigate them**; each task cites the decisions it implements.
v1.0 scope (D15): Claude Code, OpenCode, OpenClaw (memory + inference) + Codex (memory-only).
Hermes/Python = v1.1. Network: testnet Galileo first (D14), one-env-var mainnet switch.

## Ground rules for every implementing agent

1. **Native functions only** — use SDK/library-native features; no custom crypto, no custom
   routing/failover, no monkey-patching SDK internals. If a task seems to need custom logic,
   re-read the cited research doc; the native path is documented there.
2. **Don't assume — verify.** Cited `file:line` references are from cloned repos read during
   research (July 2026). Re-check against the version you install; if it moved, find the
   equivalent and note it.
3. TypeScript, Node ≥ 18 (OpenClaw requires Node ≥ 22 at its host level — our packages must not
   require higher than 18 themselves). pnpm workspaces monorepo.
4. Read the cited research file **before** starting a task. `research/SYNTHESIS.md` is the map.

## Global constants (live-verified in spike, July 2026)

| Constant | Value |
|---|---|
| Testnet chain (Galileo) | id `16602`, RPC `https://evmrpc-testnet.0g.ai` |
| Mainnet chain (Aristotle) | id `16661`, RPC `https://evmrpc.0g.ai` |
| Storage indexer (testnet, turbo) | `https://indexer-storage-testnet-turbo.0g.ai` |
| Storage indexer (mainnet, turbo) | `https://indexer-storage-turbo.0g.ai` |
| `FixedPriceFlow` contract (testnet) | `0x22e03a6a89b950f1c82ec5e74f8eca321a105296` (not exported by the SDK — hardcode per network) |
| `eth_getLogs` range cap (public testnet RPC) | ~4.78M blocks (~22 days @0.4s/block) — use 4,700,000, halve-and-retry on error (pattern: `spike/c2-blob.mjs:179-198`) |
| Compute Router (mainnet) | `https://router-api.0g.ai/v1` |
| Compute Router (testnet) | `https://router-api-testnet.integratenetwork.work/v1` |
| Testnet chat model (the ONLY one) | ⚠️ catalog drifted (live check 2026-07-25, Phase 2): now `qwen2.5-omni` (**TeeTLS**, not TeeML) + `qwen-image-edit` (TeeML, image). The spec-era `qwen/qwen2.5-omni-7b (TeeML)` id no longer exists. Claude models are **mainnet-only**. Re-check `GET /v1/models` live before any task that hardcodes a model id (esp. T5.2 judge); note TeeML-pinned *chat* is currently impossible on testnet — TeeTLS is acceptable for benchmark judging (public data), never as the private-inference default |
| Faucet | `https://faucet.0g.ai` (0.1 0G/day) |
| Measured flush cost | ≈0.00125 0G total (gas-dominated; storage fee negligible ≤256KB) |
| npm deps | `@0gfoundation/0g-ts-sdk@^1.2.8`, `mem0ai@^3.1.1`, `ethers@^6`, `fastembed`, `better-sqlite3`, `pg` |

## Known gotchas (violating any of these = bug)

1. **`with_proof`/`proof` in `0g-ts-sdk` is a NO-OP** (`Downloader.ts` `downloadTask(..., _proof)`,
   `// TODO: add proof check`). Never rely on it. Always self-verify: `new MemData(bytes)` →
   `merkleTree()` → `rootHash()` must equal the expected root (D9; `followup-pointer-strategy.md` §c).
2. **Never read the file root from the `Submit` event's `nodes[0].root`** — it's a subtree root
   whenever chunk count isn't a power of two (disproven live). Decode `submissionIndex` (= txSeq)
   from the event, then `indexer.selectNodes(1)` → `node.getFileInfoByTxSeq(txSeq)` →
   `fileInfo.tx.dataMerkleRoot` (D8; `spike/c2-blob.mjs:200-215` is the working reference).
3. **`import('mem0ai/oss')` crashes unless `better-sqlite3` AND `pg` are installed** — the
   published ESM bundle eagerly imports every backend. Declare both as hard dependencies of
   `@dmemo/core` (`mem0.md` §4). On **Bun** hosts, installing `better-sqlite3` is not enough —
   it aborts the process outright; see gotcha 22.
4. **0G Router has NO `/embeddings` endpoint** (verified against its OpenAPI). Embeddings are
   always local (D6).
5. **0G Router has NO `/v1/responses`** → Codex inference through 0G is out of scope; Codex is
   memory-only (D10). Do not build a chat→responses shim.
6. **AES-256-CTR has no auth tag** — integrity comes from the Merkle self-verify (gotcha 1),
   never from decryption succeeding.
7. **`indexer.download()` (disk path) has no decryption hook.** Phase 1 went further: the
   convenience decrypting path (`downloadToBlob(..., {decryption})`) discards the raw ciphertext
   internally, which makes the mandatory Merkle self-verify (gotcha 1) impossible. The proven
   pattern (`core/src/storage/client.ts`): download raw ciphertext → self-verify the exact
   on-chain bytes → then decrypt via the SDK's separate `tryDecrypt()` primitive.
8. Direct (non-Router) provider endpooints are flaky (observed 15-min full testnet outage) —
   Router-only in the request path; don't build failover (Router does it).
9. Codex `SessionEnd` hook is hard-capped at 3s — write-back goes in `Stop`, never `SessionEnd`.
10. Hooks in Claude Code/Codex run as **fresh subprocesses per invocation** — no resident state;
    every hook call must open/close the store (fine for the SQLite-file store; this is why D7
    picked it).
11. *(Phase 0 finding)* `mem0ai@3.1.1` `VectorStoreFactory` has **no custom-provider registration
    path** — inject the journaling wrapper by post-init property swap
    (`memory.vectorStore = new JournalingVectorStore(...)`); verified working in `spike/c3-mem0-loop.mjs`.
12. *(Phase 0 finding)* After any fastembed use, `process.exit()` SIGABRTs (onnxruntime native
    teardown) — set `process.exitCode` and return instead.
13. *(Phase 0 finding)* `MEM0_TELEMETRY` env must be set **before a dynamic `import('mem0ai/oss')`**
    — static imports hoist above the assignment and telemetry fires anyway.
14. *(Phase 0 finding)* Never serialize embedding vectors as JSON float arrays — a delta blob grew
    to 530KB (bigger than its checkpoint). Binary-pack as base64-encoded `Float32Array` bytes
    (matches the native store's on-disk format); packed deltas measured 135KB/34KB.
15. *(Phase 0 finding)* 0G SDK `waitForLogEntry()` retries **unbounded, no timeout** (caused a
    24-min hang). Wrap every `indexer.upload()` in an application-level timeout/circuit-breaker
    (suggest 120s, retry once, then fail-open per T1.4 crash contract).
16. *(Phase 1 finding)* mem0ai@3.1.1's native vector store never returns embedding vectors from
    `list()`/`get()` — checkpoint vector rows must come from the journaling wrapper's own
    materialized mirror map (`core/src/store/journal.ts`), never from the native store's reads.
17. *(Phase 3 finding)* Runtime-installed native deps (`better-sqlite3`, `fastembed`) next to a
    bundled `.cjs`: `Module.globalPaths.push()` is **silently ignored** by `require()` on current
    Node (verified Node 26.0.0), and `NODE_PATH`+`Module._initPaths()` fixes CJS but is **ignored
    by dynamic `import()`** (mem0ai loads fastembed via ESM import). The only mechanism both
    resolvers honor is a real `node_modules` **symlink next to the running bundle** pointing at
    the persistent native-deps dir. See `packages/node-adapter/src/lib/native-bootstrap.ts`
    (`linkNodeModulesShim`).
18. *(Phase 3 finding)* `scope` does **not** partition storage: the flush chain is keyed per
    wallet address only (`packages/core/src/storage/client.ts:238` — `network:walletAddress`);
    `scope` is descriptive metadata inside blobs. One wallet = one memory chain. Any test or
    host that needs isolated chains must use a separate (ephemeral, funded) wallet — the spike
    wallet's own chain carries pre-spec blobs and will fail ECIES decode (by design).
19. *(Demo/T5 finding)* The SDK's ECIES rides on **AES-CTR (unauthenticated)**: `tryDecrypt`
    with a *wrong* private key does NOT throw — it returns `decrypted:true` with deterministic
    garbage bytes (`downloadAndVerify` then "succeeds" and hands back noise). Confidentiality
    holds (no plaintext is recoverable), but wrong-key detection only happens downstream when
    `decodeBlob` rejects the garbage. Never treat a non-throwing `downloadAndVerify` as proof
    the caller held the right key; treat `decodeBlob` failure as the authoritative signal.
20. *(T5.2 forensics — supersedes the earlier "indexer lag" read)* Three linked facts about
    0G storage durability, all verified live at segment level:
    **(a) The testnet trusted set is sharded** (`numShard: 2` — even absolute segment indices
    live on shard-0 nodes, odd on shard-1). `indexer_getFileLocations` returning `[]`/null can
    mean **no complete covering set EXISTS** — not merely propagation lag. A node can report
    `finalized: true` for *its shard's portion* while the file as a whole is unretrievable.
    **(b) A Submit log lands when the upload *transaction* is mined — BEFORE segment data is
    durable.** A failed/timed-out upload (our flush retries re-upload under a NEW tx) leaves
    dangling on-chain pointers that shadow the last good blob. Restore therefore must never
    trust the newest Submit log blindly: `resolveCandidates()` + the session's walk-back loop
    (skip unretrievable/undecodable pointers, `restoreStats.danglingPointersSkipped`) is the
    fix. The rootHash is computed locally from the Submit event's submission nodes
    (right-fold keccak256 — verified against `zgs_getFileInfo(...).tx.dataMerkleRoot`), so
    pointer resolution no longer needs any storage-node RPC.
    **(c) Large multi-segment uploads can silently lose their final segment on one shard**:
    three consecutive ~17.1MB uploads (67 segments) all left the shard-0 node at exactly
    66/67 with segment 66 served by NO node — the file can never finalize and the data is
    unrecoverable. Upstream 0G issue (report: txSeq 143558/143559/143561, wallet
    `0x4D46bb09942Fa5558Fc9527F95DD4432D0503682`, July 25 2026). dMemo's normal blobs
    (~16KB deltas, single segment) are unaffected; only the LoCoMo benchmark's giant
    checkpoints hit this. Mitigations: benchmark harness durability gate (verify covering
    set for the whole restore-chain suffix BEFORE wiping local state) +
    `session.droppedFlushCount` (fail-open drops are now detectable).
21. **`DMEMO_PRIVATE_KEY` is not a rotatable credential — treat every write of it as
    destructive.** It is the only key that can decrypt a wallet's blobs on 0G, so replacing it
    does not "reconfigure" anything, it orphans every memory written under it. Any code path
    that writes the config must go through `writeDmemoConfig`, which refuses to replace a
    *different* existing key unless the caller passes `allowKeyReplacement`, and always copies
    the old file to a timestamped `0600` backup (`COPYFILE_EXCL`, so a backup can never clobber
    a backup) before it does. Never add a second write path; never pass `allowKeyReplacement`
    from a code path that hasn't already taken explicit user consent. Two corollaries that
    caused real loss before they were fixed: a *non-atomic* config write can truncate the file
    and destroy the key on a crash (use the temp+`rename` path), and treating an unparseable
    config as `{}` silently discards the key inside it (back it up instead). Consent asymmetry:
    a `connect`-derived key is reproducible from the same wallet + scope, a `setup`-generated
    one exists nowhere else — only the latter earns a prompt.
22. *(F4 — Bun hosts)* **`better-sqlite3` does not merely fail on Bun, it ABORTS the process**,
    so gotcha 3's "just install it" is not sufficient on a Bun host (OpenCode runs plugins
    in-process under Bun). It is a **V8 C++ addon**, not a Node-API one, and Bun has never
    implemented that surface (`oven-sh/bun#4290`, open, no timeline) — you get
    `panic(main thread): NAPI FATAL ERROR: Error::New napi_get_last_error_info`, uncatchable, on
    12.x preceded by a `NODE_MODULE_VERSION 147 vs 137` ABI mismatch. Three consequences:
    **(a)** There is no config-level escape. `mem0ai/oss` imports `better-sqlite3` at *module*
    scope (`dist/oss/index.mjs` twice), so `await import('mem0ai/oss')` kills the process before
    any provider config is read, and `VectorStoreFactory.create()` is a closed switch with no
    instance passthrough (gotcha 11) — `MemoryVectorStore`, and its `new Database(dbPath)`, is
    always constructed.
    **(b)** The fix is a virtual module, and it must be installed *strictly before* that import:
    `ensureBetterSqlite3Compat()` (`core/src/runtime/bunSqliteCompat.ts`) registers a
    `Bun.plugin` `build.module('better-sqlite3', …)` routing to `bun:sqlite`. `Bun.plugin` only
    affects modules resolved *after* registration, so never hoist an `import('mem0ai/oss')`
    above it, and never add a second mem0 import path that skips it. Off Bun it is a no-op; if
    it *can't* install, `DmemoSession.open()` throws rather than proceeding, so a fail-open host
    disables memory instead of dying.
    **(c)** `bun:sqlite` is modelled on better-sqlite3 but diverges in three ways that produce
    **silently wrong answers, not crashes**, and the shim must keep normalizing them: `.get()`
    returns `null` on a miss (better-sqlite3: `undefined`); BLOBs come back as `Uint8Array`, not
    `Buffer`, and mem0 does `new Float32Array(v.buffer, v.byteOffset, v.byteLength/4)`, which
    **throws unless `byteOffset` is 4-byte aligned** — so BLOBs are copied into aligned Buffers;
    `.exec()` returns `undefined` instead of the Database, breaking chaining.
    Do **not** generalize this to "native addons don't work on Bun" — Node-API addons do:
    `fastembed`/`onnxruntime-node` runs unmodified under Bun (verified, dim=384). An
    out-of-process Node sidecar is therefore unwarranted; `better-sqlite3` is the only offender.
    Conformance evidence: mem0's real `MemoryVectorStore` driven through insert/search/filtered
    search/get/list/update/BM25 keywordSearch/delete/setUserId/payload-normalization is
    byte-identical between Node and Bun 1.2.18 & 1.3.14 (cosine scores included). Verified on
    macOS arm64 only.
23. *(F2)* **In `packages/setup-cli/src/cli.ts`, `--help`/`--version` must be checked BEFORE any
    command is dispatched, and unknown flags/commands must hard-error — never fall through to a
    default command.** The original hand-rolled arg loop only assigned `command` when the first
    token didn't start with `-`, so `dmemo --help` silently ran the full (wallet-touching) setup
    wizard instead of printing help, and an unrecognized/misspelled flag (e.g. `--newwallet`) was
    matched against nothing and dropped rather than rejected — before gotcha 21's fix landed, that
    combination could run a destructive path the user never asked for. Fixed by replacing the loop
    with `node:util`'s `parseArgs({ strict: true, allowPositionals: true })`: unknown options throw
    `ERR_PARSE_ARGS_UNKNOWN_OPTION` and a missing/ambiguous value throws
    `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` for free, so a typo can no longer silently select a
    different operation. `--help`/`-h` and `--version`/`-v` are resolved first, from any argv
    position, before the command positional is even validated. Any new flag or subcommand must go
    through this same table (`packages/setup-cli/src/cliArgs.ts`), not a second hand-rolled parser.

---

## Phase 0 — Close the spike ✅ COMPLETE (see `spike/RESULTS.md`)

Outcome (live testnet, July 2026): T0.1 PASS (snapshot + journal parity; flush ~14–17s,
~0.0011–0.0012 0G each; snapshot restore 4.31s, 2-delta chain restore 5.62s). T0.2 PASS offline
(no Router key in `.env`; `c4-streaming.mjs` self-selects live mode once a key exists). T0.3:
restore model `≈5.3 + 1.8K` seconds — **K=2 chosen** (8.9s cold start; clears Codex 12s and
Claude Code budgets; **Hermes 3s cap is unmeetable at any K** → v1.1 Hermes needs warm cache or
async prefetch, never synchronous cold restore). New gotchas 11–15 above came from this phase.

Already validated live: Router chat + broker funding (`spike/c1b-fund-and-chat.mjs`, tx
`0xb502164c…`), encrypted blob round-trip + pointer resolution (`spike/c2-blob.mjs`, all checks
passed). Wallet + fastembed model (`bge-small-en-v1.5`) already set up in `spike/`.

### T0.1 — C3: end-to-end memory loop (validates D3/D4/D6/D7/D17)
Build `spike/c3-mem0-loop.mjs`:
1. Instantiate `Memory` from `mem0ai/oss` with config
   `{ vectorStore: { provider: 'memory', config: {...} }, embedder: <fastembed/local>, llm: <unused for infer=false> }`
   — the native `memory.ts` store is a single better-sqlite3 file; control its `dbPath` to a temp file.
2. `add()` 20+ realistic coding-session turns with `infer: false` (verbatim mode, no LLM call);
   run 5 `search()` queries, record results (IDs + scores).
3. Flush: read the SQLite file bytes + `JSON.stringify` the history map → one JSON envelope →
   AES-256-CTR encrypt (key in memory) → `new MemData(ciphertext)` → `indexer.upload(file, RPC, wallet)`.
4. Wipe: delete temp file, drop all in-RAM state.
5. Restore: resolve rootHash via the `eth_getLogs` flow (reuse `c2-blob.mjs:170-215` verbatim) →
   download → self-verify Merkle root → decrypt → rewrite SQLite file → new `Memory` instance.
6. Re-run the same 5 searches. **Assert identical IDs and scores.**
7. Step 2 (after snapshot works): wrap the native store in a minimal journaling proxy that records
   every `insert/update/delete` as a JSON delta; flush deltas instead of the full file; restore =
   replay deltas into a fresh store; assert search parity again.
8. Measure and print: session-start restore time (resolve + download + decrypt + replay), flush
   time, blob sizes.
Acceptance: parity asserts pass on live testnet; latency numbers recorded in `spike/RESULTS.md`;
`infer=false` output judged usable (spot-check the stored memories read sensibly).

### T0.2 — C2-streaming: Router SSE shape vs SDK helpers
Script `spike/c4-streaming.mjs`: call testnet Router `/v1/chat/completions` with `stream: true`
via `openai` npm client, exercise (a) `Stream.tee()` — drain one branch, hand the other to a
normal accumulator; (b) `client.chat.completions.stream()` + `finalChatCompletion` event.
Acceptance: both produce the identical final text; chunk shape incompatibilities (if any)
documented in `spike/RESULTS.md`. Ref: `sdks.md` §3, open item §"Unresolved".

### T0.3 — Tune K (checkpoint cadence) from T0.1 numbers
Given restore = 1 checkpoint + <K deltas, pick K so cold-start stays within the tightest host
budgets (Codex hooks 12s installer-configured; Claude Code `UserPromptSubmit` 30s; Hermes
prefetch 3s soft). Record chosen K + rationale in `spike/RESULTS.md`. Default hypothesis: K=20
or a 64KB size threshold, whichever first (D3).

---

## Phase 1 — `@dmemo/core` (TS) ✅ COMPLETE (live smoke test passed ×2)

Outcome (July 2026): T1.1–T1.7 built and live-verified on testnet Galileo
(`packages/core/scripts/smoke-testnet.mjs`: fresh open 3.9s; delta flush 11.6s / checkpoint
flush 10.1s at ~0.0012 0G each; K=2 chain-reset confirmed; restore 3.3s with chainLength 1;
search parity identical IDs+scores after restore). Accepted deviations from the literal spec:
(a) mainnet `FixedPriceFlow` address intentionally unset — `resolveNetworkConfig('mainnet')`
throws unless `DMEMO_FLOW_ADDRESS` is supplied (never live-verified, by design); (b) decrypt
path per updated gotcha 7; (c) checkpoint vectors from the journal mirror per gotcha 16;
(d) T1.7 `forget()` is epoch-key derivation + tombstone journaling only — per-epoch keys are
NOT yet wired into the ECIES ciphertext path (audit marker, not ciphertext-level shredding;
full wiring added to Deferred); (e) `open()` takes `privateKey` (naming); (f) added
`waitForPendingFlush()` for deterministic observability — `flush()` itself stays
fire-and-forget.

Monorepo layout (T1.0): pnpm workspaces —
`packages/core`, `packages/node-adapter` (Claude Code + Codex), `packages/opencode-plugin`,
`packages/openclaw-plugin`, `packages/sdk-wrappers`, `packages/blob-spec`.

### T1.1 — Canonical blob spec (`@dmemo/blob-spec`) [D16]
- Two record types, versioned: **delta** (ordered list of mutations
  `{op: insert|update|delete, id, payload{memory text, embedding, metadata}, historyEntries[]}`)
  and **checkpoint** (full state: all vector rows + full history map + metadata).
- Envelope metadata (both types): `{specVersion, walletAddress, agentScope, seq, prevRootHash,
  embedder: {provider, model, dim}, engine: {name: 'mem0-oss', version}, createdAtChain?: block}`.
  Embedder identity pinned here drives re-embed migration (D6).
- Plain JSON (deterministic key order), designed for Python parity in v1.1 — **never** raw
  SQLite/engine files inside the spec (raw file snapshot is only the Phase-0 stepping stone).
- Embedding vectors inside payloads are **base64-encoded `Float32Array` bytes**, never JSON float
  arrays (gotcha 14 — measured 4× size blowup otherwise).
- Deliverable: TS types + `encode/decode` + spec doc `packages/blob-spec/SPEC.md`.

### T1.2 — 0G storage client (`core/src/storage/`) [D2, D8, D9]
- **Encrypt**: SDK-native ECIES to the wallet's secp256k1 pubkey —
  `indexer.upload(memData, rpc, signer, { encryption: { type: 'ecies', recipientPubKey } })`;
  decrypt via `indexer.downloadToBlob(rootHash, { decryption: ... })`. Use
  `peekHeader()` to detect mode (headers: aes256 = 17B `[0x01][nonce:16]`, ecies = 50B
  `[0x02][ephemeralPub:33][nonce:16]`). Wallet doubles as the memory key — zero extra secrets.
  Ref: `0g-storage.md` §b rows 3–5; starter-kit README §239-291.
- **Upload**: `new MemData(bytes)` → `indexer.upload()` → returns `{txHash, rootHash, txSeq}`.
- **Download + verify**: after download, recompute `new MemData(bytes).merkleTree().rootHash()`
  and compare with the expected on-chain root; mismatch = hard error (gotcha 1).
- **Pointer resolution** (`resolveLatest(wallet): {rootHash, txSeq, block}`):
  1. Read local cache `~/.dmemo/pointer-cache.json` (`{network, wallet, lastBlock, txSeq, rootHash}`);
     scan from `lastBlock` if present.
  2. `eth_getLogs({address: FLOW_ADDRESS, topics: [Interface(FixedPriceFlow__factory.abi)
     .getEvent('Submit').topicHash, zeroPadValue(wallet, 32)], fromBlock, toBlock})`, halve-range
     retry on RPC rejection; paginate backwards in ≤4.7M-block windows for dormant wallets.
  3. Latest log → `Number(decoded.args.submissionIndex)` = txSeq →
     `indexer.selectNodes(1)` → `node.getFileInfoByTxSeq(txSeq)` → `fileInfo.tx.dataMerkleRoot`.
  4. Update cache after every successful write AND resolve. Cache is a soft optimization —
     losing it must never lose data.
  Working reference implementation: `spike/c2-blob.mjs` (steps 5–6). Do NOT add a pointer
  contract in v1 (ranked #2, deferred; `followup-pointer-strategy.md`).
- Network config: single env `DMEMO_NETWORK=testnet|mainnet` selects {rpc, indexer, flow address,
  router URL} tuples (D14).

### T1.3 — Journaling `VectorStore` wrapper (`core/src/store/journal.ts`) [D7]
- Implements mem0-TS's `VectorStore` interface (mirror of Python `VectorStoreBase`: `insert,
  search, get, update, delete, list, deleteCol,...` — copy the exact method set from the
  installed `mem0ai/oss` typings; score contract: higher = more similar, normalized [0,1]).
- Construction: wraps an instance of the native in-process store
  (`mem0-ts/src/oss/src/vector_stores/memory.ts`, better-sqlite3-backed) pointed at a
  session-temp `dbPath`. **All reads/search delegate untouched.** Writes delegate AND append a
  spec-format mutation (T1.1) to an in-RAM journal.
- Registered via mem0's config as a custom `vectorStore.provider` — no patches to mem0 itself.
  If the TS factory doesn't accept an instance/custom class, use the documented custom-provider
  registration path in the installed version; forking mem0 is NOT allowed (D1: embed, not fork).
- History (D5): mem0-TS `MemoryHistoryManager` is an in-process `Map` — serialize it into every
  delta/checkpoint; restore = repopulate the Map. No adapter, no patch.

### T1.4 — Flush engine + session lifecycle (`core/src/session.ts`) [D3, D4]
API sketch (what host adapters call):
```
const session = await DmemoSession.open({wallet, network, scope})   // restore
const results = await session.memory.search(query, {topK})          // recall
await session.memory.add(messages, {infer: cfg.infer})              // capture
session.flush()          // async fire-and-forget: encrypt journal delta → upload (1 tx)
await session.close()    // final awaited flush → wipe temp file + RAM
```
- `open()`: `resolveLatest` → download checkpoint + subsequent deltas (walk `prevRootHash` chain
  in envelope metadata) → verify each → decrypt → replay into fresh native store at temp path.
  Empty chain = fresh store (first run).
- `flush()`: never blocks the caller; per-completion cadence (D4); serializes the journal since
  last flush as one delta blob. Every K flushes OR when accumulated state > size threshold
  (values from T0.3 — **K=2 default**, size threshold 64KB): serialize full state as a
  **checkpoint** instead, which resets the delta chain (cold start = 1 checkpoint + <K deltas,
  measured ≈5.3 + 1.8K seconds).
- Wrap every upload in an application-level timeout (~120s) — gotcha 15 (`waitForLogEntry()` can
  hang unbounded).
- Crash contract: a crash between completion and flush loses at most 1 turn. In-flight flush
  failures: retry once, then log-and-drop (fail-open — memory must never break the host; mirror
  mem0-plugin's no-API-key/fail-open guards).
- Same-session read-your-writes come from the local store only — never re-fetch 0G mid-session.

### T1.5 — Local embedder (`core/src/embedder.ts`) [D6]
- Auto-detect order: explicit config → Ollama if reachable at `localhost:11434` (model
  `nomic-embed-text`) → bundled `fastembed` ONNX (`bge-small-en-v1.5`, already proven in spike).
- Wire in as mem0's `embedder` config slot (native pluggable slot — zero engine changes).
- Pin `{provider, model, dim}` into blob envelope; on mismatch at restore, trigger re-embed
  migration (re-embed all memory texts with the new embedder, journal as updates).
- Remote embeddings must never be a silent default (privacy claim).

### T1.6 — Config surface (`core/src/config.ts`) [D14, D17]
`DMEMO_NETWORK` (default `testnet`), `DMEMO_PRIVATE_KEY` (wallet = memory key), `infer` toggle
(default **false** — verbatim capture, no 2nd LLM call; D17), embedder override, K/size
threshold overrides, `ZEROG_API_KEY` (Router, inference leg only). Memory leg must work with
zero Router key (D11 separability).

### T1.7 — Forget = crypto-shred (`core/src/forget.ts`) [D13]
Per-epoch sub-keys derived from the wallet key (HKDF with epoch index), epoch = checkpoint
interval. `forget(epoch)` = discard the sub-key + journal a tombstone delta. UX wording:
"unreadable forever", never "deleted". Keep minimal in v1: epoch derivation + tombstone record
type in the blob spec; a full retention UI is out of scope.

---

## Phase 2 — Inference leg (`packages/sdk-wrappers`) ✅ COMPLETE [D10, D11]

Outcome (July 2026): T2.1 + T2.2 built; monorepo builds clean (tsc -b strict); 15/15 unit tests
pass (mock OpenAI-JSON/SSE server: injection shape, non-stream + stream write-back parity,
fail-open no-session and throwing-search). Live: `listPrivateModels()` verified against testnet
Router (found the catalog drift noted in constants). **Live authenticated chat = PENDING a
Router `sk-` key** (none exists in `spike/.env`; the spike's live chat used the out-of-scope
broker SDK — not a substitute proof). Accepted deviations: (a) Anthropic client uses `authToken`
(Bearer) not `apiKey` (which sends `x-api-key`) — matches the spec's `Bearer sk-...`; (b)
wrappers type against a structural `DmemoMemorySession` interface satisfied by `DmemoSession`'s
public surface — `@dmemo/core` is NOT a dependency of `sdk-wrappers` (keeps it dependency-light);
(c) no live Anthropic-path call attempted (Claude models mainnet-only — correctly never called).
SDK versions: `openai@6.49.0`, `@anthropic-ai/sdk@0.115.0` (`Middleware`/`ctx.parse` confirmed
exported).

### T2.1 — Router client preset
Factory returning configured OpenAI / Anthropic SDK clients:
- `baseURL` = Router URL per network; `Authorization: Bearer sk-...`.
- Default header `X-0G-Provider-Trust-Mode: private` (TeeML-only routing — this is what makes
  "private inference" true; `0g-compute.md` §b). Optional `verify_tee: true` body flag → log
  `x_0g_trace.tee_verified` for audit.
- Helper `listPrivateModels()`: `GET {router}/v1/models` (no auth) filtered
  `verifiability === "TeeML"`.
- Do NOT build retry/failover/provider pools (Router does it); do NOT use the deprecated
  `@0glabs/0g-serving-broker`. Direct-SDK path (`@0gfoundation/0g-compute-ts-sdk`) is out of
  scope for v1. Note: `processResponse()` threw "getting signature error" in the spike — flagged,
  not a v1 dependency.

### T2.2 — SDK memory wrappers (raw OpenAI/Anthropic SDK users)
- **Primary — custom `fetch`** passed as client option (both SDKs, `client.ts` `fetch` option):
  before real fetch, inject `session.search()` results into `init.body` messages/system; after,
  for streaming, `response.clone()` / `Stream.tee()` a branch to accumulate the final message →
  `session.add()` + `session.flush()`.
- Write-back triggers: non-stream = awaited return value; stream = `Stream.tee()` (identical in
  both SDKs, `core/streaming.ts:220`) or `finalChatCompletion` / `finalMessage` events when we
  own the call site.
- **Secondary — Anthropic `middleware`** (v0.101.0+, exported, runs inside retry loop before
  signing): request mutation + `ctx.parse(response)` gives an independent stream copy — no
  manual clone. Use for Claude traffic incl. Claude-on-0G (`/v1/messages` on the Router is a
  genuine Anthropic Messages implementation).
- No SDK subclassing, no monkey-patching (`sdks.md` §5).

---

## Phase 3 — Host adapters ✅ COMPLETE [D18 fork bases — read `followup-fork-bases.md` first]

Common to all: the fork's client seam is replaced by `@dmemo/core`'s `DmemoSession`; ALL
mem0-Platform-only surfaces (MCP `mcp.mem0.ai`, project/entity/event APIs, categories) are
**stripped, not ported**. Capture uses `infer` from config (default false). All hooks fail-open.

Outcome (July 2026): all three adapters built, unit-tested, and live-verified on testnet with
ephemeral wallets funded from the spike wallet (gotcha 18). Full monorepo builds clean
(`pnpm -r build`, 6 packages).
- **T3.1** `packages/node-adapter` + `claude-dmemo/` plugin tree + Codex installer. Native-module
  packaging solved via node_modules symlink shim (gotcha 17) — standalone `.cjs` proven from a
  dir with zero node_modules (unconfigured = silent exit 0, no side effects; configured = one-time
  `npm install` into `~/.dmemo/native/`). Live hook sequence SessionStart→UserPromptSubmit→Stop→
  SessionStart→UserPromptSubmit passed: real flush (~0.00132 0G), restore surfaced memory in
  `additionalContext`. Timings: cold SessionStart ~17s (first-run npm install), warm ~3s,
  UserPromptSubmit ~3.7s, Stop ~11.6s. Codex installer verified in `CODEX_HOME` sandbox:
  idempotent merge, user hooks survive, uninstall strips only dMemo-owned entries (config.toml
  `[features]`/`[memories]` intentionally not reverted). Accepted deviations: PreCompact
  timeout 30s; `plugin.json` `userConfig.privateKey` → `DMEMO_PRIVATE_KEY`; `DMEMO_HOOK=1`
  owner-marker on Codex commands; `DMEMO_SCOPE` defaults `'default'`.
- **T3.2** `packages/opencode-plugin`: 12/12 unit tests; live integration PASS (open 3.5s,
  search 0.5s, dispose 22.9s/2 flushes, cold restore 2.3s, 0.0026 0G). Fork-base drift: the mem0
  fork has no real `message.updated` hook (capture is inline `msgCount % 3`, `infer:true`) —
  implemented the spec's design against the real `@opencode-ai/plugin@1.18.5` API with
  `infer:false` + message-ID dedup. Compaction on native `experimental.session.compacting` with
  opencode-supermemory trigger math (ratio ≥0.80, ≥50k tokens, 30s cooldown) + `session.idle`
  catch-up. Also stripped mem0's Platform telemetry `captureEvent` (off-device leak).
- **T3.3** `packages/openclaw-plugin`: 17/17 unit tests; live integration PASS (2849ms restore,
  13347ms flush, 0.00118 0G). `isolation.ts`/dream-gate ported, `runDreamBatch()` flushes a dream
  burst as one delta batch, `plugins.slots.memory="dmemo"`, memory_search/memory_get/memory_dream
  tools. Ambient types pinned to openclaw 2026.7.2 commit ca8610151af280492c23af992956968bc9427d03
  (`src/openclaw-plugin-sdk.d.ts`). `before_prompt_build` timeout raised to 10000ms per measured
  restore. Hardcodes `infer:false` structurally — no core config slot exists yet (see Deferred).

### T3.1 — Merged Node adapter (`packages/node-adapter`) — Claude Code + Codex
Base: `claude-supermemory` packaging skeleton + `mem0-plugin` deterministic behaviors.
- Hook scripts in TS → esbuild-bundled to dependency-free single-file `.cjs` with
  `#!/usr/bin/env node` banner (copy `claude-supermemory/scripts/build.js` pattern). No
  node_modules at runtime. ⚠️ `better-sqlite3` is a native module — it cannot be esbuild-inlined;
  bundle everything else and install/copy the prebuilt binding into `${CLAUDE_PLUGIN_DATA}` on
  first run (persistent across plugin updates). Solve this first; it's the packaging risk.
- Hooks (`hooks/hooks.json`, all `type: "command"`, `node "${CLAUDE_PLUGIN_ROOT}/scripts/*.cjs"`):
  - `SessionStart` (timeout 30): `session.open()` → top-N memory summary → stdout
    `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<memory>"}}`.
  - `UserPromptSubmit` (timeout 10): deterministic top-5 `search(prompt)` → `additionalContext`
    (mem0-plugin behavior — NOT claude-supermemory's model-gated recall directive).
  - `Stop` (timeout 30): read stdin JSON (`transcript_path`, `last_assistant_message`,
    `session_id`), extract the new turn, `add()` + `flush()`, background-friendly (exit 0 fast).
  - `PreCompact`: capture-before-compaction (same capture path).
  - Guards to port from mem0-plugin: skip subagent sessions, skip when unconfigured (fail-open),
    dedupe markers for per-session rubric.
- Claude Code packaging (`followup-claude-code-packaging.md`): one repo `claude-dmemo` =
  marketplace + plugin: `.claude-plugin/marketplace.json` (source `"./plugin"`),
  `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `plugin/skills/dmemo-search/`,
  `dmemo-save/` (frontmatter `allowed-tools: Bash(node:*)`), `plugin/commands/status.md` etc.,
  `PreToolUse` matcher `Skill|Bash` hook auto-approving the search script
  (`permissionDecision: "allow"`). **No `.mcp.json` in v1.** Install =
  `/plugin marketplace add dmemo-ai/claude-dmemo` + `/plugin install dmemo`. Same `plugin/` dir
  must load via Agent SDK `options.plugins: [{type:'local', path}]` unchanged.
- Codex leg: same `.cjs` scripts (hook schema is CC-compatible: same event names,
  `additionalContext` shape, permission-mode vocab). Installer (TS port of
  `install_codex_hooks.py` pattern): idempotent merge into `~/.codex/hooks.json` via an
  owner-marker strip-then-reinsert, `--uninstall`, refuse Windows, detect/enable
  `[features] codex_hooks=true`, **12s timeouts** on Codex hooks. Also set
  `memories.generate_memories = false`, `memories.use_memories = false` in `config.toml`
  (disable Codex's competing local memory). Write-back in `Stop` only (gotcha 9). No inference
  config for Codex (gotcha 5).
- Inference (Claude Code only, optional & separable): document/env-write
  `ANTHROPIC_BASE_URL=<router>` + `ANTHROPIC_AUTH_TOKEN=sk-...` (Router `/v1/messages` is
  first-class). Never required for the memory leg.

### T3.2 — OpenCode plugin (`packages/opencode-plugin`)
Fork `mem0/integrations/mem0-plugin/.opencode-plugin/opencode-mem0.ts`:
- Replace `new MemoryClient({apiKey})` (single site, `:279`) with `DmemoSession` (in-process).
- Strip 4 Platform-only tools: `autoSetupCategories`, `delete_entities`, `list_entities`,
  `get_event_status` (`:139-173, 580-626`).
- Rewrite `resolveFilters`/`scope.ts` from Platform `{AND:[…]}` REST DSL to mem0-OSS
  `SearchFilters`.
- Keep unchanged: every-turn injection via `chat.message` + `chat.messages.transform`
  (`:630-886`), manual memory tool, capture on `event: message.updated`
  (`role==='assistant' && info.finish`) + every-3rd-message cadence.
- Compaction: implement on the native `experimental.session.compacting` hook with
  opencode-supermemory's trigger math (token-ratio ≥0.80 AND ≥50k tokens, cooldown,
  `session.idle` catch-up) — do NOT copy its file-writing wiring (it bypasses the hook).
- Inference doc/config template: `opencode.json` →
  `provider["0g"] = { npm: "@ai-sdk/openai-compatible", options: { baseURL: <router>/v1,
  apiKey: "{env:ZEROG_API_KEY}" }, models: {...} }` (router is chat-completions-shaped →
  `openai-compatible`, not `@ai-sdk/openai`).
- Distribution: npm package loadable from `opencode.json` `"plugin": [...]`.

### T3.3 — OpenClaw plugin (`packages/openclaw-plugin`)
Fork `mem0/integrations/openclaw` (`@mem0/openclaw-mem0`):
- Swap OSS **defaults** (not opt-ins) in `providers.ts:247-326`: embedder
  `text-embedding-3-small` → dMemo local embedder (T1.5); LLM `gpt-5-mini` → 0G Router base_url
  (used only when `infer=true`). The shipped defaults call OpenAI — that must be impossible in
  dMemo's build.
- Insert the D7 journaling wrapper + session lifecycle under its OSS `Memory` init (replace its
  `~/.mem0/vector_store.db` persistence with dMemo's temp-file + 0G flush model).
- Keep: `isolation.ts` scoping (`${userId}:agent:${agentId}`, subagents read parent scope / skip
  capture), deterministic `before_prompt_build` recall (default `smart` strategy), `agent_end`
  capture, dream consolidation gate (tag dream mutations `source:"dream"`, flush a dream burst
  as ONE delta batch).
- Own the slot: `plugins.slots.memory = "dmemo"`; register `memory_search`/`memory_get` tools
  (two-tool convention).
- Check/raise `hooks.timeoutMs` for `before_prompt_build` against T0.1's measured restore time.
- Inference doc/config template: `models.providers.zg = { baseUrl: <router>/v1,
  api: "openai-completions", apiKey: "${ZEROG_API_KEY}" }` +
  `agents.defaults.model.primary: "zg/<model>"`.

---

## Phase 4 — Onboarding & packaging ✅ COMPLETE

Outcome (July 2026): all three tasks done; `pnpm -r build` + `pnpm -r test` clean from root
(7/7 packages, 66/66 tests). Nothing was actually published or pushed — RELEASE.md holds the
human checklist (npm org, GitHub repos for monorepo + `claude-dmemo`, `npm login`, publish).
- **T4.1** `packages/setup-cli` (npm name `dmemo`, bin `dmemo`): wallet generate/import (key
  never echoed), faucet instructions + live balance polling (read-only RPC), `~/.dmemo/config`
  mode 0600 (`DMEMO_HOME` overridable), host detect+install for CC/Codex/OpenCode/OpenClaw,
  printed pc.0g.ai instructions for the sk- key (not scripted). Codex hook files are vendored
  at build time (`scripts/vendor-codex-plugin.mjs` prebuild) — no GitHub fetch at setup time.
  Sandbox-tested end-to-end; real dotfiles verified untouched. Test gotcha: `os.homedir()`
  reads real process HOME — sandbox tests must set the actual env var.
- **T4.2** All 6 publishable packages carry repository/license(MIT)/publishConfig/README;
  `node-adapter` stays `private: true` (build tool). Fix found in pack verification: compiled
  `*.test.js` leaked into tarballs → `!dist/**/*.test.js` negations added, re-verified clean.
  `pnpm pack` confirmed `workspace:*` → real-version rewrite. `scripts/publish.mjs`: topological
  order blob-spec→core→sdk-wrappers→opencode-plugin→openclaw-plugin→setup-cli, dry-run by
  default, live requires `--live --yes-i-am-sure` (+`--otp=`). Dry run passed for all 6.
  Root `LICENSE` (MIT) + per-package copies. `claude-dmemo/` layout verified vs setup-cli
  constants; intentionally not yet a git repo (RELEASE.md step).
- **T4.3** `docs/disclosure.md`: on-chain metadata is public (structural); key loss = permanent;
  ECIES mechanism; TeeML vs TeeTLS incl. the 2026-07-25 testnet fact (no TeeML chat model live);
  v1 forget = tombstone + proof-of-derivability, does NOT re-key ciphertext (per-epoch shred is
  v1.1). `packages/core/README.md` links it; no root README exists (spec's "if one exists").
- Accepted deviation: OpenClaw install is best-effort `openclaw plugins install` + printed
  manual `plugins.slots.memory` instructions — config schema not confirmed solidly enough to
  auto-edit a user's real config.

### T4.1 — `npx dmemo setup` script
Steps (minimum-friction, in order): generate or import wallet → print faucet link (testnet) /
funding instructions → write `~/.dmemo/config` (network, key storage) → per-host install
(detect Claude Code / OpenCode / OpenClaw / Codex; run the respective installer from Phase 3) →
optional inference leg: guide one interactive pc.0g.ai sign-in for the `sk-` key (accepted gap —
no documented headless first-key mint; do NOT attempt to script the wallet-JWT step). Memory leg
must complete with zero interactive web steps.

### T4.2 — Publish pipeline
npm publish for all packages; `dmemo-ai/claude-dmemo` marketplace repo (own marketplace for v1;
submit to `claude-plugins-community` afterwards for discoverability).

### T4.3 — Disclosure docs (dai-values §4)
State plainly: on-chain metadata (writer address, blob size, write cadence) is public even with
perfect encryption; key loss = permanent memory loss; TeeML vs TeeTLS difference (TeeTLS leaks
prompts to the upstream vendor — dMemo pins TeeML); "forget" = crypto-shred semantics.

---

## Phase 5 — Test & validate

### T5.1 — Integration tests (live testnet, funded spike wallet)
- Blob round-trip: encode→encrypt→upload→resolve→download→verify→decrypt→decode == original.
- Tamper test: flip a byte in downloaded ciphertext → Merkle self-verify MUST fail.
- Pointer: cold resolve with no cache (paginated), warm resolve with cache, resolve after fresh
  write.
- Crash recovery: kill the process between `add()` and `flush()` → next `open()` restores with
  exactly ≤1 turn missing.
- Checkpoint consolidation: force K flushes → verify next open downloads 1 checkpoint + 0 deltas.
- Host smoke tests: one scripted session per host asserting (a) memory recalled in turn N+1,
  (b) memory recalled in a brand-new session after full wipe.

### T5.2 — Benchmark: LoCoMo + flush/restore invariance
Per `research/followup-memory-benchmarks.md` (read §c/§d before starting). Harness =
`mem0ai/memory-benchmarks` (Apache-2.0; the exact repo behind mem0's published numbers).
1. Shim server (~50 lines, Fastify) exposing the harness's fixed REST contract backed by
   `DmemoSession`:
   - `POST /memories` body `{messages, user_id, timestamp?, metadata?}` → `{results: [...]}`
   - `POST /search` body `{query, user_id, top_k, rerank}` → list of
     `{memory, score, id, created_at?, updated_at?}`
   Point the harness at it: `Mem0Client(mode="oss", host=http://localhost:<port>)` via
   `--mem0-host`.
2. Ingest LoCoMo-10 (all 10 conversations), run `benchmarks.locomo.run --predict-only`
   (search-only: zero LLM cost, deterministic with fixed local embeddings). Save per-question
   checkpoints (`{checkpoint_dir}/_checkpoint_{question_id}.json`).
3. Flush entire state to 0G testnet (T1.4 path), wipe local state completely.
4. Restore into a fresh instance behind the same shim; re-run `--predict-only` on the identical
   question set.
5. **Invariance assert**: pre/post checkpoint files identical (exact memory-ID sets + scores per
   question). This deterministic diff is the headline proof; it costs nothing to re-run.
6. One `--evaluate-only` pass for the headline %: categories 1–4 ONLY (exclude cat-5
   "adversarial"), single top-k = 20, harness default prompts unmodified, answerer = judge =
   same model. Model: 0G Router **testnet** via the harness `LLMClient` OpenAI-compatible
   `base_url` → the current live testnet chat model (⚠️ catalog drifted — was
   `qwen/qwen2.5-omni-7b`, live check 2026-07-25 shows `qwen2.5-omni`/TeeTLS; re-run
   `GET /v1/models` first and report the id actually used), paid from the testnet wallet.
   ~600–800 small calls. Requires a Router `sk-` key (none exists yet — see Phase 2 outcome).
7. Report exactly as: "N% on LoCoMo (categories 1–4, top-k=20, judge=qwen2.5-omni-7b via 0G
   Router testnet), single run, identical retrieval before/after encrypted 0G flush/restore."
   Never omit the protocol qualifiers (Zep-dispute lesson, §b of the benchmarks doc).
   License note: LoCoMo dataset is CC BY-NC 4.0 — benchmarking OK, don't redistribute it.
8. Optional (zero extra integration): LongMemEval-S through the same shim as a second datapoint.

### T5.3 — Latency report
Session-start restore P50/P95 on testnet vs each host budget (CC UserPromptSubmit 30s / hook 10s
as configured, Codex 12s, OpenClaw configurable, Hermes 3s soft) + flush cost per turn in 0G.
Output: table in `docs/benchmarks.md`.

---

## Deferred (do not build in v1)

| Item | Status |
|---|---|
| Pointer contract (`mapping(address => bytes32)`, ERC-7857 precedent) | Only if cold-start pagination proves painful |
| Per-epoch keys wired into ECIES ciphertext (true crypto-shred; today `forget()` = tombstone + key-derivation proof only) | v1.1 — blob spec + T1.7 already carry the epoch machinery |
| B5 key custody for always-on agents | Own design session before any always-on deployment |
| Wire `infer=true` → 0G Router LLM into `@dmemo/core` config (adapters hardcode `infer:false` structurally; no core slot for a Router-backed mem0 LLM exists) | v1.1 — also blocked on Router `sk-` key availability |
| Per-scope chain partitioning (today: one flush chain per wallet address; `scope` is metadata only — gotcha 18) | v1.1 — needs multi-profile UX decision first |
| Hermes provider (Python `mem0` + FastEmbed, same blob spec) | v1.1 — copy `hermes-agent/plugins/memory/mem0` as `dmemo` provider |
| MCP server surface, Tapp-TEE remote mode, BEAM/MemoryAgentBench | v2 / post-hackathon |
