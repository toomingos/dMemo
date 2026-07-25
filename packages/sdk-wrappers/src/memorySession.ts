// T2.2 — the narrow slice of `@dmemo/core`'s `DmemoSession` public API that
// the memory wrappers need: `memory.search`/`memory.add` (T1.4's
// `session.memory.search(query, {topK})` / `session.memory.add(messages,
// {infer})` contract — see `core/src/session.ts`'s own usage comment and
// `core/scripts/smoke-testnet.mjs`) plus `flush()`.
//
// This is intentionally a structural interface rather than an import of the
// concrete `DmemoSession` class:
//   - `DmemoSession` has private fields, so TS would require an actual
//     instance (or an `as unknown as` cast) anywhere a fake/mock session is
//     needed for tests — a real `DmemoSession` needs mem0ai + fastembed +
//     better-sqlite3 + pg + a live/mock 0G Storage endpoint just to
//     construct, which is exactly the weight T2.2's unit tests (mock HTTP
//     server only) must avoid.
//   - `@dmemo/sdk-wrappers` therefore has no hard dependency on `@dmemo/core`
//     at all; any object shaped like this (a real `DmemoSession` included —
//     it satisfies this interface structurally) works.
//
// D11 (memory leg must work with zero Router key) and the fail-open
// requirement here compose to: wrappers must also work with **no session at
// all** (`session` omitted/undefined) — see `withFailOpen` in `fetchWrap.ts`.

export interface MemorySearchResult {
  id: string;
  memory: string;
  score?: number;
  [key: string]: unknown;
}

export interface MemoryAddResult {
  id: string;
  memory?: string;
  [key: string]: unknown;
}

export interface DmemoMemorySession {
  readonly memory: {
    search(
      query: string,
      options?: Record<string, unknown>
    ): Promise<{ results: readonly MemorySearchResult[] }>;
    add(
      data: unknown,
      options?: Record<string, unknown>
    ): Promise<{ results: readonly MemoryAddResult[] }>;
  };
  /** Fire-and-forget (D4) — must never be awaited by the wrapper itself. */
  flush(): void;
}

/** Options shared by both the OpenAI-shape (`fetchWrap.ts`) and Anthropic
 * middleware (`anthropicMiddleware.ts`) wrappers. */
export interface MemoryWrapOptions {
  /** The dMemo session to read/write memory through. Omit (or pass
   * `null`/`undefined`) to disable memory entirely — the wrapper then
   * degrades to a transparent passthrough (fail-open, D11). */
  session?: DmemoMemorySession | null;
  /** mem0 `userId` / `user_id` scope for search filters and add() calls.
   * Required whenever `session` is provided. */
  userId?: string;
  /** Number of memories to retrieve per request. Default 5. */
  topK?: number;
  /** Called with the search results and the reduced query text before
   * injection, letting callers customize how memory is rendered into the
   * prompt. Default: a plain-text bullet list under a header, see
   * `renderMemoryBlock` in `inject.ts`. */
  renderMemory?: (results: readonly MemorySearchResult[]) => string;
  /** Swallow (log, don't throw) every memory-path error — search failures,
   * add failures, malformed responses. Default true, matching D11/D4's
   * "memory must never break the host" contract. Set false only for tests
   * that want failures to surface. */
  failOpen?: boolean;
  /** Called on any swallowed error (only relevant when `failOpen` is true,
   * which is the default). Default: `console.warn`. */
  onError?: (stage: 'search' | 'inject' | 'writeback' | 'parse', error: unknown) => void;
}

export function defaultOnError(stage: string, error: unknown): void {
  console.warn(`[dmemo/sdk-wrappers] memory ${stage} failed (fail-open, continuing):`, error);
}
