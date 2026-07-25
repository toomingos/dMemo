/**
 * F4 — `better-sqlite3` on Bun.
 *
 * mem0ai's OSS bundle imports `better-sqlite3` at MODULE SCOPE (two static
 * imports: the `memory` vector store and the sqlite history store), so merely
 * `await import('mem0ai/oss')` loads the addon regardless of which providers
 * dMemo configures. better-sqlite3 is a V8-C++ addon (not Node-API), and Bun
 * has never supported the V8 C++ API surface it needs — oven-sh/bun#4290 is
 * still open with no timeline. The result under Bun is not a catchable
 * exception but a process-level abort:
 *
 *     panic(main thread): NAPI FATAL ERROR: Error::New napi_get_last_error_info
 *
 * Verified to reproduce on Bun 1.2.18 and 1.3.14 (macOS arm64) with
 * better-sqlite3 12.x and 13.x. This matters because OpenCode runs plugins
 * IN-PROCESS under Bun, so the panic takes the whole editor down — it defeats
 * dMemo's fail-open contract, since a memory-layer fault must never break the
 * host.
 *
 * Note this is specific to V8-C++ addons: Node-API addons are fine on Bun
 * (dMemo's own fastembed/onnxruntime-node embedder runs there unmodified), so
 * no out-of-process sidecar is needed — only better-sqlite3 has to go.
 *
 * The fix routes the `better-sqlite3` specifier to Bun's built-in
 * `bun:sqlite`, whose API is explicitly modelled on better-sqlite3, using
 * `Bun.plugin()`'s virtual-module support (`build.module`, a documented
 * runtime-plugin feature since Bun v1.0.4). Registration only affects modules
 * resolved AFTER it runs, which is why `DmemoSession.open()` calls this
 * immediately before its dynamic `import('mem0ai/oss')`.
 *
 * Only the surface mem0 actually touches is emulated — verified by reading
 * mem0ai 3.1.1's bundled `MemoryVectorStore`: `new Database(path)`, `exec`,
 * `prepare().run()/.get()/.all()`, and `transaction()`. mem0 uses no
 * better-sqlite3-only extras (`pluck`, `raw`, `iterate`, `columns`, `pragma`,
 * `function`, `aggregate`, `backup`, `loadExtension`); the few implemented
 * below beyond that set are defensive.
 *
 * On Node (and any non-Bun runtime) this is inert: the real better-sqlite3 is
 * used unchanged.
 */

/** Result of an install attempt — `installed:false` with `reason` is normal on Node. */
export interface BunSqliteCompatResult {
  /** True if this runtime is Bun (i.e. the shim is required at all). */
  isBun: boolean;
  /** True if the `better-sqlite3` specifier is now safely served by `bun:sqlite`. */
  installed: boolean;
  /** Human-readable explanation, for logs and error messages. */
  reason: string;
}

interface BunPluginBuilder {
  module(specifier: string, factory: () => { exports: unknown; loader: string }): void;
}

interface BunGlobal {
  version?: string;
  plugin(plugin: { name: string; setup(build: BunPluginBuilder): void }): void;
}

function detectBun(): BunGlobal | null {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  return bun && typeof bun.plugin === 'function' ? bun : null;
}

/**
 * Copy into a fresh, 0-offset ArrayBuffer.
 *
 * `bun:sqlite` returns BLOBs as `Uint8Array` where better-sqlite3 returns
 * `Buffer`. mem0 reads vectors back with
 * `new Float32Array(row.vector.buffer, row.vector.byteOffset, ...)`, which
 * THROWS if `byteOffset` is not a multiple of 4. A pooled/offset view would
 * therefore corrupt search at random, so normalize to a guaranteed-aligned
 * `Buffer` rather than relying on the current allocator's behavior.
 */
function toAlignedBuffer(view: Uint8Array): Buffer {
  const out = Buffer.from(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    // Already a Buffer at a 4-byte-aligned offset: hand back untouched.
    if (Buffer.isBuffer(value) && value.byteOffset % 4 === 0) return value;
    return toAlignedBuffer(value);
  }
  return value;
}

function normalizeRow<T>(row: T): T {
  if (row === null || row === undefined || typeof row !== 'object') return row;
  const src = row as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(src)) {
    const normalized = normalizeValue(src[key]);
    if (normalized !== src[key]) {
      // Copy lazily — most rows contain no BLOB and are returned as-is.
      out ??= { ...src };
      out[key] = normalized;
    }
  }
  return (out ?? src) as T;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** better-sqlite3-shaped `Statement` over a `bun:sqlite` statement. */
