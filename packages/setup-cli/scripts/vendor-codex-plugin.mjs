#!/usr/bin/env node
// Runs before `tsc -b` in this package's `build` script. Copies the Codex
// leg of the already-built `claude-dmemo/plugin/scripts/*.cjs` bundle
// (node-adapter's build output, T3.1) into this package's `vendor/`
// directory so it ships inside the `dmemo` npm tarball and `dmemo setup`
// can install Codex hooks with zero network/GitHub dependency at runtime
// (the `dmemo-ai/claude-dmemo` marketplace repo doesn't exist yet — see
// TASKS.md T4.2 — and even once it does, Codex has no marketplace/registry
// concept of its own to fetch from).
//
// Source of truth: `claude-dmemo/plugin/scripts/` (checked into that repo,
// produced by `packages/node-adapter`'s esbuild step). This script keeps
// setup-cli's vendored copy in sync with it on every local `pnpm -r build`.
// Only the files Codex's `hooks-template.json` actually references are
// copied — `recall-approve.cjs`/`save-memory.cjs`/`search-memory.cjs`/
// `status.cjs` are Claude-Code-only (PreToolUse approval gate + skill CLI
// entrypoints) and are intentionally NOT vendored here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const sourceDir = path.resolve(pkgRoot, '../../claude-dmemo/plugin/scripts');
const destDir = path.join(pkgRoot, 'vendor', 'codex-plugin', 'scripts');

const FILES = [
  'install-codex-hooks.cjs',
  'hooks-template.json',
  'session-start.cjs',
  'user-prompt-submit.cjs',
  'stop.cjs',
  'pre-compact.cjs',
];

function main() {
  if (!fs.existsSync(sourceDir)) {
    console.warn(
      `[vendor-codex-plugin] source dir not found: ${sourceDir} — skipping (using ` +
        `whatever is already in vendor/, if anything). Run this from inside the dMemo ` +
        `monorepo checkout to refresh the vendored Codex plugin scripts.`
    );
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const missing = [];
  for (const file of FILES) {
    const src = path.join(sourceDir, file);
    if (!fs.existsSync(src)) {
      missing.push(file);
      continue;
    }
    fs.copyFileSync(src, path.join(destDir, file));
  }

  if (missing.length > 0) {
    throw new Error(
      `[vendor-codex-plugin] missing expected file(s) in ${sourceDir}: ${missing.join(', ')}. ` +
        `Run 'pnpm --filter @dmemo/node-adapter build' first.`
    );
  }

  console.log(`[vendor-codex-plugin] copied ${FILES.length} file(s) into ${destDir}`);
}

main();
