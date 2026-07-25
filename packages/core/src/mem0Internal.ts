import type { VectorStore } from 'mem0ai/oss';

/**
 * mem0ai/oss's `Memory` class declares `vectorStore`, `db`, `embedder`,
 * `config`, `_initPromise`, and `_initError` as TypeScript `private` fields
 * (see mem0ai's `dist/oss/index.d.ts`). It is a plain class with no `#`
 * private fields, so TS privacy is erased at runtime — property
 * substitution (gotcha 11) works fine in JS (proven live in
 * `spike/c3-mem0-loop.mjs`). In TypeScript we need one explicit, narrow cast
 * to surface those fields as a typed shape instead of reaching for `any`
 * everywhere they're touched.
 *
 * The in-RAM history manager (mem0's `'memory'` historyStore provider) is
 * not exported as a named type at all — only its shape (`Map<string,
 * HistoryEntryTuple>` under `.memoryStore`) is known from spike behavior —
 * so `HistoryBackedManager` is a minimal structural type for it.
 */
export interface HistoryBackedManager {
  memoryStore: Map<string, unknown>;
  close(): void;
}

export interface MemoryInternals {
  vectorStore: VectorStore;
  db: HistoryBackedManager;
  embedder: { embed(text: string): Promise<number[]> };
  config: { embedder: { provider: string; config: Record<string, unknown> } };
  _initPromise: Promise<void>;
  _initError?: Error;
}

/** Narrow, single-purpose escape hatch for mem0's runtime-mutable-but-
 * TS-private fields. Every access to these fields in dmemo/core must go
 * through this function so the "why" stays documented in one place. */
export function internals<T extends object>(memory: T): MemoryInternals {
  return memory as unknown as MemoryInternals;
}
