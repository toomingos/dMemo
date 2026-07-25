# dMemo blob spec — `dmemo/1`

Canonical, language-agnostic (v1.1 target: Python parity) on-chain memory blob format for
dMemo. This is the **only** thing that is ever encrypted and uploaded to 0G Storage — raw
engine/SQLite files are never part of the spec (that was only the Phase-0 stepping stone, see
`spike/RESULTS.md` §1 Step 1 vs Step 2).

## Envelope (`EnvelopeMeta`)

Present on every blob, delta or checkpoint:

```jsonc
{
  "specVersion": "dmemo/1",
  "walletAddress": "0x...",       // author + ECIES recipient
  "agentScope": "claude-code:tomas:project-x",  // host-defined logical scope
  "seq": 3,                        // monotonic per wallet+scope chain
  "prevRootHash": "0x..." | null,  // null == first blob ever for this wallet+scope
  "embedder": { "provider": "fastembed", "model": "fast-bge-small-en-v1.5", "dim": 384 },
  "engine": { "name": "mem0-oss", "version": "3.1.1" },
  "createdAt": "2026-07-25T00:00:00.000Z",
  "createdAtChain": 1234567          // optional, informational only
}
```

`embedder` identity drives re-embed migration (T1.5): if the embedder resolved at session-open
time doesn't match the identity pinned in the latest blob, dMemo re-embeds every stored memory
text with the new embedder and journals the results as `update` ops.

## Record types

### `delta`

An ordered list of vector-store mutations since the last flush, plus any new mem0 history-map
entries created in that window.

```jsonc
{
  "kind": "delta",
  "meta": { ... },
  "vectorOps": [ /* VectorOp[], see below, applied in array order */ ],
  "historyEntries": [ ["<historyId>", { /* HistoryEntryRecord */ }], ... ]
}
```

### `checkpoint`

Full materialized state: every vector row currently in the store, plus the full mem0 history
map. Checkpoints reset the delta chain — restoring from a checkpoint never needs to walk further
back than `meta.prevRootHash` (always `null` for a checkpoint in v1).

```jsonc
{
  "kind": "checkpoint",
  "meta": { ... },
  "vectors": [ { "id": "...", "vector": "<base64 Float32Array>", "payload": { ... } }, ... ],
  "historyEntries": [ ["<historyId>", { /* HistoryEntryRecord */ }], ... ]
}
```

## `VectorOp` union

| `op` | Shape | Meaning |
|---|---|---|
| `insert` | `{ op, ids: string[], vectors: string[], payloads: object[] }` | Batch insert (mirrors mem0 `VectorStore.insert`). `vectors[i]` corresponds to `ids[i]`. |
| `update` | `{ op, id, vector, payload }` | Single-row update. |
| `delete` | `{ op, id }` | Single-row delete. |
| `deleteCol` | `{ op }` | Drop the entire collection (rare — `Memory.reset()`). |
| `tombstone` | `{ op, epoch, tombstonedAt, reason? }` | T1.7 crypto-shred marker. No vector-store side effect on replay; carried through for audit/UX ("unreadable forever"). |

## Vector encoding (gotcha 14)

Embedding vectors are **always** base64-encoded `Float32Array` bytes — `Buffer.from(new
Float32Array(vector).buffer).toString('base64')` — never JSON float arrays. This mirrors mem0's
own native `MemoryVectorStore` on-disk BLOB encoding. A naive JSON-array delta measured 530KB for
48 memories (bigger than the equivalent 181KB full checkpoint); the packed encoding for the same
data measured 135KB. See `src/vector.ts` (`packVector`/`unpackVector`).

## History entries

Mirror mem0-TS's in-process `MemoryHistoryManager` (`Map<string, HistoryEntryRecord>`) `entries()`
tuples 1:1 — restore is a direct `new Map(historyEntries)`. No adapter, no transform (D5).

## Determinism

`encodeBlob()` writes object keys in a fixed order (never relies on JS object insertion order at
the call site) so that encoding the same logical blob twice — including across a future Python
implementation — produces byte-identical JSON. This is required for content-hash stability of the
plaintext prior to encryption and for cross-language parity in v1.1.

## Validation

`decodeBlob()` performs full structural validation and throws `BlobDecodeError` on any mismatch
(unknown `specVersion`, missing fields, wrong types, unknown `vectorOp.op`). Decode failure must be
treated as data corruption or tamper — never silently coerced or defaulted.
