// T3.1 packaging risk, solved first per TASKS.md: `better-sqlite3` (mem0ai's
// vector/history store) and `fastembed` (local embedder, pulls in the
// onnxruntime-node native addon) are native modules — esbuild can bundle
// their pure-JS call sites but NOT their platform-specific `.node`
// bindings. The hook `.cjs` bundles must still run with zero node_modules
// next to them.
//
// Fix: on first run, `npm install` just these two packages (pinned to the
// same versions @dmemo/core declares) into a persistent directory outside
// the plugin install tree — `${CLAUDE_PLUGIN_DATA}` when running as a
// Claude Code plugin (survives plugin updates, per the packaging
// research), else `~/.dmemo/native/`. Then splice that directory's
// `node_modules` into Node's global module-resolution fallback
// (`Module.globalPaths`) so `require('better-sqlite3')` / dynamic
// `import('mem0ai/oss')` (which requires them internally) resolve them no
// matter how deep the requiring file is nested — the standard
// `NODE_PATH`-style trick used by `app-module-path`/`module-alias`, applied
// once per process instead of relying on the env var + `_initPaths()`
// re-read.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import { DMEMO_NATIVE_DIR, debugLog } from './settings.js';

// NOTE on module resolution below: this file is only ever consumed by
// esbuild bundling straight from this .ts source into a single `.cjs`
// (see scripts/build.cjs — entry points are `src/**/*.ts`, not `tsc`'s
// `dist/`), so the plain CJS `require`/`require.resolve` globals used here
// are real, native Node globals at the point this code actually runs —
// unlike `import.meta.url`, which esbuild cannot polyfill for `format:
// 'cjs'` output (confirmed: it emits `undefined` with a build warning).

// Keep in sync with packages/core/package.json's pinned versions (T1.x).
const NATIVE_DEPS: Record<string, string> = {
  'better-sqlite3': '^13.0.1',
  fastembed: '^2.1.0',
};

function nativeDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'native')
    : DMEMO_NATIVE_DIR;
}

function nativeNodeModules(dir: string): string {
  return path.join(dir, 'node_modules');
}

function resolvesFrom(pkg: string, dir: string): boolean {
  try {
    require.resolve(pkg, { paths: [nativeNodeModules(dir)] });
    return true;
  } catch {
    return false;
  }
}

// NOTE: directly pushing onto `Module.globalPaths` (the documented
// `app-module-path`/`module-alias` trick) was tried first and DOES NOT
// WORK on current Node (verified empirically on Node 26.0.0 here — a
// pushed globalPaths entry is silently never consulted by the resolver).
// `NODE_PATH` + `Module._initPaths()` DOES fix `require('better-sqlite3')`
// — but mem0ai/oss's fastembed provider resolves via dynamic `import()`,
// and Node's ESM resolver does NOT consult NODE_PATH/globalPaths at all
// (verified empirically: `require('fastembed')` succeeds under the NODE_PATH
// shim, `import('fastembed')` from the same process still throws "Cannot
// find package"). The only mechanism BOTH resolvers honor is a real
// `node_modules` directory in the requiring file's own ancestry — so the
// actual fix is a `node_modules` symlink placed next to the running bundle
// itself (`__dirname`, i.e. the plugin's `scripts/` dir) pointing at the
// persistent native-deps directory. NODE_PATH is kept too as a harmless,
// redundant belt-and-suspenders for any plain `require()` caller.
function spliceGlobalPaths(dir: string): void {
  const nm = nativeNodeModules(dir);
  const existing = process.env.NODE_PATH ?? '';
  const parts = existing.split(path.delimiter).filter(Boolean);
  if (!parts.includes(nm)) {
    parts.push(nm);
    process.env.NODE_PATH = parts.join(path.delimiter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Module as any)._initPaths();
  }
}

