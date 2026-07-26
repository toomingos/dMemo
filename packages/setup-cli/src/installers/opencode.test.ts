// Covers the rewritten OpenCode installer (installers/opencode.ts): it now
// shells out to `opencode plugin <module> --global --force` instead of
// hand-writing opencode.json, so these tests fake the `opencode` binary on
// PATH (a tiny shell script) rather than touching a real install. Node
// resolves the child-process executable using the PATH found in the `env`
// object passed to execFileSync, so pointing PATH at a scratch directory is
// enough to fully control what "opencode" does without any real binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installOpenCode, findLocalPluginDir } from './opencode.js';

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-opencode-test-'));
}

/** Writes a fake `opencode` executable into a fresh bin dir and returns an
 * env whose PATH resolves to ONLY that dir (so the real system `opencode`,
 * if any happens to be installed, can never be reached by accident). */
function fakeOpencodeBin(script: string): NodeJS.ProcessEnv {
  const binDir = scratchDir();
  const bin = path.join(binDir, 'opencode');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { ...process.env, PATH: binDir };
}

const ALWAYS_SUCCEEDS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-opencode"; exit 0; fi
if [ "$1" = "plugin" ]; then echo "installed $2 (global=$3 force=$4)"; exit 0; fi
exit 1
`;

const NPM_SPEC_FAILS_BUT_LOCAL_PATH_SUCCEEDS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-opencode"; exit 0; fi
if [ "$1" = "plugin" ]; then
  case "$2" in
    "@dmemo/opencode-plugin")
      echo "No version matching @dmemo/opencode-plugin" >&2
      exit 1
      ;;
    *)
      echo "installed local checkout $2"
      exit 0
      ;;
  esac
fi
exit 1
`;

const ALWAYS_FAILS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-opencode"; exit 0; fi
if [ "$1" = "plugin" ]; then echo "Could not install $2" >&2; exit 1; fi
exit 1
`;

test('opencode binary missing: non-fatal, reports not attempted, prints manual instructions', () => {
  const env = { ...process.env, PATH: scratchDir() }; // empty bin dir, no `opencode`
  const result = installOpenCode(env);
  assert.equal(result.attempted, false);
  assert.equal(result.succeeded, false);
  assert.ok(result.error, 'the underlying spawn failure should be captured');
  assert.match(result.manualInstructions, /opencode plugin @dmemo\/opencode-plugin/);
});

test('npm spec resolves: installs directly, no local fallback used', () => {
  const env = fakeOpencodeBin(ALWAYS_SUCCEEDS);
  const result = installOpenCode(env);
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, true);
  assert.equal(result.specUsed, '@dmemo/opencode-plugin');
  assert.equal(result.usedLocalFallback, false);
  assert.match(result.output ?? '', /installed @dmemo\/opencode-plugin/);
});

test('npm spec unresolvable: falls back to the local monorepo checkout and succeeds', () => {
  const env = fakeOpencodeBin(NPM_SPEC_FAILS_BUT_LOCAL_PATH_SUCCEEDS);
  // No searchFrom override — this repo IS the monorepo, so the real
  // packages/opencode-plugin checkout is genuinely discoverable from here,
  // exactly like it would be for a contributor running `dmemo setup` from a
  // dev checkout before the package is published.
  const result = installOpenCode(env);
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, true);
  assert.equal(result.usedLocalFallback, true);
  assert.ok(result.specUsed && path.isAbsolute(result.specUsed));
  assert.ok(result.specUsed?.endsWith(path.join('packages', 'opencode-plugin')));
});

test('npm spec unresolvable AND no local checkout found: fails loudly with both errors', () => {
  const env = fakeOpencodeBin(NPM_SPEC_FAILS_BUT_LOCAL_PATH_SUCCEEDS);
  // Point the search at an empty scratch dir with no packages/opencode-plugin
  // anywhere above it, so the fallback genuinely finds nothing.
  const emptyRoot = scratchDir();
  const result = installOpenCode(env, { searchFrom: emptyRoot });
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, false);
  assert.equal(result.usedLocalFallback, false);
  assert.match(result.error ?? '', /did not resolve/);
  assert.match(result.error ?? '', /No version matching/);
});

test('npm spec unresolvable AND local checkout also fails: fails loudly with both errors', () => {
  const env = fakeOpencodeBin(ALWAYS_FAILS);
  const result = installOpenCode(env);
  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, false);
  assert.equal(result.usedLocalFallback, true, 'a local checkout exists in this repo, so it should have been tried');
  assert.match(result.error ?? '', /npm spec "@dmemo\/opencode-plugin" failed/);
  assert.match(result.error ?? '', /local fallback .* also failed/);
});

test('findLocalPluginDir only accepts a packages/opencode-plugin whose package.json name matches', () => {
  const root = scratchDir();
  // A packages/opencode-plugin dir exists but belongs to something else —
  // must NOT be picked, so keep walking (and find nothing, here).
  const decoyDir = path.join(root, 'unrelated', 'packages', 'opencode-plugin');
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.writeFileSync(path.join(decoyDir, 'package.json'), JSON.stringify({ name: 'not-dmemo' }));

  const found = findLocalPluginDir(path.join(root, 'unrelated', 'nested', 'start'));
  assert.equal(found, null);
});

test('findLocalPluginDir finds a real match by walking up', () => {
  const root = scratchDir();
  const pluginDir = path.join(root, 'packages', 'opencode-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: '@dmemo/opencode-plugin' })
  );
  const startDir = path.join(root, 'packages', 'setup-cli', 'dist', 'installers');
  fs.mkdirSync(startDir, { recursive: true });

  const found = findLocalPluginDir(startDir);
  assert.equal(found, pluginDir);
});
