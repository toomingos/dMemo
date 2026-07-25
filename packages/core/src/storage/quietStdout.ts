/**
 * `@0gfoundation/0g-ts-sdk` writes its own progress/debug lines directly to
 * the *host process's* `console.log` — i.e. real stdout — from inside its
 * `Uploader`/`Indexer`/`utils` modules. Confirmed by reading the installed
 * package (v1.2.8) dist directly (`lib.esm` — the build actually resolved
 * by this package's `"type": "module"` + `import { Indexer, ... } from
 * '@0gfoundation/0g-ts-sdk'`), not assumed:
 *   - `indexer/Indexer.js:296` `console.log(\`Getting file locations for root hash: ${rootHash}\`)`
 *   - `indexer/Indexer.js:298` `console.log(\`Found ${locations.length} locations for ${rootHash}:\`, ...)`
 *   - `indexer/Indexer.js:313` `console.log(\`Selected ${selected.length} of ${locations.length} nodes for ${rootHash}\`)`
 *     (these three fire inside `downloadToBlob()`, exactly the noise
 *     reported live in a real hook invocation)
 *   - `indexer/Indexer.js:79-140` (node selection / upload orchestration),
 *     `transfer/Uploader.js` (~25 call sites: "Data prepared to upload",
 *     "Submitting transaction...", "Wait for log entry on storage node",
 *     retry/backoff messages, ...), `utils.js:59,78` (gas-price retry
 *     logging) — all fire inside `indexer.upload()`.
 *
 * No native control exists for any of this — verified, not assumed:
 *   - `Indexer`'s constructor takes only a URL (`constructor(url: string)`,
 *     `types/indexer/Indexer.d.ts`); `upload()`/`downloadToBlob()` accept
 *     no logger/verbosity/silent option in their typings.
 *   - No `debug`, `pino`, or `winston` (or any logging lib) appears in the
 *     SDK's `dependencies`.
 *   - No `process.env` read anywhere in the SDK's dist.
 *   - `open-jsonrpc-provider` (the only other dependency in the call path,
 *     via `Indexer extends HttpProvider`) has zero `console.*` calls in the
 *     Node (`lib.cjs`) build actually used here.
 * In short: this is unconditional, hardcoded `console.log`, not a
 * misconfigured opt-in — there is nothing to "turn off" from the outside.
 *
 * Why this matters: two consumers of `@dmemo/core` treat stdout as a
 * protocol. Claude Code/Codex hooks (`packages/node-adapter`) parse a
 * hook's stdout as a single JSON document; any `console.log` fired by the
 * SDK during `session.close()`'s flush lands on that same stream ahead of
 * the hook's own `{"hookSpecificOutput":...}` line. A `--json`-style CLI
 * consumer would see the same corruption. `console.warn`/`console.error`
 * (also used by the SDK — e.g. `Downloader.js`'s temp-file cleanup
 * warnings, `Indexer.js`'s upload-failure messages) already go to Node's
 * real stderr by default and are NOT part of this bug; this module leaves
 * them completely untouched.
 *
 * Structural note: this module is the low-level patch/restore primitive
 * only. Application code should almost never call `withQuietSdkStdout()`
 * (or `beginQuietSdkStdout`/`endQuietSdkStdout`) directly at a call site —
 * that is exactly the "applied by convention" failure mode this exists to
 * avoid (a new SDK call site can simply forget to wrap itself). Instead,
 * obtain the `Indexer` pre-wrapped via `quietIndexer.ts`'s
 * `wrapIndexerQuiet()`, which routes every method call — present today or
 * added later, by us or by a future SDK version — through this patch
 * automatically. `StorageClient` never touches this module directly.
 *
 * Given no native control exists, the only remaining option is to
 * intercept `console.log` — a monkey patch, used here as the documented
 * last resort and kept as tight as the constraints allow:
 *  - scoped to exactly the duration of the wrapped SDK call, restored in a
 *    `finally`, never installed for the process's lifetime;
 *  - reference-counted so overlapping calls in the same process — e.g. two
 *    `DmemoSession`s flushing concurrently under one long-lived plugin host
 *    (TASKS.md gotcha 25: "one plugin instance serves every session on the
 *    server") — share a single patch/restore instead of racing: only the
 *    last caller to finish restores the original `console.log`, so an
 *    inner call finishing first can never unpatch out from under a sibling
 *    still in flight. The ref-count itself is only ever mutated by
 *    synchronous statements (never across an `await`), so there is no
 *    interleaving hazard even though the calls it wraps are async;
 *  - never touches `console.warn`/`console.error` — nothing this module
 *    does can swallow a genuine diagnostic emitted through those;
 *  - default-quiet, opt-in-verbose: captured lines are dropped unless
 *    `DMEMO_DEBUG` is `'1'`/`'true'` (matching `packages/node-adapter`'s
 *    existing `debugEnabled()` convention), in which case they are relayed
 *    verbatim to the real `console.error` — i.e. stderr, and a function
 *    this module never patches, so the relay itself can't re-enter the
 *    patch — tagged `[0g-sdk]`. Nothing is ever silently discarded forever;
 *    a field debugger can always opt back in.
 */

let refCount = 0;
let originalConsoleLog: typeof console.log | null = null;

function debugEnabled(): boolean {
  const v = process.env.DMEMO_DEBUG;
  return v === '1' || v === 'true';
}

/**
 * Install the `console.log` patch if it isn't already installed, and bump
 * the ref-count. Paired 1:1 with `endQuietSdkStdout()` — every caller MUST
 * call that in a `finally`/`.finally()`, exactly once, regardless of
 * success or failure. These two are the synchronous primitives
 * `withQuietSdkStdout()` (async-only call sites) and `quietIndexer.ts`'s
 * per-method Proxy trap (which must preserve each SDK method's own
 * sync-or-async return shape, so it cannot always `await`) both build on —
 * kept here, not duplicated, so there is exactly one ref-counted
 * patch/restore implementation in the codebase.
 */
export function beginQuietSdkStdout(): void {
  if (refCount === 0) {
    originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      if (debugEnabled()) {
        // console.error is never patched by this module, so this always
        // reaches the real stderr, never stdout, and never re-enters here.
        console.error('[0g-sdk]', ...args);
      }
    };
  }
  refCount++;
}

/** See `beginQuietSdkStdout()`. Restores the original `console.log` once
 * the last in-flight caller has finished. */
export function endQuietSdkStdout(): void {
  refCount--;
  if (refCount === 0) {
    console.log = originalConsoleLog!;
    originalConsoleLog = null;
  }
}

/**
 * Run `fn`, keeping any `console.log` call made anywhere during its
 * execution (including by code `fn` calls into, however deep — e.g. the 0G
 * SDK's internal upload/download orchestration) off the host's real
 * stdout. Safe to call concurrently/nested from multiple in-flight storage
 * operations in the same process — see module doc for the ref-counting
 * argument.
 */
export async function withQuietSdkStdout<T>(fn: () => Promise<T>): Promise<T> {
  beginQuietSdkStdout();
  try {
    return await fn();
  } finally {
    endQuietSdkStdout();
  }
}

/**
 * Test-only escape hatch: force the patch state back to a clean slate.
 * Not part of the package's public API (not re-exported from `index.ts`) —
 * production code never needs this; it exists so a test that throws before
 * its own `finally` runs can't leak a patched `console.log` into the next
 * test in the same process.
 */
export function __resetQuietSdkStdoutForTests(): void {
  if (originalConsoleLog) {
    console.log = originalConsoleLog;
  }
  refCount = 0;
  originalConsoleLog = null;
}
