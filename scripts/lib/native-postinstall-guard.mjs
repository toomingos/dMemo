// Helper functions backing scripts/native-postinstall-guard.test.mjs.
//
// Context (see TASKS.md gotcha 3 and the F4/Bun-compat work around it): dMemo's real
// end-user install path is `openclaw plugins install @dmemo/openclaw-plugin`. OpenClaw
// installs a plugin's npm dependency tree with `--ignore-scripts` (its own docs say
// plugin dependency trees "should remain pure JS/TS and avoid packages that require
// postinstall builds" — see nix-openclaw's parallel "Dependency Rule": runtime plugins
// with native-heavy deps must ship a shrinkwrap/bundled node_modules precisely because
// nothing installs scripts for them at runtime). That resolves through
// `@dmemo/core` -> `mem0ai` -> `better-sqlite3` + `pg`, and `@dmemo/core` ->
// `fastembed` -> `onnxruntime-node` + `@anush008/tokenizers`. It only works today
// because of three separate, INCIDENTAL properties of the versions currently pinned:
//
//   1. `better-sqlite3@13.0.1` ships `prebuilds/**` and declares NO install/postinstall/
//      preinstall script at all -- there is nothing for --ignore-scripts to skip.
//   2. `fastembed@2.1.0` -> `onnxruntime-node@1.21.0` DOES declare a `postinstall`
//      script, but it only ever fetches the *optional* CUDA execution provider, and only
//      when running on Linux/x64 without a forcing flag (`script/install.js`:
//      `shouldInstall = FORCE_INSTALL || (!SKIP_LOCAL_INSTALL && IS_LINUX_X64 &&
//      BIN_FOLDER_EXISTS && !CUDA_DLL_EXISTS)`). The base `onnxruntime_binding.node`
//      addon for every platform the package declares support for
//      (`bin/napi-v3/<os>/<arch>/onnxruntime_binding.node`) is already bundled in the
//      tarball; the postinstall script never creates it, only adds CUDA .so files on top.
//   3. `@anush008/tokenizers` resolves its native binding through per-platform
//      `optionalDependencies` (`@anush008/tokenizers-<os>-<arch...>`), matched by npm's
//      own `os`/`cpu` package.json fields -- no script involved on either the meta
//      package or the platform packages.
//
// A naive "does this package declare a postinstall script?" check would flag #2 (a false
// positive on the very platform dMemo ships on, darwin-arm64) and would therefore get
// disabled the first time someone ran it. The functions below distinguish "has a script"
// from "needs that script to produce something the platforms we ship on don't already
// have bundled" -- proven by checking for the actual binding files the runtime loads,
// not by trying to statically re-derive the script's own conditional logic (which is
// exactly the kind of hand-rolled parsing the guard should avoid depending on).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** The only three script names npm's installer gates behind `--ignore-scripts`
 * (verified against npm/cli's arborist `rebuild.js`: `#build()` wraps exactly
 * `preinstall`, `install`, and `postinstall` in `if (!this.options.ignoreScripts)`;
 * everything else -- `prepare` during `npm install <git-dep>`, explicit `npm run x` --
 * is a different gate or unaffected). This is the same list OpenClaw's plugin installer
 * is documented to skip. */
export const LIFECYCLE_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall'];

/**
 * Resolves the on-disk directory of an installed package the same way Node itself would
 * from a given `package.json` (i.e. real dependency-graph resolution, not a hand-picked
 * path into node_modules/.pnpm). Some packages (fastembed) restrict their `exports` map
 * and refuse a direct `require.resolve('<pkg>/package.json')`, so this resolves the
 * package's main entry point instead and walks up to the nearest package.json.
 */
