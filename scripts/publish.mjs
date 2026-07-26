#!/usr/bin/env node
// dMemo publish pipeline (T4.2).
//
// Publishes the public npm packages in dependency (topological) order using
// `pnpm publish`, which — unlike raw `npm publish` — rewrites `workspace:*`
// protocol dependency ranges to the real resolved version before packing
// (verified: packages/core's `@dmemo/blob-spec: workspace:*` becomes
// `0.1.0` in the tarball).
//
// Order matters: blob-spec has no workspace deps and must land first since
// core depends on it; core must land before sdk-wrappers/opencode-plugin/
// openclaw-plugin/setup-cli even though today only core's dependents use
// @dmemo/core directly (defensive ordering for when that graph grows).
//
// node-adapter is intentionally excluded — it is `"private": true` and not
// meant to reach npm (see packages/node-adapter/README.md for why).
//
// SAFETY: this script defaults to --dry-run and requires an explicit
// `--live` flag plus `--yes-i-am-sure` to actually publish. It never runs
// automatically and is not wired into any CI job in this repo.
//
// Usage:
//   node scripts/publish.mjs                # dry run (default, safe)
//   node scripts/publish.mjs --live --yes-i-am-sure   # the real thing
//   node scripts/publish.mjs --otp=123456 --live --yes-i-am-sure

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Topological publish order.
const PUBLISH_ORDER = [
  'blob-spec',
  'core',
  'sdk-wrappers',
  'opencode-plugin',
  'openclaw-plugin',
  'setup-cli',
];

const args = process.argv.slice(2);
const isLive = args.includes('--live');
const confirmed = args.includes('--yes-i-am-sure');
const otpArg = args.find((a) => a.startsWith('--otp='));
const otp = otpArg ? otpArg.slice('--otp='.length) : undefined;

if (isLive && !confirmed) {
  console.error(
    'Refusing to publish live without --yes-i-am-sure (in addition to --live).',
  );
  process.exit(1);
}

console.log(
  isLive
    ? 'LIVE PUBLISH MODE — this will actually push to the npm registry.'
    : 'DRY RUN MODE (default) — no packages will actually be published. Pass --live --yes-i-am-sure to publish for real.',
);
console.log(`Order: ${PUBLISH_ORDER.join(' -> ')}\n`);

for (const pkgDir of PUBLISH_ORDER) {
  const cwd = path.join(ROOT, 'packages', pkgDir);
  const pkgJsonPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  if (pkg.private) {
    console.log(`[skip] ${pkg.name} is private — not publishing.`);
    continue;
  }

  console.log(`--- ${pkg.name}@${pkg.version} (${pkgDir}) ---`);

  // Resume guard. npm rejects re-publishing an existing name@version with a
  // 403, so without this a run that dies partway (the common cause being a
  // 2FA OTP expiring mid-sequence — an OTP is good for ~30s and this
  // sequence includes a multi-MB upload) could never be retried: the retry
  // would stop at the first already-published package and the release would
  // be stranded half-done. Skipping what is verifiably already live makes
  // the script safely re-runnable.
  if (isLive) {
    let alreadyPublished = false;
    try {
      const out = execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      alreadyPublished = out.trim() === pkg.version;
    } catch {
      // Non-zero exit means "not published" (404). Anything else that goes
      // wrong here should not block a publish — fall through and let the
      // real publish surface the error.
    }
    if (alreadyPublished) {
      console.log(`[skip] ${pkg.name}@${pkg.version} is already on the registry.\n`);
      continue;
    }
  }

  const publishArgs = ['publish', '--access', 'public', '--no-git-checks'];
  if (!isLive) publishArgs.push('--dry-run');
  if (otp) publishArgs.push('--otp', otp);

  try {
    execFileSync('pnpm', publishArgs, { cwd, stdio: 'inherit' });
  } catch (err) {
    console.error(`\nPublish step failed for ${pkg.name}. Stopping (order matters — do not skip ahead).`);
    process.exit(1);
  }
  console.log();
}

console.log(isLive ? 'All packages published.' : 'Dry run complete — no packages were actually published.');
