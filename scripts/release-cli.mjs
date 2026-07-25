#!/usr/bin/env node
/**
 * Publishes the setup CLI to an orphan `cli` branch as a flat, prebuilt package,
 * so that a plain `npx github:<owner>/<repo>#cli` installs and runs it.
 *
 * Why a branch instead of installing the repo directly:
 *   - npm cannot install a subdirectory of a git repo (no `#path:` support, unlike
 *     pnpm), and this CLI lives at packages/setup-cli.
 *   - The monorepo root package.json is `private: true` and has no `bin`, so
 *     `npm i git+https://…/dMemo.git` installs the whole tree and exposes nothing.
 *   - `dist/` is gitignored, so any git checkout of `main` ships zero build output.
 *
 * The branch sidesteps all three: its root IS the package, and `dist/` is committed.
 *
 * Safety: this never touches your working tree, index, or local branches. The
 * payload is assembled in a temp directory that is its own throwaway git repo,
 * and pushed straight to `refs/heads/<branch>` on the remote. Pushing is opt-in
 * via --push; without it you get a fully assembled payload to inspect.
 *
 * Usage:
 *   node scripts/release-cli.mjs              # assemble + report, no network
 *   node scripts/release-cli.mjs --push       # assemble + force-push to origin
 *   node scripts/release-cli.mjs --branch rc  # target a different branch name
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(REPO, 'packages', 'setup-cli');

const args = process.argv.slice(2);
const push = args.includes('--push');
const branch = args[args.indexOf('--branch') + 1] && args.includes('--branch') ? args[args.indexOf('--branch') + 1] : 'cli';
const skipBuild = args.includes('--skip-build');

const run = (cmd, cmdArgs, cwd) =>
  execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

// 1. Build, so `dist/` reflects the current source rather than whatever was left
//    over from the last local build.
if (!skipBuild) {
  console.log('building packages/setup-cli…');
  execFileSync('pnpm', ['run', 'build'], { cwd: PKG, stdio: 'inherit' });
}
if (!existsSync(join(PKG, 'dist', 'cli.js'))) {
  console.error('no dist/cli.js — build failed or --skip-build used against a clean tree');
  process.exit(1);
}

// 2. Assemble the payload. Everything here ends up in the consumer's node_modules,
//    so it is deliberately minimal: the compiled CLI, the vendored adapter scripts
//    the Codex installer copies out, and the legal/readme files.
const staging = mkdtempSync(join(tmpdir(), 'dmemo-release-'));
try {
  cpSync(join(PKG, 'dist'), join(staging, 'dist'), { recursive: true });
  cpSync(join(PKG, 'vendor'), join(staging, 'vendor'), { recursive: true });
  for (const f of ['LICENSE', 'README.md']) {
    if (existsSync(join(REPO, f))) cpSync(join(REPO, f), join(staging, f));
  }

  // Tests are dev-only weight and would ship ~40% more files.
  execFileSync('find', [join(staging, 'dist'), '-name', '*.test.*', '-delete']);

  const src = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  const origin = run('git', ['remote', 'get-url', 'origin'], REPO);
  const cleanSha = run('git', ['rev-parse', '--short', 'HEAD'], REPO);
  // A dirty tree means the built dist/ does not correspond to any commit. Say so
  // in the manifest rather than stamping a sha that cannot reproduce the payload.
  // Scoped to the package the payload is built from: unrelated churn elsewhere in
  // the monorepo cannot change dist/, so flagging it would be a false alarm.
  const dirty = run('git', ['status', '--porcelain', '--', PKG], REPO).length > 0;
  const sha = dirty ? `${cleanSha}-dirty` : cleanSha;
  if (dirty) {
    console.warn(
      `\n! working tree is dirty — this payload is built from uncommitted changes\n` +
        `  and cannot be reproduced from ${cleanSha}. Commit first for a traceable release.`
    );
  }

  // A flat manifest: the branch root is the package, so no `files`, no workspace
  // deps, no build scripts. Anything left in here runs on the consumer's machine.
  const manifest = {
    name: src.name,
    version: src.version,
    description: src.description,
    type: 'module',
    bin: src.bin,
    main: src.main,
    types: src.types,
    exports: src.exports,
    engines: src.engines,
    dependencies: src.dependencies,
    license: src.license,
    keywords: src.keywords,
    repository: { type: 'git', url: `git+${origin}` },
    dmemo: { sourceCommit: sha, branch },
  };
  writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  // .gitignore in the payload would exclude dist/ — npm honours it as an
  // .npmignore fallback for git deps, which is exactly the trap this branch exists
  // to avoid. Write an empty .npmignore to pin the behaviour explicitly.
  writeFileSync(join(staging, '.npmignore'), '');

  // 3. Commit in an isolated throwaway repo — never the user's.
  run('git', ['init', '-q', '-b', branch], staging);
  run('git', ['add', '-A'], staging);
  run('git', ['-c', 'user.email=release@dmemo', '-c', 'user.name=dmemo-release',
    'commit', '-qm', `dmemo cli v${src.version} (${sha})`], staging);

  const files = run('git', ['ls-files'], staging).split('\n').filter(Boolean);
  console.log(`\npayload: ${files.length} files, from ${sha}`);
  console.log(`  bin: ${Object.entries(src.bin).map(([k, v]) => `${k} -> ${v}`).join(', ')}`);
  console.log(`  deps: ${Object.keys(src.dependencies ?? {}).join(', ') || '(none)'}`);

  if (!push) {
    // Keep the staging dir so it can be inspected or installed from directly.
    console.log(`\nassembled at ${staging} (not pushed)`);
    console.log('  try it:   npm install "git+file://' + staging + '"');
    console.log('  publish:  node scripts/release-cli.mjs --push');
    process.exit(0);
  }

  console.log(`\npushing to ${origin} refs/heads/${branch} (force)…`);
  execFileSync('git', ['push', '--force', origin, `HEAD:refs/heads/${branch}`], {
    cwd: staging,
    stdio: 'inherit',
  });

  const slug = origin.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
  console.log(`\npublished. install with:\n  npx github:${slug}#${branch} connect`);
} finally {
  if (push) rmSync(staging, { recursive: true, force: true });
}
