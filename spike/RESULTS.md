# Phase 0 Spike Results (T0.1 / T0.2 / T0.3)

All numbers below are from real executions against the funded Galileo testnet wallet
(`spike/.env`). Private key is never printed anywhere in this document or in any script
output. Raw evidence: `spike/c3-results.json`, `spike/c3-run2.log`, `spike/c4-streaming.mjs`
stdout (reproduced inline below).

## 0. Wallet balance accounting

| Point in time | Balance (0G) |
|---|---|
| Session baseline, after two earlier accidental `c2-blob.mjs` reruns (T-1 work, pre-dates this task) | 6.993619786180422104 |
| After `c3-mem0-loop.mjs` run 1 (killed mid-flight — see §4) | 6.99128117241917149 |
| After `c3-mem0-loop.mjs` run 2 (the successful, reported run) | 6.987799968749455958 |

- Run 1 spend (checkpoint upload + one delta-A upload that landed on-chain before the process
  was killed while stuck in the SDK's finality-wait loop): **0.002338613761250614 0G**
- Run 2 spend (checkpoint + delta A + delta B, the clean run whose numbers are reported below):
  **0.003481203669715532 0G** (matches `totalCostEth` in `c3-results.json` exactly)
- Total spend attributable to T0.1 work this session: **0.005819817430966146 0G**, against a
  ~6.99 0G balance (~0.08% of balance). No mainnet calls were made anywhere in Phase 0.

`c3-results.json.balanceBefore` / `.balanceAfter` (6.99128117241917149 → 6.987799968749455958)
are the authoritative before/after figures for the **reported, passing** run.

## 1. T0.1 — mem0 ↔ 0G-Storage round trip (`c3-mem0-loop.mjs`)

### Step 1 — Snapshot mode (full checkpoint each flush)

- 48 memories added (24 turns + 24 extra), embedder `fastembed` (`fast-bge-small-en-v1.5`,
  dim 384), `infer:false` (no LLM extraction — raw message capture).
- Flush = serialize SQLite db file + history map → JSON envelope → AES-256-CTR encrypt →
  upload to 0G Storage.

| Metric | Value |
|---|---|
| Plaintext bytes | 181,631 |
| Ciphertext bytes | 181,647 |
| Encrypt time | 1.01 ms |
| Upload time | 16,843.48 ms |
| Flush time (encrypt+upload) | 16,844.49 ms |
| Cost | 1,127,639,441,262,879 wei = **0.001127639441262879 0G** |

Restore (wipe local state, resolve pointer on-chain, download, verify, decrypt, rebuild):

| Restore phase | Time |
|---|---|
| Pointer resolve (`eth_getLogs` → txSeq → `dataMerkleRoot`) | 1,126.32 ms |
| Download | 2,976.36 ms |
| Merkle self-verify | 16.27 ms |
| Decrypt | 0.73 ms |
| Replay (rewrite db file, reconstruct `Memory`, restore history map) | 190.09 ms |
| **Total restore** | **4,309.78 ms** |

Post-restore re-search against the same 5 queries returned identical results to pre-flush
search (`parityPassed: true`).

### Step 2 — Journal mode (delta flushes via `JournalingVectorStore`)

`VectorStoreFactory` has no custom-provider registration path (see §3), so the journal wraps
the native `MemoryVectorStore` via a post-init property swap and records
`insert`/`update`/`delete` ops with embedding vectors packed as base64 `Float32Array` bytes
(matching the native store's own on-disk binary encoding — see the bug/fix in §3).

| Flush | Memories | Plaintext bytes | Ciphertext bytes | Upload time | Cost |
|---|---|---|---|---|---|
| Delta A | 48 | 135,503 | 135,519 | 16,074.52 ms | 0.001164026581504179 0G |
| Delta B | 12 | 33,681 | 33,697 | 14,113.26 ms | 0.001189537646948474 0G |

Restore (2-delta chain, only the latest blob needs on-chain pointer resolution; delta A is
fetched by its known `prevRootHash` via direct content-addressed download):

| Restore phase | Time (cumulative, 2 blobs) |
|---|---|
| Pointer resolve (latest blob only) | 1,707.92 ms |
| Download | 3,617.96 ms |
| Merkle self-verify | 26.36 ms |
| Decrypt | 1.14 ms |
| Replay (60 vector ops + history, fresh `Memory` construction) | 268.22 ms |
| **Total restore** | **5,621.62 ms** |

Post-restore re-search parity: `parityPassed: true`.

**Caveat for T0.3 use:** delta A (135,519 bytes) is the harness re-adding the *entire* 24-turn
dataset a second time to symmetrically match Step 1's dataset size — it is **not** a
representative single-turn delta. Delta B (33,697 bytes for 12 memories, ~2,808 bytes/memory)
is the more realistic per-flush delta size for K-tuning purposes.

### `infer:false` quality spot-check (3 pasted examples, verbatim from `c3-results.json`)

| Query | Stored memory returned |
|---|---|
| "how was the undefined req.user error fixed" | "Fixed the undefined req.user crash with a JWT guard, fixed a Postgres pool leak and added indexes cutting /api/users latency from 800ms to 40ms, cleaned up the rebase conflict, and standardized API error responses." |
| "database connection pool tuning and leaks" | "Can you review my connection pooling change?" |
| "git rebase conflict resolution" | "How do I resolve a git rebase conflict in package-lock.json?" |

Judgment: readable and correctly retrieved by topical relevance, but with `infer:false` the
"memory" is the raw message text verbatim (no LLM summarization/fact extraction). The first
result is a multi-topic run-on capturing 4 unrelated fixes in one memory (from an assistant
turn that mentioned all of them together) — usable for recall but not as clean/atomic as an
LLM-extracted fact would be. This is expected behavior for `infer:false`, not a bug.

### T0.1 verdict: **PASS**

- Snapshot flush/restore round trip: PASS (byte-identical semantics, search parity holds)
- Journal flush/restore round trip across a 2-delta chain: PASS (parity holds)
- Balance measured before/after: PASS (reported above)
- `infer:false` spot-check performed and documented: PASS

## 2. T0.2 — Streaming comparison (`c4-streaming.mjs`)

No `ZEROG_API_KEY` / `ROUTER_API_KEY` present in `spike/.env` — per instructions, no key was
invented and no mainnet call was made. The script auto-detects this and runs in **offline
synthetic mode**: it builds a real SSE byte stream (`Stream.fromSSEResponse`) from a
synthetic `ChatCompletionChunk` sequence, exercises `Stream.tee()` to fan out two branches,
and compares:

- **Branch A** — manual drain of a `tee()`'d branch, hand-accumulating `delta.content`.
- **Branch B** — `branchB.toReadableStream()` → `ChatCompletionStream.fromReadableStream()` →
  `.finalContent()` / `.finalChatCompletion()`.

Result: both branches produced byte-identical final text, matching the known-good expected
string. All assertions passed, exit code 0.

A guarded **LIVE MODE** code path exists in the script (target
`https://router-api-testnet.integratenetwork.work/v1`, model `qwen/qwen2.5-omni-7b`) and will
run automatically the moment a real Router key is placed in `.env` — it was not exercised
this session because no key exists and none was fabricated.

### T0.2 verdict: **PASS (offline mode only — live mode blocked, see below)**

**Blocked item, recorded per instructions:** live Router-testnet streaming comparison could
not be run because no `ZEROG_API_KEY`/`ROUTER_API_KEY` was available in `.env`. Everything
unblocked (API-shape verification, `tee()`/`finalChatCompletion()` equivalence, SSE parsing)
was completed and passed. Phase 1 should re-run `c4-streaming.mjs` live once a Router key is
provisioned — no code changes should be needed, it self-selects live mode when the key is
present.

## 3. mem0ai/oss API mismatches vs. assumptions, found by reading installed source directly

Verified against `spike/node_modules/mem0ai/dist/oss/index.mjs` (v3.1.1), not against
research docs or training data, per instructions.

1. **No custom-provider registration path in `VectorStoreFactory`.** The installed factory
   is a closed `switch` over string literals ending in `default: throw new Error(...)`; the
   `VectorStoreConfig.instance?: any` field is never read anywhere in the compiled code. The
   documented/assumed extension point does not exist in this version. **Workaround used:**
   after `Memory` finishes async init, swap `memory.vectorStore = new
   JournalingVectorStore(memory.vectorStore)` at runtime — safe because TS `private` class
   fields compile to ordinary mutable JS properties. Phase 1 should treat "journaling
   wrapper via post-init property swap" as the supported pattern for this library version,
   not a custom-provider registration.

2. **`process.exit()` crashes after using the fastembed embedder.** Native
   onnxruntime-node teardown raises `libc++abi: terminating due to uncaught exception ...
   mutex lock failed: Invalid argument` (SIGABRT, exit 134) if `process.exit()` is called.
   **Fix:** always set `process.exitCode = N` and let the script return naturally.

3. **Telemetry requires a specific init order.** `mem0ai/oss` fires real PostHog `fetch()`
   calls during `add()`/`search()` unless `MEM0_TELEMETRY` is read as `'false'` at module
   evaluation time. Because the module reads the env var at eval time, `process.env.
   MEM0_TELEMETRY = 'false'` must precede a **dynamic** `await import('mem0ai/oss')` — a
   static top-of-file import is hoisted above any same-file assignment and telemetry stays
   on regardless of where the assignment appears in source order.

4. **Delta-encoding size bug (found live during Step 2, fixed).** Journaling raw JSON float
   arrays for embedding vectors made a 48-memory delta ~530,124 bytes — *larger* than the
   181,647-byte full checkpoint covering the same data, because `MemoryVectorStore` itself
   stores vectors as compact binary BLOBs (`Buffer.from(new Float32Array(vec).buffer)`), not
   JSON. **Fix:** pack/unpack vectors as base64-encoded `Float32Array` bytes in the journal
   (`packVector`/`unpackVector`), mirroring the native store's own on-disk format. After the
   fix, the equivalent delta dropped to 135,519 bytes (batch A) and 33,697 bytes (batch B).
   **Lesson for Phase 1:** any custom delta/journal encoding must match the native vector
   store's binary format, or "deltas" can silently balloon past full-snapshot size.

5. **0G SDK's finality-wait has no timeout (operational risk, not an API mismatch per se).**
   `@0gfoundation/0g-ts-sdk`'s `Uploader.waitForLogEntry()` is an unbounded `while(true)`
   loop (1s poll interval, no max-retry cap) waiting for `info.finalized === true`. The
   oversized 530KB delta from finding #4 above caused a real run to hang in this loop for
   24+ minutes before it was killed. **Phase 1 should wrap `indexer.upload()` calls in an
   application-level timeout/circuit-breaker** rather than trusting the SDK to give up.

## 4. Disclosure: killed first attempt at `c3-mem0-loop.mjs`

The first run (before the fix in §3.4) completed Step 1 successfully (checkpoint uploaded,
verified restore, parity passed) then stalled in Step 2 uploading the oversized 530,124-byte
delta A, stuck in the SDK's unbounded finality-wait loop (same `dataMerkleRoot` reported for
24+ minutes with no progress). It was killed (`kill`, then `kill -9`) after confirming no
`c3-results.json` had been written (i.e., it was genuinely stuck, not finished). Its on-chain
spend (checkpoint + the delta-A tx that had already landed before the kill) is included in
the wallet accounting in §0. The bug was fixed and the script was re-run to a clean pass
(the run reported throughout this document).

## 5. T0.3 — K tuning (checkpoint cadence)

### Inputs (all measured, this session)

- Cold process start + `mem0ai/oss` import + fastembed `Memory` construction + init, measured
  standalone in a fresh Node process (median of 3 runs): **~0.32 s** (range 0.31–0.42 s).
- Pointer resolution (`eth_getLogs` scan, needed **once per restore, regardless of K**, since
  only the latest blob needs on-chain resolution — ancestors are fetched by known
  `prevRootHash`): measured **1.13 s** and **1.71 s** across the two runs → use **1.7 s**
  (conservative/upper bound) for budget arithmetic.
- Checkpoint blob (181,647 bytes / 48 memories) download + verify + decrypt: 2,976.36 +
  16.27 + 0.73 = **~3.0 s**.
- Per-delta blob download + verify + decrypt, averaged over the 2-delta chain: (3,617.96 +
  26.36 + 1.14) / 2 = **~1.82 s/delta**. Notably flat despite a ~4x byte-size difference
  between delta A (135,519 B) and delta B (33,697 B) — at these blob sizes, restore time is
  dominated by per-request round-trip latency to 0G storage/indexer nodes, not transfer
  bandwidth.
- Replay/data-apply: ~190 ms (48 items) to ~268 ms (60 items) — a small, slowly-growing term
  (~3–4 ms/item) once the fixed Memory-construction cost is already counted above.

### Model

```
ColdRestoreTime(K) ≈ 0.35s (process+import overhead)
                    + 1.7s  (pointer resolve, flat, once per restore)
                    + 3.0s  (checkpoint download+verify+decrypt, flat)
                    + K × 1.8s (per-delta download+verify+decrypt, flat per blob)
                    + 0.25s (replay, small/slow-growing)

           ≈ 5.3 + 1.8K   seconds
```

### Budget check against Phase 0's three target consumers

| Consumer | Budget | K that fits | Arithmetic |
|---|---|---|---|
| Hermes | 3 s soft cap | **none** | Even K=0 (checkpoint-only restore, no deltas) is ≈5.3 s — already **2.3 s over budget** before any delta is applied. This restore path cannot meet Hermes' hook budget at any K. |
| Codex | 12 s hard cap | K ≤ 3 | K=3: 5.3+5.4=10.7 s (1.3 s margin). K=4: 5.3+7.2=12.5 s — over the 12 s hard cap. |
| Claude Code (`UserPromptSubmit`) | 10–30 s | K ≤ 2 at the 10 s floor; K ≤ 13 at the 30 s ceiling | K=2: 5.3+3.6=8.9 s (1.1 s margin under the 10 s floor). |

### Recommendation

**K = 2** (checkpoint every 2 deltas) is the cross-environment-safe choice: it clears both
Codex's 12 s hard cap (8.9 s, 3.1 s margin) and Claude Code's tighter practical 10 s floor
(8.9 s, 1.1 s margin). K=3 is viable if only Codex's 12 s cap needs to be met (10.7 s, 1.3 s
margin) but leaves too little margin under Claude Code's 10 s floor.

