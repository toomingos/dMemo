# dMemo Benchmarks

## Latency & cost (testnet, July 2026)

Source: `packages/integration-tests/` (T5.1 live-testnet integration tests + T5.3's
`scripts/collect-latency-samples.mjs`), run against testnet Galileo (chain `16602`) on
2026-07-25. All numbers are wall-clock, live-network measurements from ephemeral wallets
funded from `spike/.env` — no mocks, no local node. 66 timing samples were recorded to
`packages/integration-tests/results/latency-samples.jsonl` between 13:51 and 14:23 UTC
that day; raw per-sample data (and the parallel spend accounting in `results/spend-log.jsonl`)
is preserved there for reproducibility. Testnet public RPC/storage-node latency varies
run-to-run (shared infra, no SLA) — treat these as representative, not guaranteed, figures.

### Session-open (restore) latency vs host budgets

"Restore" = `DmemoSession.open()` end-to-end: resolve pointer (`eth_getLogs`) → download →
Merkle self-verify → decrypt → replay into a fresh mem0 store. Two regimes were measured:

- **Cold**: no pointer-cache entry for the wallet — forces the paginated `eth_getLogs` scan
  (gotcha: ~4.78M-block range cap, halve-and-retry). This is the realistic worst case for a
  brand-new machine/session (e.g. a host's very first invocation, or after any local-state wipe).
- **Warm**: pointer cache already holds an entry for the wallet (populated by a prior
  `resolveCandidates()`/`upload()` in the same process or a persisted cache file) — skips the scan.

| Regime | n | P50 | P95 | min | max |
|---|---|---|---|---|---|
| Cold restore (no pointer cache) | 5 | 3.00s | 4.03s | 2.73s | 4.03s |
| Warm restore (pointer cache hit) | 19 | 3.42s | 8.31s | 2.67s | 8.31s |
| Fresh session (new wallet, nothing to restore yet) | 4 | 3.13s | 3.26s | 3.11s | 3.26s |
| **All restores combined** | **28** | **3.42s** | **6.36s** | **2.59s** | **8.31s** |

vs host budgets:

| Host / hook | Budget | Cold P95 (4.03s) | Warm P95 (8.31s) |
|---|---|---|---|
| Claude Code `SessionStart` | 30s | PASS (7.5x headroom) | PASS (3.6x headroom) |
| Claude Code `UserPromptSubmit` | 10s | PASS | PASS |
| Codex (hook install budget) | 12s | PASS | PASS |
| OpenClaw `before_prompt_build` | 10s | PASS (measured live: 2.85s, see below) | PASS |
| **Hermes** (prefetch, soft) | **3s** | **FLAG — unmeetable at P95** (cold P50 3.00s already at the line; P95 4.03s exceeds it) | **FAIL** |

Hermes' 3s soft budget was already flagged unmeetable synchronously at any checkpoint cadence
K in Phase 0 (`TASKS.md` Phase 0 outcome: "restore model ≈5.3 + 1.8K seconds ... Hermes 3s cap
is unmeetable at any K"). These live T5.1/T5.3 numbers confirm it in production code, not just
the spike model: even the fastest observed cold restore (2.73s) leaves near-zero margin, and
P50/P95 both exceed 3s. v1.1 Hermes needs a warm cache kept resident or async prefetch — never
a synchronous cold restore on the request path.

Live host-level corroboration (from the T5.1 host smoke tests, real hook subprocesses, not the
raw `DmemoSession.open()` micro-benchmark above — includes host framework overhead):

| Host hook | Measured (this run) | Budget | Result |
|---|---|---|---|
| node-adapter `session-start.cjs`, cold (post full local-state wipe) | 3.54–4.03s | Claude Code `SessionStart` 30s | PASS |
| node-adapter `user-prompt-submit.cjs` (turn N+1 recall) | 4.48–4.60s | Claude Code `UserPromptSubmit` 10s | PASS |
| node-adapter `stop.cjs` (capture + flush) | 12.4–17.1s | (Stop has no hard host budget; recorded for completeness) | n/a |
| opencode-plugin cold restore (session2 open, `live-integration.mjs`) | ~2.3s (Phase 3) / re-confirmed passing this run | (opencode has no fixed SessionStart-equivalent budget) | PASS |
| openclaw-plugin `before_prompt_build` restore | 2.85s (Phase 3) / re-confirmed passing this run | OpenClaw `before_prompt_build` 10s (raised from a lower default per Phase 3 finding) | PASS |

### Flush latency and cost per turn

| Flush kind | n | P50 duration | P95 duration | Median cost |
|---|---|---|---|---|
| Delta flush | 22 | 9.84s | 13.06s | 0.00121 0G |
| Checkpoint flush (K-consolidation) | 12 | 11.40s | 14.20s | 0.00121 0G |

Both flush kinds cost essentially the same (~0.0012 0G, matching the Phase 0/Global-constants
figure of "≈0.00125 0G total, gas-dominated, storage fee negligible ≤256KB") — checkpoint
flushes are not meaningfully more expensive despite carrying the full consolidated state,
confirming gas dominates over storage fee at these blob sizes (3–6KB observed). Two `flush-delta`
samples recorded `costWei: 0` (see `results/latency-samples.jsonl`, `test: latency-collector`,
bytes=3287) — an observed anomaly, not reproduced on any correctness-asserting test; excluded
from the cost figures above (median computed over the other 18/20 non-zero samples). Not
investigated further as it did not affect any PASS/FAIL assertion.

Duration (9–14s) is dominated by 0G's `waitForLogEntry()` polling for storage-node sync
(gotcha: this call retries unboundedly with no SDK-side timeout — every upload in
`@dmemo/core` wraps it in the mandated 120s application-level timeout). Per-turn cost at
typical conversational cadence (one flush every few turns, per the checkpoint-consolidation
K setting) is well under $0.01-equivalent at any plausible 0G/USD rate discussed in prior
phases.

### Methodology notes / caveats

- Samples span both dedicated timing runs (`collect-latency-samples.mjs`, 10 flush + 10 restore
  in one continuous session) and incidental timings recorded by the T5.1 correctness tests
  (pointer, crash-recovery, checkpoint-consolidation, host smoke tests) — pooling both gives
  more samples per bucket than any single script alone, at the cost of mixing slightly
  different scenarios (fresh vs. long-lived wallets, sequential vs. same-process reopens)
  within the "warm" bucket. Where it mattered (Hermes flag, cold-vs-warm host-budget row) the
  strictest, most conservative (cold) numbers were used.
- All figures are single-day, single-region (whichever GCP zone the public testnet RPC/indexer
  routed to) measurements. Testnet storage-node latency is not representative of a dedicated
  mainnet deployment's tail latency and should be re-measured before any SLA commitment.

## LoCoMo benchmark

<!-- T5.2 owner: fill this section in. Do not remove this heading or the
     placeholder note below — the latency section above is filled and owned
     by T5.1/T5.3; this section is reserved for the LoCoMo + flush/restore
     invariance benchmark results per TASKS.md T5.2. -->

_Placeholder — results pending from the T5.2 LoCoMo benchmark task._
