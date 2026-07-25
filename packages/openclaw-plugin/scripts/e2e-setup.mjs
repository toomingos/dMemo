#!/usr/bin/env node
// E2E test setup (local only):
//  1. Generates a fresh ephemeral wallet and funds it from spike/.env, so the
//     0G memory chain for this test starts genuinely empty and is isolated
//     from the wallet the Claude Code hooks use concurrently (TASKS.md
//     gotcha 18: one wallet == one chain; `scope` does NOT partition storage).
//  2. esbuild-bundles the INSTRUMENTED entry (scripts/e2e-observe-entry.ts)
//     into ~/.dmemo/openclaw-plugin-local and installs it into OpenClaw with
//     `openclaw plugins install --force` (same staging technique as
//     scripts/install-adapters-local.mjs).
//
// The private key is written only to ~/.dmemo/e2e-openclaw.env (mode 0600)
// and never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(PKG_DIR, '../..');
const HOME = process.env.HOME ?? os.homedir();
const DMEMO_HOME = process.env.DMEMO_HOME ?? path.join(HOME, '.dmemo');
const ENV_FILE = path.join(DMEMO_HOME, 'e2e-openclaw.env');
const FUND_AMOUNT = ethers.parseEther('0.05'); // ~40x a single measured flush

function bin(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return path.join(HOME, '.openclaw', 'bin', name);
  }
}

async function fundEphemeralWallet() {
  const raw = fs.readFileSync(path.join(REPO, 'spike', '.env'), 'utf8');
  const funderKey = raw.match(/^PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
  if (!funderKey) throw new Error('PRIVATE_KEY not found in spike/.env');

  const provider = new ethers.JsonRpcProvider('https://evmrpc-testnet.0g.ai');
  const funder = new ethers.Wallet(funderKey, provider);
  const ephemeral = ethers.Wallet.createRandom();

  console.log(`[e2e] funding fresh wallet ${ephemeral.address} with 0.05 0G ...`);
  const tx = await funder.sendTransaction({ to: ephemeral.address, value: FUND_AMOUNT });
  await tx.wait();
  console.log(`[e2e] funded (tx ${tx.hash})`);

  fs.mkdirSync(DMEMO_HOME, { recursive: true });
  fs.writeFileSync(
    ENV_FILE,
    `DMEMO_PRIVATE_KEY=${ephemeral.privateKey}\nDMEMO_ADDRESS=${ephemeral.address}\nDMEMO_NETWORK=testnet\n`,
    { mode: 0o600 }
  );
  console.log(`[e2e] wrote ${ENV_FILE} (0600) — address ${ephemeral.address}`);
  return ephemeral.address;
}

function stageInstrumentedBundle() {
  const esbuild = createRequire(path.join(REPO, 'packages', 'node-adapter', 'package.json'))('esbuild');
  const externals = JSON.parse(
    fs.readFileSync(path.join(REPO, 'packages', 'node-adapter', 'scripts', 'externals.json'), 'utf8')
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

  const staging = path.join(DMEMO_HOME, 'openclaw-plugin-local');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'dist'), { recursive: true });

  esbuild.buildSync({
    entryPoints: [path.join(PKG_DIR, 'scripts', 'e2e-observe-entry.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(staging, 'dist', 'index.js'),
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
    logLevel: 'warning',
  });

  fs.writeFileSync(
    path.join(staging, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        type: 'module',
        license: pkg.license,
        openclaw: pkg.openclaw,
      },
      null,
      2
    ) + '\n'
  );
  for (const f of ['openclaw.plugin.json', 'LICENSE', 'README.md']) {
    const src = path.join(PKG_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(staging, f));
  }
  const bytes = fs.statSync(path.join(staging, 'dist', 'index.js')).size;
  console.log(`[e2e] staged instrumented bundle (${(bytes / 1024).toFixed(0)} KB) at ${staging}`);
  return staging;
}

// Gotcha 17 / install-adapters-local.mjs `linkNativeDepsInto`: better-sqlite3
// and fastembed stay `external` in the bundle (native .node bindings can't be
// inlined), and a real `node_modules` symlink next to the running bundle is
// the only mechanism BOTH the CJS `require()` and the ESM dynamic `import()`
// resolvers honour. `openclaw plugins install` recreates the extension dir, so
// this must be re-done after EVERY install.
//
// This throws on failure (unlike install-adapters-local.mjs's best-effort
// version) because this is a test harness verifying real behavior — a
// swallowed failure here would silently invalidate whatever the e2e run
// measures. A present symlink is necessary but not sufficient (a
// stale/partial ~/.dmemo/native from a failed npm install would still pass
// an existence check), so verify actual resolution, not just the symlink.
function linkNativeDeps() {
  const dir = path.join(process.env.OPENCLAW_HOME ?? path.join(HOME, '.openclaw'), 'extensions', 'dmemo');
  const target = path.join(DMEMO_HOME, 'native', 'node_modules');
  if (!fs.existsSync(dir) || !fs.existsSync(target)) {
    throw new Error(`cannot link native deps: missing ${!fs.existsSync(dir) ? dir : target}`);
  }
  const link = path.join(dir, 'node_modules');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, 'dir');
  console.log(`[e2e] linked native deps: ${link} -> ${target}`);

  const req = createRequire(path.join(dir, 'package.json'));
  const missing = ['better-sqlite3', 'fastembed'].filter((pkg) => {
    try {
      req.resolve(pkg);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(`linked ${link} -> ${target}, but ${missing.join(', ')} still fail to resolve from it`);
  }
  console.log('[e2e] verified: better-sqlite3 + fastembed resolve from the installed plugin dir');
}

async function main() {
  const skipFund = process.argv.includes('--skip-fund');
  if (!skipFund) await fundEphemeralWallet();
  const staging = stageInstrumentedBundle();
  execFileSync(bin('openclaw'), ['plugins', 'install', '--force', staging], { stdio: 'inherit' });
  linkNativeDeps();
  console.log('[e2e] installed into OpenClaw.');
}

main().catch((err) => {
  console.error('[e2e] setup FAILED:', err?.message ?? err);
  process.exitCode = 1;
});
