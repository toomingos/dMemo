// Regression guard for a fact dMemo's real install path silently depends on (see
// scripts/lib/native-postinstall-guard.mjs for the full writeup): OpenClaw installs
// plugin npm dependencies with `--ignore-scripts`, and `@dmemo/core`'s native
// dependency chain (better-sqlite3, and fastembed -> onnxruntime-node +
// @anush008/tokenizers) only survives that today because of three separate, incidental
// facts about the exact versions currently pinned in packages/core/package.json:
//
//   - better-sqlite3@13.0.1 has NO install/preinstall/postinstall script at all.
//   - onnxruntime-node@1.21.0's postinstall only fetches the *optional* CUDA execution
//     provider, gated to Linux/x64 -- every platform's *required* NAPI binding is
//     already bundled in the tarball, so the script is never load-bearing.
//   - @anush008/tokenizers resolves its native binding via per-platform
//     optionalDependencies + package.json os/cpu matching, which npm/pnpm handle
//     natively -- no script involved.
//
// Any one of these changing in a future version bump would silently break the real
// end-user install (`openclaw plugins install @dmemo/openclaw-plugin`) with nothing in
// the repo to catch it before a user hit it. This file is that catch.
//
// Design notes (see the full research in the PR/task description this file was added
// for): this is a STATIC, offline check against the packages actually resolved into
// this workspace's pnpm store -- not a live `npm install --ignore-scripts` simulation.
// That simulation would have higher fidelity but requires network access and a real
// package-manager run (slow, non-hermetic); this repo has no CI wiring at all (no
// .github/, nothing subscribes to root-level test files today -- confirmed by grep), so
// a network-dependent test would be even less likely to actually run. The static check
// instead verifies, from the packages' own shipped files and metadata, that the
// lifecycle scripts in the native chain either don't exist or are provably unnecessary
// to produce the binding the runtime loads -- which is the exact thing --ignore-scripts
// changes. See assertBindingBundledWithoutScript's doc comment for why this is sound:
// it doesn't try to re-derive what a script's conditional logic does (fragile, and the
// kind of hand-rolled parsing the guard should avoid), it checks whether the file the
// script would have produced is already there without it.
//
// Run directly: node --test scripts/native-postinstall-guard.test.mjs
// Wired into the repo via root package.json's "test" script (`node --test scripts/`).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolvePackageDir,
  readPackageJson,
  declaredLifecycleScripts,
  assertNoLifecycleScripts,
  assertBindingBundledWithoutScript,
  discoverOnnxBindingPaths,
} from './lib/native-postinstall-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PKG_JSON = path.join(REPO, 'packages', 'core', 'package.json');

// ---------------------------------------------------------------------------
// Ground-truth resolution: exactly what @dmemo/core's dependency graph resolves
// to in this workspace right now, via real Node module resolution (not a
// hand-picked node_modules/.pnpm path).
// ---------------------------------------------------------------------------

const betterSqlite3Dir = resolvePackageDir('better-sqlite3', CORE_PKG_JSON);
const mem0aiDir = resolvePackageDir('mem0ai', CORE_PKG_JSON);
const pgDir = resolvePackageDir('pg', CORE_PKG_JSON);
const fastembedDir = resolvePackageDir('fastembed', CORE_PKG_JSON);
const fastembedPkgJsonPath = path.join(fastembedDir, 'package.json');
const onnxDir = resolvePackageDir('onnxruntime-node', fastembedPkgJsonPath);
const tokenizersDir = resolvePackageDir('@anush008/tokenizers', fastembedPkgJsonPath);

const betterSqlite3Pkg = readPackageJson(betterSqlite3Dir);
const mem0aiPkg = readPackageJson(mem0aiDir);
const pgPkg = readPackageJson(pgDir);
const fastembedPkg = readPackageJson(fastembedDir);
const onnxPkg = readPackageJson(onnxDir);
const tokenizersPkg = readPackageJson(tokenizersDir);

// ---------------------------------------------------------------------------
// 1. Packages that must have ZERO install/preinstall/postinstall scripts.
//    (better-sqlite3 is the one the task's "fact" hinges on; mem0ai/pg/fastembed/
//    the tokenizers meta package are cheap additional coverage of the rest of the
//    chain gotcha 3 names -- if any of them ever grows a lifecycle script, that's
//    worth knowing about even though it isn't one of the three named incidental
//    properties.)
// ---------------------------------------------------------------------------

