# Research Questions

Edit freely — add, cut, or reword. Each numbered area gets one Opus research agent.
Reports land in `/research/<topic>.md`.

## 1. Memory — Supermemory (`supermemoryai/supermemory`)

> **Superseded (2026-07-25):** answered in `research/supermemory.md` — the engine is closed-source, which triggered the pivot to **mem0 OSS** (`research/mem0.md`, decisions D1/D7). Per-host fork bases re-decided against mem0's first-party integrations in `research/followup-fork-bases.md` (D18).

- What is the architecture: ingestion, chunking/embedding, retrieval, and where does persistent state actually live (which DBs/stores)? Is the storage layer pluggable enough to swap in 0G Storage, or do we port at a higher level?
- Which examples/integrations in the repo target our agent list (Claude Code, Codex, OpenCode, personal agents) and what pattern does each use — proxy (e.g. "infinite chat"), memory tool/function-calling, MCP server, SDK middleware?
- How does the "completion output → automatic memory mutation" flow work in their examples (including streaming responses)?
- What is the minimal subset we'd need to port for fetch-at-runtime + write-back memory (vs. their full product surface)?

## 2. 0G Private Computer (pc.0g.ai / 0G Compute)

- What exactly is the inference API surface: OpenAI-compatible router endpoint? Anthropic-compatible for Claude? Exact base URLs, auth headers, request signing?
- Setup flow: wallet, funding/prepaid balance, broker SDK (`@0glabs/0g-serving-broker`?) — what is the true minimum number of steps, and can it be fully scripted?
- Streaming support, model list, and any TEE/verification steps that alter the normal request/response cycle?

## 3. 0G Storage

- Which primitives exist: log/file storage vs. KV storage — which fits a small, frequently-mutated memory DB? Does 0G-KV support the fetch→update semantics natively?
- Encryption: is it native, or do we encrypt client-side before upload? What's the recommended practice?
- TypeScript SDK surface: upload/download/update functions, latency and cost characteristics for small frequent writes, size limits.
- Minimal environment setup (RPC, indexer, wallet, faucet, testnet vs. mainnet) and whether it's scriptable to near-zero steps.

## 4. SDKs — OpenAI SDK + Anthropic SDK

- Native extension points for injecting fetched memory into requests: custom `fetch`, middleware, `baseURL` override, default headers — what's supported without custom hacks?
- Native ways to intercept the completion output (including streamed) to trigger the write-back mutation?
- Confirmed compatibility patterns with 0G's endpoints (custom baseURL + auth headers)?

## 5. Personal Agents — OpenClaw + Hermes

- What runtime/SDK does each use, and do they support custom model endpoints (to point at 0G inference)?
- What are their native extension mechanisms — plugins, hooks, MCP, memory interfaces — where memory capture + fetch could attach?
- Where does each store memory today, and can that layer be replaced or augmented?

## 6. Coding Agents — Codex, Claude Code, OpenCode

- Custom provider/baseURL support in each (to route inference through 0G)?
- Native memory attachment points: MCP servers, hooks (e.g. Claude Code hooks/skills), OpenCode plugins, Codex config — which lifecycle events let us capture session output for write-back?
- Does supermemory already ship integrations for any of these (e.g. a supermemory MCP), and what do they look like?

## 7. dAI Values & Encrypted Memory Checklist

- What values/principles do the decentralized AI and crypto communities expect from a product like this? Which are table stakes vs. differentiators?
- How do comparable projects in the space implement and communicate these values?
- What must be true — technically and in practice — to legitimately claim "private, encrypted, decentralized memory"? Cover keys, encryption, metadata, verifiability, deletion, and recovery.
- Output: a checkmark table — requirement → why it matters → how it could be satisfied on the 0G stack (or open question).

## Cross-cutting (synthesized by the orchestrator, not a separate agent)

- The Convex-style sync + ephemeral model: whether 0G Storage's latency/consistency supports fetch-at-runtime → in-memory only → discard, with completion output as an automatic mutation — and where the sync engine has to live.

## Open decisions

- Split areas 5 and 6 into one agent per product (8 agents total) for deeper codebase review? (Recommended)
- Testnet or mainnet as the initial 0G target?