**Hermes cannot be served by this synchronous restore path at any K** — this is the single
most important Phase 1 design input from Phase 0. Options for Phase 1 to evaluate:
(a) keep a warm, already-restored in-memory copy resident between hook invocations instead of
cold-restoring every time; (b) cache the resolved pointer/`rootHash` locally so the ~1.7 s
`eth_getLogs` scan is only paid on cache-miss, not every call; (c) treat 0G-Storage-backed
restore as async/prefetched ahead of the 3 s window rather than synchronous within it.
Caching the pointer alone would bring checkpoint-only restore to ~3.6 s — still over Hermes'
3 s cap, so (a) or (c) are the more promising directions.

### T0.3 verdict: **PASS** (K chosen with full supporting arithmetic; Hermes infeasibility at
any K is flagged as a required Phase 1 design input rather than treated as a spike failure)

## 6. Summary verdict table

| Task | Verdict | Notes |
|---|---|---|
| T0.1 (mem0 ↔ 0G-Storage round trip) | **PASS** | Snapshot + journal modes both round-trip with parity; balance before/after measured; quality spot-check done |
| T0.2 (streaming comparison) | **PASS (offline)** / blocked (live) | No Router key in `.env` — not invented per instructions; offline synthetic SSE comparison fully passed; live re-run is a zero-code-change follow-up once a key exists |
| T0.3 (K tuning) | **PASS** | K=2 recommended with arithmetic; Hermes flagged as unserviceable by synchronous restore at any K — Phase 1 design input |