test('better-sqlite3 declares no install/preinstall/postinstall script', () => {
  assert.doesNotThrow(() => assertNoLifecycleScripts(`better-sqlite3@${betterSqlite3Pkg.version}`, betterSqlite3Pkg));
});

test('better-sqlite3 ships a prebuilt binding for darwin-arm64 (the platform this suite runs on)', () => {
  const prebuildsDir = path.join(betterSqlite3Dir, 'prebuilds');
  const files = fs.readdirSync(prebuildsDir);
  assert.ok(
    files.includes('darwin-arm64.node'),
    `expected prebuilds/darwin-arm64.node among ${JSON.stringify(files)}`
  );
});

test('mem0ai (the package that eagerly imports better-sqlite3 + pg, gotcha 3) declares no lifecycle scripts', () => {
  assert.doesNotThrow(() => assertNoLifecycleScripts(`mem0ai@${mem0aiPkg.version}`, mem0aiPkg));
});

test('pg declares no lifecycle scripts', () => {
  assert.doesNotThrow(() => assertNoLifecycleScripts(`pg@${pgPkg.version}`, pgPkg));
});

test('fastembed itself declares no lifecycle scripts', () => {
  assert.doesNotThrow(() => assertNoLifecycleScripts(`fastembed@${fastembedPkg.version}`, fastembedPkg));
});

// ---------------------------------------------------------------------------
// 2. onnxruntime-node: DOES declare a postinstall. The naive "has a script"
//    check would flag this as a false positive on darwin-arm64 -- prove it
//    isn't one, on every platform the package itself claims to support.
// ---------------------------------------------------------------------------

test('onnxruntime-node DOES declare a postinstall script (documenting why the naive check would false-positive)', () => {
  const found = declaredLifecycleScripts(onnxPkg);
  assert.deepEqual(found, ['postinstall'], 'expected exactly a postinstall script to exist');
});

