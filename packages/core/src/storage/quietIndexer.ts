/**
 * The structural fix for the "wrapper is applied by convention" liability
 * left by `quietStdout.ts`: instead of asking every SDK call site in
 * `client.ts` (or any future file under `packages/core/src/storage/`) to
 * remember to wrap its own call in `withQuietSdkStdout()`, this module
 * hands out the `Indexer` *pre-wrapped*, so there is no way to reach a raw,
 * unguarded SDK method through it in the first place.
 *
 * `wrapIndexerQuiet()` returns a `Proxy` over the real (or, in tests, a
 * stub) `Indexer` instance. Its `get` trap intercepts every property
 * access: non-function properties pass through untouched; any function
 * property — `upload`, `downloadToBlob`, today's two call sites, but also
 * `selectNodes`, `getFileLocations`, `peekHeader`, `getShardedNodes`, or
 * any method a future SDK bump adds — is returned as a version that begins
 * the `console.log` patch (`quietStdout.ts`'s ref-counted
 * `beginQuietSdkStdout`/`endQuietSdkStdout` primitives) before invoking the
 * original, and ends it once the call settles.
 *
 * `client.ts` constructs its indexer through this once, in one place
 * (`StorageClient`'s constructor), and only ever calls methods on the
 * result. A second SDK call site added to `client.ts` later needs zero new
 * discipline — `this.indexer.newMethod(...)` is automatically quiet,
 * because `this.indexer` IS the wrapped object; there is no unwrapped
 * variant of it in scope to reach for by mistake. What this does NOT cover
 * is a *different* file constructing its own raw `new Indexer(...)` outside
 * this module — see `client.test.ts`'s enumeration-based public-surface
 * test for the complementary (detective, not structural) net over that
 * case, and this module's own doc/tests for the demonstrated failure mode.
 *
 * Sync/async-preserving by design: `Indexer` extends `open-jsonrpc-provider`'s
 * `HttpProvider`, which — unlike every `Indexer`-own method — has genuinely
 * synchronous members (`id(): number`, `close(): void`). A trap that
 * unconditionally `await`s (i.e. reused `withQuietSdkStdout` directly) would
 * silently turn those into `Promise`-returning methods, changing their
 * contract for any caller that relies on a synchronous return. Instead the
 * wrapped function calls the original eagerly and only defers
 * `endQuietSdkStdout()` to a `.finally()` when the result is itself
 * thenable; a synchronous result restores the patch and returns
 * synchronously, exactly matching the original method's shape.
 */
import { beginQuietSdkStdout, endQuietSdkStdout } from './quietStdout.js';

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Wrap any SDK client object (the real `Indexer`, or a test stub standing
 * in for it) so every method call on it is automatically routed through
 * the quiet-stdout patch. Generic over `T` so the return type is still
 * `Indexer` (or whatever stub type was passed in) at the call site —
 * `StorageClient`'s `readonly indexer: Indexer` field needs no type change.
 */
export function wrapIndexerQuiet<T extends object>(indexer: T): T {
  return new Proxy(indexer, {
    get(target, prop, _receiver) {
      // Bind `this` inside accessors/methods to the raw target (not the
      // proxy) — the SDK's own internal calls (e.g. `upload()` calling
      // `this.request(...)` from the JSON-RPC base class) must resolve
      // directly against the real object, never bounce back through this
      // trap a second time.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') {
        return value;
      }
      const original = value as (...args: unknown[]) => unknown;
      return function wrappedQuiet(this: unknown, ...args: unknown[]): unknown {
        beginQuietSdkStdout();
        let result: unknown;
        try {
          result = original.apply(target, args);
        } catch (err) {
          endQuietSdkStdout();
          throw err;
        }
        if (isThenable(result)) {
          return Promise.resolve(result).finally(() => endQuietSdkStdout());
        }
        endQuietSdkStdout();
        return result;
      };
    },
  }) as T;
}