export function resolvePackageDir(specifier, fromPackageJsonPath) {
  const req = createRequire(fromPackageJsonPath);
  const resolvedEntry = req.resolve(specifier);
  let dir = path.dirname(resolvedEntry);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate a package.json above ${resolvedEntry} while resolving "${specifier}"`);
    }
    dir = parent;
  }
  return dir;
}

export function readPackageJson(pkgDir) {
  return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
}

/** The subset of LIFECYCLE_SCRIPT_NAMES this manifest actually declares (non-empty). */
export function declaredLifecycleScripts(pkgJson) {
  const scripts = pkgJson?.scripts ?? {};
  return LIFECYCLE_SCRIPT_NAMES.filter((name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '');
}

/**
 * Strongest guarantee in this file: the package declares NO install/preinstall/
 * postinstall script at all, so `--ignore-scripts` provably skips nothing that would
 * otherwise have run, on any platform, ever. Throws a descriptive error (rather than
 * returning a boolean) so a failing guard reads as an actionable regression report, not
 * a bare assertion diff.
 */
export function assertNoLifecycleScripts(label, pkgJson) {
  const found = declaredLifecycleScripts(pkgJson);
  if (found.length > 0) {
    const detail = found.map((name) => `${name}=${JSON.stringify(pkgJson.scripts[name])}`).join(', ');
    throw new Error(
      `${label}: expected zero install/preinstall/postinstall scripts, but package.json now declares: ` +
        `${detail}. OpenClaw installs plugin dependencies with --ignore-scripts, so this alone would not ` +
        `break the real install path -- but it means this package silently started depending on a build ` +
        `step it previously didn't need. Re-verify (like the other checks in this file do) that the ` +
        `script is not load-bearing on the platforms dMemo ships on before upgrading past this version.`
    );
  }
}

/**
 * Weaker but still sound guarantee for a package that DOES declare a lifecycle script:
 * proves the script is not load-bearing on a given platform by checking that the native
 * binding file the runtime actually `require()`s/loads is already present in the
 * package's shipped files -- i.e. behavior is identical whether or not
 * `--ignore-scripts` skipped the script. `exists` is injectable (defaults to
 * `fs.existsSync`) so this can be exercised against synthetic fixtures without touching
 * the filesystem, which is how the regression-detection tests in the test file work.
 */
export function assertBindingBundledWithoutScript(label, pkgDir, relBindingPath, exists = fs.existsSync) {
  const full = path.join(pkgDir, relBindingPath);
  if (!exists(full)) {
    throw new Error(
      `${label}: expected the native binding at "${relBindingPath}" to already be bundled in the package ` +
        `as shipped (independent of any install/postinstall script), but it is missing. This means the ` +
        `package's lifecycle script may now be load-bearing to produce it -- under OpenClaw's ` +
        `--ignore-scripts plugin-install policy that script never runs, so the real install path ` +
        `(openclaw plugins install @dmemo/openclaw-plugin) would resolve this package but fail at ` +
        `runtime when the binding can't be found. This is exactly the regression this guard exists to catch.`
    );
  }
}

/**
 * Discovers the {os, arch} binding paths onnxruntime-node actually ships in its own
 * `bin/napi-v3/<os>/<arch>/` tree (the package's own file layout, not a platform list we
 * invented), cross-checked against its declared `package.json#os` field so the two can
 * never silently drift apart without failing loudly. Returns the list of
 * package-dir-relative paths to each platform's `onnxruntime_binding.node`.
 */
export function discoverOnnxBindingPaths(pkgDir, declaredOsField) {
  const binRoot = path.join(pkgDir, 'bin', 'napi-v3');
  const osDirs = fs.readdirSync(binRoot).filter((d) => fs.statSync(path.join(binRoot, d)).isDirectory());

  const declared = new Set(declaredOsField ?? []);
  const undeclared = osDirs.filter((d) => !declared.has(d));
  if (undeclared.length > 0) {
    throw new Error(
      `onnxruntime-node: bin/napi-v3 ships prebuilt bindings for ${undeclared.join(', ')}, but ` +
        `package.json's "os" field doesn't declare ${undeclared.length > 1 ? 'them' : 'it'} ` +
        `(currently: ${JSON.stringify(declaredOsField)}). The guard's platform coverage is derived from ` +
        `"os", so this drift means a platform could be silently uncovered.`
    );
  }

  const paths = [];
  for (const osDir of osDirs) {
    const archRoot = path.join(binRoot, osDir);
    for (const archDir of fs.readdirSync(archRoot)) {
      if (!fs.statSync(path.join(archRoot, archDir)).isDirectory()) continue;
      paths.push(path.join('bin', 'napi-v3', osDir, archDir, 'onnxruntime_binding.node'));
    }
  }
  return paths;
}
