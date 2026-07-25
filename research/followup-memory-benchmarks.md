# Memory Benchmarks Follow-up (dMemo)

Scope: find an **open-source, runnable** long-term-memory benchmark to validate dMemo's core
claim — memories added via mem0 OSS (TS, local fastembed embeddings, SQLite vector store),
flushed as an encrypted blob to 0G storage, restored in a later session, retrieval quality
identical before/after. Priority: something that gives a **credible, comparable number** on a
**hackathon budget** (time + LLM-judge $). All repos/licenses/READMEs fetched live this session
(`gh api`, raw.githubusercontent.com) — nothing here is from training-data memory.

## a) Candidate matrix

| Benchmark | Repo | License | Size | Judge cost | Adapter to custom backend | Hackathon fit |
|---|---|---|---|---|---|---|
| **LoCoMo** (via mem0's own harness) | [`mem0ai/memory-benchmarks`](https://github.com/mem0ai/memory-benchmarks) (harness) + [`snap-research/locomo`](https://github.com/snap-research/locomo) (dataset) | Harness: **Apache-2.0**. Dataset: **CC BY-NC 4.0** (noncommercial) | 10 convos, ~1,986 QA total, ~300–385 used per standard protocol (categories 1–4; category 5 "adversarial" excluded) | 2 LLM calls/question (answer+judge); pluggable OpenAI/Anthropic/Azure/OpenAI-compatible — **not locked to GPT-4o** | REST-shaped (`POST /memories`, `POST /search`) against a Mem0-server-shaped API — see §c | **Best** — see §d |
| **LongMemEval** | [`xiaowu0162/LongMemEval`](https://github.com/xiaowu0162/LongMemEval) (raw) + reproduced in `mem0ai/memory-benchmarks` | MIT | 500 Qs, 3 variants (S/M/Oracle); M variant ≈500 sessions/instance — heavy | GPT-4o judge (`evaluate_qa.py`); via mem0 harness, same pluggable `LLMClient` | Raw repo: hardcoded to its own retrievers (BM25/Contriever/Stella/GTE) — no clean adapter, would need to fork retrieval code. **Via `mem0ai/memory-benchmarks`: same seam as LoCoMo** (see §c) | Good via mem0 harness; **skip the raw repo** (too coupled) |
| **BEAM** (ICLR 2026) | [`mohammadtavakoli78/BEAM`](https://github.com/mohammadtavakoli78/BEAM) (paper repo) + `mem0ai/memory-benchmarks/benchmarks/beam` | Not checked on raw repo; harness copy is Apache-2.0 | 100 convos × 4 size buckets (128K/500K/1M/10M tokens), 2,000 probing Qs, 10 ability types | Rubric/nugget scoring (0/0.5/1) + Kendall-τ for ordering — more judge calls per item than LoCoMo | Same mem0-harness seam as LoCoMo/LongMemEval | Too big/slow for a hackathon (multi-million-token ingest); interesting post-hackathon |
| **MemBench** (ACL 2025 Findings) | [`import-myself/Membench`](https://github.com/import-myself/Membench) | MIT | Factual + reflective memory × participation/observation, 0–100k+ token noise-extendable | Unclear from README — not fully specified | No documented adapter; own harness/format, `makenoise.py` for data gen only | Interesting axis (reflective vs factual) but under-documented eval path; not worth hackathon time |
| **GoodAI LTM Benchmark** | [`GoodAI/goodai-ltm-benchmark`](https://github.com/GoodAI/goodai-ltm-benchmark) | Other (custom, check before redistribution) | Task-based (needle-in-haystack style tasks interleaved in one long conversation), configurable length | LLM-graded per task, multiple tasks × models — costly, no fixed small count | Built around a `LTMAgentWrapper`/custom agent interface, not a memory-store adapter — would need to wrap dMemo as a full "agent," more work than a memory-backend shim | Skip for hackathon — bigger integration surface |
| **Letta/MemGPT DMR** | No standalone open repo found; original benchmark code referenced at memgpt.ai, not independently runnable today | N/A | Single-task recall benchmark, small | N/A | N/A — not a maintained, pluggable open harness | **Not viable** — treat as historical reference only (93.4% MemGPT number is old, not reproducible standalone) |
| **mem0's own eval harness** | Same as LoCoMo row — `mem0/evaluation/` is now a **git submodule pointing at `mem0ai/memory-benchmarks`** | Apache-2.0 | — | — | — | This **is** the LoCoMo row; confirms mem0's published LoCoMo/LongMemEval numbers are reproducible from this exact repo |
| **Zep's LoCoMo numbers** | [`getzep/zep-papers` issue #5](https://github.com/getzep/zep-papers/issues/5) | N/A (not a benchmark, a dispute) | — | — | — | **Cautionary reference, not a candidate** — see §b |
| **MemoryAgentBench** (ICLR 2026) | [`HUST-AI-HYZ/MemoryAgentBench`](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | MIT | 4 competencies (Accurate Retrieval, Test-Time Learning, Long-Range Understanding, Conflict Resolution); reformulated existing sets + 2 new (EventQA, FactConsolidation) | GPT-4o judge on some sub-tasks (LongMemEval/InfBench-derived) | No documented clean adapter — integration is per-task via bash scripts/config, evaluates Cognee/Letta/Mem0/HippoRAG/long-context baselines directly | Broadest/most rigorous 2026 benchmark but heaviest integration lift — not a hackathon pick |
| **MSC (Multi-Session Chat)** | Meta/ParlAI dataset, no purpose-built eval harness found | Meta research license | Multi-session open-domain chat, shallow dependencies (short sessions) | — | — | Ruled out — shallow, no fact-recall QA ground truth suited to a "recall %" number |
| **PerLTQA** | [`Elvin-Yiming-Du/PerLTQA`](https://github.com/Elvin-Yiming-Du/PerLTQA) | "Other" (custom research license), 5 stars, low activity | 8,593 Qs / 30 characters, semantic+episodic memory | Not documented in accessible form | No documented adapter | Ruled out — thin maintenance, no visible runnable eval harness |

## b) The Zep/mem0 LoCoMo dispute — why it matters for us

`getzep/zep-papers` [issue #5](https://github.com/getzep/zep-papers/issues/5): mem0 challenged
Zep's published 84%/65.99% LoCoMo accuracy and, re-running with corrected protocol, got **58.44%
± 0.20** instead. Root causes: (1) Zep's numerator included category-5 "adversarial" questions
while the denominator excluded them — protocol says exclude category 5 entirely; (2) Zep changed
the system/retrieval prompt vs. the baseline others used; (3) single run reported, not the
10-run-averaged protocol others followed. **Direct implication for dMemo**: when we report a
LoCoMo number, we must (a) explicitly state whether category 5 is included, (b) use the harness's
default prompts unmodified, (c) either run multiple seeds or clearly label a single run as such,
and (d) state the answerer/judge model — all of which the `mem0ai/memory-benchmarks` harness does
for us by default (it's literally the repo mem0 used to produce the corrected numbers).

## c) How `mem0ai/memory-benchmarks` actually plugs into a memory backend

This is the harness mem0's `evaluation/` directory now points to (as a git submodule — confirmed
via `gh api repos/mem0ai/mem0/contents/evaluation`, `type: submodule`, `submodule_git_url:
https://github.com/mem0ai/memory-benchmarks`). It is **not** an abstract "any vector store" plugin
system — `benchmarks/common/mem0_client.py`'s `Mem0Client` talks a fixed REST contract to either
(a) a self-hosted Mem0 OSS server (`docker/mem0/main.py`, FastAPI + Qdrant) or (b) `api.mem0.ai`
(cloud). The contract is small and fully observed from source:

- `POST {host}/memories` — body `{"messages": [...], "user_id": ..., "timestamp"?, "custom_instructions"?, "metadata"?}` → `{"results": [...]}`
- `POST {host}/search` — body `{"query": ..., "user_id": ..., "top_k": 200, "rerank": false}` → list of `{"memory": str, "score": float, "id": str, "created_at"?, "updated_at"?, "score_debug"?}`

**Integration path for dMemo (recommended)**: write a ~50-line local shim server (Express/Fastify)
exposing exactly these two routes, backed by dMemo's existing mem0-ts OSS `add()`/`search()`
calls, and point `Mem0Client(mode="oss", host="http://localhost:<port>")` at it via
`--mem0-host`. Nothing else in the Python harness needs to change — checkpointing, category
breakdown, top-k-cutoff sweep, and the results UI all work unmodified. This is dramatically less
work than the raw `LongMemEval` repo's retrieval code, which would need to be forked to swap in a
custom retriever.

The harness also exposes exactly the seam we need for the flush/restore test:
`--predict-only` stops after the **search** stage (no LLM answer/judge calls — free, deterministic
given fixed embeddings) and `--evaluate-only` resumes from a saved search-stage checkpoint to run
answer+judge later. Per-question checkpoints live at
`{checkpoint_dir}/_checkpoint_{question_id}.json` (`benchmarks/common/utils.py: Checkpoint`),
so a `--predict-only` run's retrieved-memories JSON can be diffed directly, file-for-file, against
a second `--predict-only` run after flush/restore.

`LLMClient` (`benchmarks/common/llm_client.py`) supports `provider="openai" | "anthropic" |
"azure"`, or any OpenAI-compatible `base_url` — so the answer/judge stage can run on Claude
(Haiku/Sonnet) instead of GPT-4o if that's the cheaper/available credit pool, at the cost of not
being bit-for-bit the same judge mem0 used for their published 92.5%/94.4% numbers (label this
clearly; it doesn't affect the flush/restore invariance claim, only the absolute headline %).

## d) Recommendation

**1. Best benchmark: LoCoMo, run through `mem0ai/memory-benchmarks`.**
It's mem0's own published-numbers harness (direct comparability — dMemo literally runs the same
mem0 OSS engine underneath), Apache-2.0, small (10 conversations), fast to ingest, and has the
exact `--predict-only`/`--evaluate-only` split needed for a clean invariance test. LongMemEval via
the same harness is a good second data point if time allows (same integration cost, since the shim
server built for LoCoMo works unmodified — `Mem0Client` is shared code). Skip BEAM (too large/slow
for a hackathon), MemBench/GoodAI/PerLTQA (weak or absent runnable eval harness), and MemGPT DMR
(no independently runnable open repo left).

**2. Minimal hackathon protocol:**
- Use all 10 LoCoMo conversations (small enough — no need to subsample conversations), categories
  1–4 only (exclude category 5 "adversarial" per standard protocol, per the Zep lesson above).
- Single `top-k` value (e.g. 20) instead of the default 10/20/50/200 sweep — cuts eval-stage LLM
  calls ~4x with no loss to the headline claim.
- Answerer + judge: pick one accessible model (Claude Haiku/Sonnet via `provider=anthropic`, or
  `gpt-4o-mini`), same model for both runs being compared. Expect roughly **300–400 questions ×
  2 calls (answer+judge) ≈ 600–800 small LLM calls** for one full end-to-end run — cheap and fast
  (minutes, low single-digit dollars on a mini/haiku-class model).
- Report the number as: "**N% recall on LoCoMo (categories 1–4, top-k=20, judge=<model>), dMemo
  running mem0 OSS locally**" — with the model and protocol stated, avoiding the Zep pitfall.

**3. Flush/restore invariance test design (this is the cheap, decisive part):**
1. Build the `/memories` + `/search` shim (§c) wrapping dMemo's mem0-ts OSS instance.
2. Ingest LoCoMo-10 into dMemo through the shim (`benchmarks.locomo.run --predict-only`, no LLM
   cost — this alone is the retrieval-quality proof surface).
3. Save the resulting per-question search-stage checkpoints (retrieved memory IDs + text + scores,
   deterministic given fixed local embeddings + SQLite store).
4. Flush: encrypt dMemo's SQLite vector store + memory table, upload the blob to 0G storage, wipe
   local state.
5. Restore: download + decrypt + rehydrate the SQLite store into a fresh dMemo instance behind the
   same shim.
6. Re-run `--predict-only` over the identical question set.
7. **Assert**: the two checkpoint sets are identical (exact memory-ID sets and scores per
   question) — this is a deterministic, zero-LLM-cost diff, so it can be run as many times as
   needed without judge-cost or judge-non-determinism getting in the way.
8. Run the full answer+judge pipeline (`--evaluate-only`) **once**, on the post-restore state, to
   produce the single headline "X% LoCoMo recall" number — and report it as "identical
   before/after encrypted flush/restore" backed by the exact-match retrieval diff in step 7, not by
   re-running (and re-paying for) the judge twice.

This design gets a real, defensible number and a genuinely strong invariance proof (deterministic
retrieval diff, not two noisy LLM-judged runs) for well under a day of engineering: build shim
(~2–4h) + wire flush/restore around the existing encrypt/upload/download/decrypt path already
built for dMemo (~1–2h glue) + run (~30 min) + write-up.

## e) Effort estimate summary

| Step | Est. hours | Notes |
|---|---|---|
| Build `/memories`+`/search` shim wrapping dMemo mem0-ts OSS | 2–4h | Contract is 2 routes, fields fully known (§c) |
| Wire flush→upload→restore→download around the shim's storage dir | 1–2h | Reuses dMemo's existing 0G encrypt/upload/restore path — no new crypto/storage code |
| Run LoCoMo `--predict-only` ×2 (pre/post) + diff | <1h | Deterministic, zero LLM cost |
| Run one `--evaluate-only` pass for the headline number | <1h | ~600–800 small LLM calls, minutes wall-clock |
| **Total** | **~5–8h** | Fits a hackathon day with margin |

## Sources (fetched live this session)

- [snap-research/locomo](https://github.com/snap-research/locomo) — dataset, `LICENSE.txt` (CC BY-NC 4.0), README
- [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) — README, `benchmarks/common/{mem0_client,llm_client,schema,utils}.py`, `benchmarks/{locomo,beam}/run.py`, `docker/mem0/`
- [mem0ai/mem0 `evaluation/` submodule pointer](https://github.com/mem0ai/mem0/tree/main/evaluation) — confirms it now points at `mem0ai/memory-benchmarks`
- [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) — README, license, eval scripts
- [import-myself/Membench](https://github.com/import-myself/Membench) — README, license
- [GoodAI/goodai-ltm-benchmark](https://github.com/GoodAI/goodai-ltm-benchmark)
- [getzep/zep-papers issue #5](https://github.com/getzep/zep-papers/issues/5) — Zep LoCoMo correction dispute
- [HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) — ICLR 2026, README
- [mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM) — ICLR 2026 BEAM paper repo
- [Elvin-Yiming-Du/PerLTQA](https://github.com/Elvin-Yiming-Du/PerLTQA)
- GitHub API (`gh api repos/.../license`, `.../contents/...`) for license/star/activity verification on all repos above
