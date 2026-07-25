# dMemo benchmarks (T5.2)

LoCoMo benchmark harness shim + flush/restore invariance runner. This directory is
deliberately **not** a pnpm workspace member (see root `pnpm-workspace.yaml`) — it installs
its own `node_modules` via plain `npm install` so `pnpm -r build` / `pnpm -r test` never touch
it, and it consumes `@dmemo/core` via a relative `../../packages/core/dist/index.js` import
(build core first: `pnpm --filter @dmemo/core build`, or `pnpm -r build` from the repo root).

Full protocol, results, and qualifiers: `docs/benchmarks.md` → "## LoCoMo benchmark".

## What's here

- `shim/server.mjs` — a plain `node:http` server exposing exactly the two routes the
  `mem0ai/memory-benchmarks` harness's `Mem0Client(mode="oss", host=...)` talks to, backed by
  one `@dmemo/core` `DmemoSession`. Also runnable standalone: `node shim/server.mjs`.
- `scripts/run-locomo.mjs` — the T5.2 orchestrator: funds an ephemeral wallet, ingests
  LoCoMo-10 through the shim, runs the harness `--predict-only`, flushes to 0G testnet, wipes
  all local state, restores into a fresh session behind the same shim, re-runs
  `--predict-only`, and diffs the two passes for exact invariance.
- `scripts/dry-run-shim-smoke.mjs` — minimal manual smoke check: opens a session, starts the
  shim on port 8901, and idles (used during development to hit the shim by hand with `curl`).

## Wire contract (verified against the cloned harness source)

Verified live against `mem0ai/memory-benchmarks` (Apache-2.0), commit at the time of writing
tagged `feat(results): update Mem0 Platform benchmark results with v3 + temporal reasoning
(#8)` (`4b61c5d`), files `benchmarks/common/mem0_client.py` and `benchmarks/locomo/run.py`:

- `Mem0Client._add_oss()` (`mem0_client.py`) posts `{host}/memories` with a JSON body
  containing `messages`, `user_id`, `timestamp`, `metadata`, `custom_instructions` and expects
  back whatever `response.json()` returns — the harness itself only reads `.get("results",
  [])` from it for debug logging, so `{results: [...]}` satisfies it.
- `Mem0Client._search_oss()` posts `{host}/search` with `{"user_id", "query", "limit": top_k,
  "rerank"}` — **the wire field is `limit`, not `top_k`**, even though the Python-side
  parameter is named `top_k` (`mem0_client.py:255-269`). The shim reads `limit ?? top_k` to be
  defensive either way.
- The client accepts either a bare array or a `{results: [...]}` envelope for `/search`
  (`data.get("results", data) if isinstance(data, dict) else data`) — the shim returns the
  envelope form.
- Per-question output files land at `{output-dir}/predicted_{project-name}/{qid}.json` where
  `qid = f"conv{conv_idx}_q{qi}"` (`run.py` ~L900). Ingestion/question checkpoint bookkeeping
  files in the same directory are always prefixed `_` (`_ingestion_*.json`, `_progress_*.json`,
  `_checkpoint_*.json` — `benchmarks/common/utils.py`), which is what lets
  `run-locomo.mjs`'s `copyQuestionResults()` cheaply distinguish real per-question results from
  bookkeeping via a `!f.startsWith('_')` filter.
- Ingestion is resumed/skipped per-conversation via `IngestionCheckpoint.is_complete()`
  keyed on `(conv_idx, chunk_size)` inside the same `--output-dir`/`--run-id` — this is what
  lets pass 2 of the orchestrator (post-restore) skip re-ingesting while still re-running every
  question's `/search` call fresh (question-level checkpointing only kicks in with `--resume`,
  which the orchestrator never passes).

### Live finding: `timestamp` is a cloud-only mem0ai feature

`mem0ai@3.1.1`'s OSS `Memory.add()` throws `"The timestamp parameter is not supported by the
OSS Memory SDK."` for **any defined** `timestamp` value (checked via `!== undefined`, so even
explicit `null` throws) — see `mem0ai/dist/oss/index.js` around the
`TEMPORAL_TIMESTAMP_PLAIN_ERROR` constant. The harness always sends an epoch `timestamp` per
LoCoMo session turn, so naively forwarding it made every single `/memories` call fail. The shim
never forwards `timestamp` to `add()`; it's preserved as plain `metadata.locomoSessionTimestamp`
instead (inert, no special SDK handling). Practical effect: memories are timestamped with real
ingestion wall-clock time, not the original (often months-apart) LoCoMo session dates. This has
no effect on the T5.2 invariance test (pure search-result diffing, timestamp-independent) but
would matter for the skipped `--evaluate-only` judged pass, particularly LoCoMo category 4
("temporal reasoning").

## Running it

Requires, none of which are committed to this repo:

1. A local clone of `mem0ai/memory-benchmarks` (Apache-2.0) with its Python dependencies
   installed (`pip install -r requirements.txt` inside a venv — see its own `README.md`; only
   `aiohttp`, `aiolimiter`, `openai`, `anthropic`, `pydantic`, `python-dotenv`, `requests`,
   `tqdm` are needed for `--predict-only`, no local Mem0 install required since we replace it
   with the shim).
2. The LoCoMo-10 dataset (`datasets/locomo/locomo10.json` inside that clone) — the harness's
   own `run.py` auto-downloads it from the upstream `snap-research/locomo` GitHub mirror if
   missing. **CC BY-NC 4.0** — benchmarking against it is fine, redistributing it is not; it
   must never be copied into this repo.
3. `packages/core` built (`pnpm --filter @dmemo/core build` from repo root).
4. `spike/.env` present (`PRIVATE_KEY`/`ADDRESS`/`RPC`/`INDEXER` for a **testnet-only** funded
   wallet) — the orchestrator uses it only to fund a brand-new ephemeral throwaway wallet
   (gotcha 18: one wallet = one flush chain) via one signed transfer; the funding key itself is
   never read into the ephemeral session and never logged.

```
DMEMO_BENCH_HARNESS_DIR=/path/to/memory-benchmarks \
DMEMO_BENCH_PYTHON=/path/to/memory-benchmarks/.venv/bin/python \
node scripts/run-locomo.mjs
```

Output: `benchmarks/results/summary.json` plus `benchmarks/results/checkpoints_{pre,post}/`
(the per-question result files from both predict-only passes, kept for inspection — these
contain only LoCoMo-derived memory text/ids, already public/benchmarking-permitted content, not
raw dataset redistribution).

## What's deliberately NOT done here

Per `TASKS.md` T5.2 step 6: the judged `--evaluate-only` pass (headline accuracy %) requires an
0G Router **testnet** `sk-` key, which does not exist yet (see Phase 2 outcome in `TASKS.md`).
We do not invent one, substitute a different LLM judge, or fake the number — the judged
percentage is reported as **pending** until that key exists. The live testnet model catalog
(`GET {router}/v1/models`, no auth) was re-checked as part of this task; see
`docs/benchmarks.md` for the result.