class CompatStatement {
  constructor(private readonly stmt: any) {}

  run(...params: any[]) {
    return this.stmt.run(...params);
  }

  get(...params: any[]) {
    const row = this.stmt.get(...params);
    // better-sqlite3 yields `undefined` for "no row"; bun:sqlite yields
    // `null`. Callers testing `row === undefined` would otherwise misread a
    // miss as a hit.
    if (row === null || row === undefined) return undefined;
    return normalizeRow(row);
  }

  all(...params: any[]) {
    const rows = this.stmt.all(...params);
    return Array.isArray(rows) ? rows.map(normalizeRow) : rows;
  }

  values(...params: any[]) {
    return this.stmt.values?.(...params);
  }

  iterate(...params: any[]) {
    return this.stmt.iterate?.(...params);
  }

  finalize() {
    return this.stmt.finalize?.();
  }

  get source(): string {
    return this.stmt.toString?.() ?? '';
  }
}

/** better-sqlite3-shaped `Database` over `bun:sqlite`. */
export class BetterSqlite3OnBun {
  private readonly db: any;
  readonly name: string;
  readonly memory: boolean;
  open = true;

  constructor(BunDatabase: any, filename?: string, _options?: unknown) {
    const target = filename && filename.length > 0 ? filename : ':memory:';
    this.name = target;
    this.memory = target === ':memory:';
    // better-sqlite3 creates the file when absent; make that explicit rather
    // than depending on bun:sqlite's default open flags.
    this.db = new BunDatabase(target, { create: true, readwrite: true });
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this; // better-sqlite3 returns the Database for chaining.
  }

  prepare(sql: string): CompatStatement {
    return new CompatStatement(this.db.prepare(sql));
  }

  transaction(fn: (...args: any[]) => any) {
    return this.db.transaction(fn);
  }

  pragma(source: string) {
    try {
      return this.db.prepare(`PRAGMA ${source}`).all();
    } catch {
      // Statement-style pragmas (e.g. `journal_mode = WAL`) that return no
      // rows: fall back to plain execution.
      this.db.exec(`PRAGMA ${source}`);
      return [];
    }
  }

  close(): this {
    this.open = false;
    this.db.close(false);
    return this;
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

let cached: BunSqliteCompatResult | null = null;

/**
 * Make `better-sqlite3` safe to import on the current runtime.
 *
 * Idempotent and safe to call on every session open — the first call does the
 * work, later calls return the memoized result. On Node it is a no-op
 * reporting `installed:false`.
 *
 * Never throws: callers get a result they can act on. `DmemoSession.open()`
 * turns `isBun && !installed` into a normal Error, so the host adapter's
 * fail-open path can disable memory instead of the process aborting.
 */
export async function ensureBetterSqlite3Compat(): Promise<BunSqliteCompatResult> {
  if (cached) return cached;

  const bun = detectBun();
  if (!bun) {
    cached = { isBun: false, installed: false, reason: 'not running under Bun — native better-sqlite3 is used' };
    return cached;
  }

  try {
    // Computed specifier: `bun:sqlite` is not resolvable by tsc/Node, and a
    // literal would make bundlers try to follow it.
    const specifier = 'bun' + ':sqlite';
    const mod = (await import(/* @vite-ignore */ specifier)) as { Database?: unknown };
    const BunDatabase = mod.Database;
    if (typeof BunDatabase !== 'function') {
      throw new Error("'bun:sqlite' did not export a Database constructor");
    }

    class ShimmedDatabase extends BetterSqlite3OnBun {
      constructor(filename?: string, options?: unknown) {
        super(BunDatabase, filename, options);
      }
    }

    bun.plugin({
      name: 'dmemo-better-sqlite3-on-bun',
      setup(build) {
        build.module('better-sqlite3', () => ({
          // `__esModule` + `default` so both `import Database from` and
          // esbuild's `__toESM(require(...))` CJS interop resolve to the
          // constructor rather than double-wrapping it.
          exports: { __esModule: true, default: ShimmedDatabase, Database: ShimmedDatabase },
          loader: 'object',
        }));
      },
    });

    cached = {
      isBun: true,
      installed: true,
      reason: `better-sqlite3 routed to bun:sqlite (Bun ${bun.version ?? 'unknown'})`,
    };
  } catch (e) {
    cached = {
      isBun: true,
      installed: false,
      reason: `failed to route better-sqlite3 to bun:sqlite: ${(e as Error).message}`,
    };
  }

  return cached;
}

/** Test-only: drop the memoized result so a fresh install can be attempted. */
export function resetBetterSqlite3CompatForTests(): void {
  cached = null;
}
