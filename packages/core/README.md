# @dmemo/core

The dMemo core SDK: an embedded `mem0-oss` memory engine journaled to 0G
Storage. Your wallet key doubles as the memory encryption key (ECIES) — no
separate secrets, no external memory service, no API key required for the
memory leg.

## Install

```bash
npm install @dmemo/core
```

Note: this package's dependency tree eagerly imports both `better-sqlite3`
and `pg` at runtime (a `mem0ai/oss` packaging quirk — both are declared as
hard dependencies here so they're always present).

## Usage

```ts
import { DmemoSession } from '@dmemo/core';

const session = await DmemoSession.open({
  privateKey: process.env.DMEMO_PRIVATE_KEY!,
  scope: 'default',
  network: 'testnet', // or 'mainnet'
});

// Deterministic, verbatim capture (no second LLM call) by default:
await session.memory.add([{ role: 'user', content: 'I prefer TypeScript.' }], {
  userId: 'default',
  infer: false,
});

const { results } = await session.memory.search('what language do I prefer?', {
  filters: { userId: 'default' },
  topK: 5,
});

session.flush(); // fire-and-forget; await session.waitForPendingFlush() for observability
await session.close(); // flushes any pending writes, then closes cleanly
```

## What this package does

- **Storage**: uploads/downloads encrypted blobs to/from 0G Storage, always
  self-verifying the Merkle root of downloaded ciphertext against the
  on-chain root (the SDK's own `with_proof` flag is a no-op — never relied
  on here).
- **Journaling**: a `JournalingVectorStore` wrapper around mem0-oss's native
  vector store, recording every mutation as a delta op so it can be
  replayed/flushed independently of the native store's own persistence.
- **Session lifecycle**: delta flushes with periodic checkpoints (K=2 by
  default), an app-level upload timeout/circuit-breaker, and deterministic
  restore-from-chain on `open()`.
- **Local embedder**: no `/embeddings` call ever leaves your machine — the
  0G Compute Router has no embeddings endpoint, so embeddings are always
  computed locally (`fastembed`).
- **Forget**: `forget()` is crypto-shred semantics (epoch-key derivation +
  durable tombstone journaling), not a delete. See
  `../../docs/disclosure.md` for exactly what this does and does not
  guarantee in v1.

## Config

`loadConfigFromEnv()` reads `DMEMO_PRIVATE_KEY` (required),
`DMEMO_NETWORK` (`testnet` default), `DMEMO_INFER`, `DMEMO_CHECKPOINT_K`,
`DMEMO_CHECKPOINT_SIZE_THRESHOLD_BYTES`, `DMEMO_UPLOAD_TIMEOUT_MS`,
`DMEMO_POINTER_CACHE_PATH`, `DMEMO_RPC_URL` / `DMEMO_INDEXER_URL` /
`DMEMO_FLOW_ADDRESS` / `DMEMO_ROUTER_URL` (network overrides), and
`ZEROG_API_KEY` (inference leg only — never read by anything in this
package's storage/session/journal path).

## Disclosure

Before shipping anything user-facing on top of this package, read
[`docs/disclosure.md`](../../docs/disclosure.md) in the monorepo root: it
covers on-chain metadata leakage, key-loss consequences, and the exact
scope of "forget."
