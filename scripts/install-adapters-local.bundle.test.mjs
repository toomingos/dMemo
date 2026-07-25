// Regression test for the fail-open bug found by the 2026-07-25 live E2E
// against OpenClaw 2026.7.1-2: `openclaw plugins install <plugin-dir>`
// refused to start the whole CLI ("Cannot find module 'better-sqlite3'")
// when the plugin's staged bundle had no native deps linked yet, even
// though every hook in packages/openclaw-plugin/src/index.ts already
// fail-opens on memory errors (try/catch around before_prompt_build /
// agent_end). Root cause: `stageOpenClawBundle()` in
// install-adapters-local.mjs used to esbuild the plugin into a single
// `outfile` in ESM format. `@dmemo/core`'s session.ts does `await
// import('mem0ai/oss')` lazily, only inside `DmemoSession.open()` — but ESM
// `import` declarations can only appear at a module's top level (never
// inside a function body), so a single-outfile esbuild ESM bundle has no
// choice but to hoist every `external` reachable from that dynamically
// imported module (including better-sqlite3, gotcha 3) into a real
// top-level `import` in dist/index.js. OpenClaw's plugin loader resolves
// that import before any of the file's code (including register()'s own
// try/catches) ever runs, so a missing native dep took down the whole host
// — see loader-D8d2EvVh.js's PluginLoadFailureError /
// maybeThrowOnPluginLoadError (throwOnLoadError: true at both call sites).
//
// The fix (this file's sibling, install-adapters-local.mjs's
// stageOpenClawBundle()) switched that esbuild call from `outfile` to
// `outdir` + `splitting: true`, which moves the dynamically-imported
// mem0ai/oss module (and therefore better-sqlite3) into its own chunk file
// that Node only resolves when the dynamic import() actually executes —
// dist/index.js keeps its required filename since esbuild names the entry
// chunk after the entry point's basename.
//
// This test mirrors that exact esbuild config (same entry point, same
// externals, same banner) against a temp staging dir OUTSIDE this repo's
// node_modules tree, so Node's module resolution genuinely cannot find
// better-sqlite3 — matching the real-world "native deps not linked yet"
// state OpenClaw's loader hit live. It then dynamically imports the built
// dist/index.js in a clean child process and asserts that import succeeds
// (proving the module-load-time crash is gone) and that register() also
// runs without throwing.
//
// Run directly: node --test scripts/install-adapters-local.bundle.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENCLAW_PLUGIN_DIR = path.join(REPO, 'packages', 'openclaw-plugin');

function buildStagingBundle(outDir) {
  const esbuild = createRequire(path.join(REPO, 'packages', 'node-adapter', 'package.json'))('esbuild');
  const externals = JSON.parse(
    fs.readFileSync(path.join(REPO, 'packages', 'node-adapter', 'scripts', 'externals.json'), 'utf8')
  );

  fs.mkdirSync(outDir, { recursive: true });

  // Mirrors stageOpenClawBundle()'s esbuild.buildSync call in
  // install-adapters-local.mjs exactly (entry point, externals, banner) —
  // the one load-bearing difference under test is outdir+splitting vs a
  // single outfile.
  esbuild.buildSync({
    entryPoints: [path.join(OPENCLAW_PLUGIN_DIR, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outdir: outDir,
    splitting: true,
    external: [...externals.native, ...externals.ossOptionalBackends],
    banner: {
      js: [
        "import { createRequire as __dmemoCreateRequire } from 'node:module';",
        "import { fileURLToPath as __dmemoFileURLToPath } from 'node:url';",
        "import { dirname as __dmemoDirname } from 'node:path';",
        'const require = __dmemoCreateRequire(import.meta.url);',
        'const __filename = __dmemoFileURLToPath(import.meta.url);',
        'const __dirname = __dmemoDirname(__filename);',
      ].join('\n'),
    },
    logLevel: 'silent',
  });
}

test('OpenClaw plugin bundle: entry chunk has no top-level native-dep import', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-openclaw-bundle-'));
  try {
    buildStagingBundle(tmp);
    const entry = path.join(tmp, 'index.js');
    assert.ok(fs.existsSync(entry), 'expected dist/index.js entry chunk to exist');

    // Splitting must actually have happened — the dynamically-imported
    // mem0ai/oss module (and better-sqlite3, reached only through it)
    // belongs in a separate chunk, not inlined into the entry file.
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.js'));
    assert.ok(
      files.length > 1,
      `expected code splitting to produce >1 chunk file, got: ${files.join(', ')}`
    );

    // The regression under test: a single-outfile ESM bundle hoists
    // better-sqlite3 into a real top-level `import ... from "better-sqlite3"`
    // in the entry file. With splitting, the entry file must not reference
    // it directly at all — only whichever chunk holds the lazy
    // `import('mem0ai/oss')` may.
    const entrySrc = fs.readFileSync(entry, 'utf8');
    assert.doesNotMatch(
      entrySrc,
      /from\s+["']better-sqlite3["']/,
      'entry chunk must not statically import better-sqlite3 (defeats lazy mem0ai/oss loading, gotcha 3)'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('OpenClaw plugin bundle: module import + register() do not throw when native deps are unresolvable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-openclaw-bundle-'));
  try {
    buildStagingBundle(tmp);

    // `tmp` is under os.tmpdir(), well outside this repo's pnpm workspace —
    // Node's module resolution walks up from the importing file's own
    // directory, so better-sqlite3 (a real dependency elsewhere in this
    // monorepo, but never installed under os.tmpdir()) genuinely cannot
    // resolve from here. This reproduces the exact "native deps not linked
    // yet" state the live OpenClaw E2E hit.
    const probe = path.join(tmp, '__probe.mjs');
    fs.writeFileSync(
      probe,
      [
        "import plugin from './index.js';",
        'const calls = [];',
        'const fakeApi = {',
        '  pluginConfig: {},', // no privateKey -> register() takes the fail-open-tools branch
        "  logger: { warn: (m) => calls.push(['warn', m]), info: (m) => calls.push(['info', m]) },",
        '  resolvePath: (p) => p,',
        '  registerTool: () => {},',
        '  on: () => {},',
        '};',
        'const handle = plugin.register(fakeApi);',
        "if (typeof handle?.uninstall !== 'function') throw new Error('register() did not return a RegisterHandle');",
        "process.stdout.write('OK');",
      ].join('\n')
    );

    // Run in a fresh child process (not this test's own process, which may
    // have already loaded better-sqlite3 from the monorepo's node_modules
    // via an unrelated import and cached the resolution).
    const out = execFileSync(process.execPath, [probe], { cwd: tmp, encoding: 'utf8' });
    assert.equal(out, 'OK', 'importing the bundle and calling register() must not throw when better-sqlite3 is unresolvable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