/**
 * Ensures `<bundleDir>/node_modules` resolves both `better-sqlite3` and
 * `fastembed` for CJS `require()` AND ESM `import()` alike, by symlinking
 * (or, if a real `node_modules` dir already exists there for some reason,
 * per-package symlinking into it) the persistent native-deps directory.
 * Cheap to re-run every invocation (a few `lstat`s once the symlink exists).
 * Best-effort: swallows all errors, since `ensureNativeDeps()` must never
 * throw (the fail-open contract every hook depends on).
 */
function linkNodeModulesShim(dir: string): void {
  try {
    const bundleDir = __dirname;
    const nm = nativeNodeModules(dir);
    const shimPath = path.join(bundleDir, 'node_modules');

    let existingStat: fs.Stats | fs.Dirent | null = null;
    try {
      existingStat = fs.lstatSync(shimPath);
    } catch {
      existingStat = null;
    }

    if (existingStat && existingStat.isSymbolicLink()) {
      const target = fs.readlinkSync(shimPath);
      const resolvedTarget = path.isAbsolute(target) ? target : path.join(bundleDir, target);
      if (path.resolve(resolvedTarget) === path.resolve(nm)) return; // already correct
      fs.unlinkSync(shimPath);
      fs.symlinkSync(nm, shimPath, 'dir');
      return;
    }

    if (existingStat && existingStat.isDirectory()) {
      // Real directory already present (unexpected for a shipped bundle,
      // but don't clobber it) — link the individual packages instead.
      for (const pkg of Object.keys(NATIVE_DEPS)) {
        const pkgShim = path.join(shimPath, pkg);
        try {
          if (fs.existsSync(pkgShim)) continue;
          fs.symlinkSync(path.join(nm, pkg), pkgShim, 'dir');
        } catch {
          // best-effort per package
        }
      }
      return;
    }

    fs.symlinkSync(nm, shimPath, 'dir');
  } catch {
    // Fail-open: worst case, require()/import() falls back to whatever
    // NODE_PATH shim above achieved (better-sqlite3 only).
  }
}

function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export interface NativeBootstrapResult {
  dir: string;
  alreadyInstalled: boolean;
  installed: boolean;
  tookMs: number;
  error?: string;
}

/**
 * Idempotent: cheap resolve-check first (common path, sub-millisecond after
 * the first run), only shells out to `npm install` when a dep is missing.
 * Never throws — a failed install just means the caller's dynamic
 * `import('@dmemo/core')` will itself fail shortly after, which every hook
 * already wraps in a fail-open try/catch.
 */
export function ensureNativeDeps(): NativeBootstrapResult {
  const start = Date.now();
  const dir = nativeDir();
  const missing = Object.keys(NATIVE_DEPS).filter((pkg) => !resolvesFrom(pkg, dir));

  if (missing.length === 0) {
    spliceGlobalPaths(dir);
    linkNodeModulesShim(dir);
    return { dir, alreadyInstalled: true, installed: false, tookMs: Date.now() - start };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    const pkgJsonPath = path.join(dir, 'package.json');
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: 'dmemo-native-deps',
          private: true,
          version: '0.0.0',
          dependencies: NATIVE_DEPS,
        },
        null,
        2
      )
    );
    debugLog('native-bootstrap: installing', { dir, missing });
    execFileSync(npmBin(), ['install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 180_000,
    });
    spliceGlobalPaths(dir);
    linkNodeModulesShim(dir);
    const stillMissing = Object.keys(NATIVE_DEPS).filter((pkg) => !resolvesFrom(pkg, dir));
    if (stillMissing.length > 0) {
      return {
        dir,
        alreadyInstalled: false,
        installed: false,
        tookMs: Date.now() - start,
        error: `npm install did not produce resolvable modules: ${stillMissing.join(', ')}`,
      };
    }
    return { dir, alreadyInstalled: false, installed: true, tookMs: Date.now() - start };
  } catch (err) {
    return {
      dir,
      alreadyInstalled: false,
      installed: false,
      tookMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