test('onnxruntime-node postinstall is gated to Linux/x64 CUDA-only, per its own shipped script', () => {
  const installScript = fs.readFileSync(path.join(onnxDir, 'script', 'install.js'), 'utf8');
  // Not the primary proof (that's the binding-bundled check below) -- this corroborates
  // *why* it's safe: the only unconditional-ish trigger requires being on Linux/x64,
  // and what it fetches is CUDA/TensorRT provider files, not the base NAPI binding.
  assert.match(installScript, /os\.platform\(\)\s*===\s*['"]linux['"]/);
  assert.match(installScript, /os\.arch\(\)\s*===\s*['"]x64['"]/);
  assert.match(installScript, /cuda/i);
});

test('onnxruntime-node: package.json "os" field and its shipped bin/napi-v3 platforms agree', () => {
  // discoverOnnxBindingPaths itself throws on drift; a clean return proves agreement.
  const paths = discoverOnnxBindingPaths(onnxDir, onnxPkg.os);
  assert.ok(paths.length > 0, 'expected at least one platform binding path to be discovered');
});

test('onnxruntime-node: every declared platform already bundles onnxruntime_binding.node WITHOUT running the postinstall', () => {
  const bindingPaths = discoverOnnxBindingPaths(onnxDir, onnxPkg.os);
  // Sanity: this must cover more than just darwin -- specifically it must include the
  // one platform (linux/x64) where the postinstall script's own gate says it will try
  // to do something on a bare `npm install`. If a future onnxruntime-node version
  // stopped bundling linux/x64 by default (making the binding depend on a script that
  // OpenClaw's --ignore-scripts would skip), this list -- and therefore this test --
  // would still include it and catch it.
  const relPaths = bindingPaths.map((p) => p.split(path.sep).join('/'));
  assert.ok(
    relPaths.includes('bin/napi-v3/linux/x64/onnxruntime_binding.node'),
    `expected linux/x64 binding path among discovered platforms: ${JSON.stringify(relPaths)}`
  );
  assert.ok(
    relPaths.some((p) => p.startsWith('bin/napi-v3/darwin/')),
    'expected at least one darwin binding path (the platform this suite runs on)'
  );

  for (const relPath of bindingPaths) {
    assert.doesNotThrow(
      () => assertBindingBundledWithoutScript(`onnxruntime-node@${onnxPkg.version} (${relPath})`, onnxDir, relPath),
      `expected ${relPath} to already be bundled independent of the postinstall script`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. @anush008/tokenizers: native binding resolved via optionalDependencies +
//    npm's own os/cpu matching, not a script.
// ---------------------------------------------------------------------------

test('@anush008/tokenizers meta package declares no lifecycle scripts', () => {
  assert.doesNotThrow(() => assertNoLifecycleScripts(`@anush008/tokenizers@${tokenizersPkg.version}`, tokenizersPkg));
});

test('@anush008/tokenizers resolves its native binding via optionalDependencies (platform packages), not a downloader script', () => {
  const optionalDeps = Object.keys(tokenizersPkg.optionalDependencies ?? {});
  assert.ok(optionalDeps.length > 0, 'expected optionalDependencies to list per-platform binding packages');
  for (const name of optionalDeps) {
    assert.match(name, /^@anush008\/tokenizers-/, `expected a platform-binding package name, got "${name}"`);
  }
});

test('@anush008/tokenizers-darwin-universal (the platform package actually resolved on this machine) declares no lifecycle scripts and a native "os" field', () => {
  // Only the platform package matching this machine (darwin) is actually present in the
  // pnpm store -- npm/pnpm skip installing the linux/win32 optional variants here, which
  // is the mechanism itself being exercised. We can only directly verify the one that's
  // actually on disk; the others are covered by the same shape check below.
  const darwinPkgDir = resolvePackageDir('@anush008/tokenizers-darwin-universal', fastembedPkgJsonPath);
  const darwinPkg = readPackageJson(darwinPkgDir);
  assert.doesNotThrow(() =>
    assertNoLifecycleScripts(`@anush008/tokenizers-darwin-universal@${darwinPkg.version}`, darwinPkg)
  );
  assert.ok(Array.isArray(darwinPkg.os) && darwinPkg.os.length > 0, 'expected a native "os" field for platform matching');
});

// ---------------------------------------------------------------------------
// 4. Proof the guard actually catches the regression it exists for. These
//    tests stub package manifests / a file-existence check rather than doing a
//    live install -- see the module doc comment for why a live simulation
//    isn't worth the network dependency here.
// ---------------------------------------------------------------------------

test('REGRESSION CHECK: assertNoLifecycleScripts fails loudly when a package gains a postinstall script', () => {
  const fixture = {
    name: 'better-sqlite3',
    version: '99.0.0-fixture',
    scripts: {
      // Simulates a hypothetical future better-sqlite3 that switched from shipping
      // prebuilds to compiling on install -- exactly the regression gotcha 3/this
      // guard exists to catch.
      postinstall: 'node-gyp rebuild',
    },
  };
  assert.throws(
    () => assertNoLifecycleScripts(`better-sqlite3@${fixture.version}`, fixture),
    (err) => {
      assert.match(err.message, /postinstall/);
      assert.match(err.message, /node-gyp rebuild/);
      assert.match(err.message, /--ignore-scripts/);
      return true;
    }
  );
});

test('REGRESSION CHECK: assertBindingBundledWithoutScript fails loudly when the binding is no longer bundled', () => {
  // Simulates a hypothetical future onnxruntime-node that stopped shipping the
  // linux/x64 NAPI binding in the tarball and started fetching it in postinstall --
  // i.e. the postinstall becomes load-bearing on a platform OpenClaw's
  // --ignore-scripts would silently break.
  const fakeExists = () => false;
  assert.throws(
    () =>
      assertBindingBundledWithoutScript(
        'onnxruntime-node@99.0.0-fixture (bin/napi-v3/linux/x64/onnxruntime_binding.node)',
        '/fixture/onnxruntime-node',
        'bin/napi-v3/linux/x64/onnxruntime_binding.node',
        fakeExists
      ),
    (err) => {
      assert.match(err.message, /onnxruntime_binding\.node/);
      assert.match(err.message, /load-bearing/);
      assert.match(err.message, /openclaw plugins install/);
      return true;
    }
  );
});

test('REGRESSION CHECK: assertBindingBundledWithoutScript passes when the binding IS present (no false positive on the injected checker itself)', () => {
  const fakeExists = (p) => p === path.join('/fixture/pkg', 'bin', 'ok.node');
  assert.doesNotThrow(() =>
    assertBindingBundledWithoutScript('fixture-pkg', '/fixture/pkg', path.join('bin', 'ok.node'), fakeExists)
  );
});
