// T4.1 step 4 — Codex leg. Codex has no plugin marketplace/registry of its
// own (unlike Claude Code); it only discovers hooks by reading
// `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) directly (see
// `packages/node-adapter/src/codex/install.ts`, T3.1). That installer ships
// as a pre-built, dependency-free `.cjs` (esbuild-bundled) inside the
// `claude-dmemo` marketplace repo's `plugin/scripts/` — this CLI vendors a
// copy of just the Codex-relevant files (see
// `scripts/vendor-codex-plugin.mjs`) so `dmemo setup` can wire Codex with
// zero network dependency, before that repo is even published.
//
// We copy the vendored bundle into `${DMEMO_HOME}/codex-plugin/` (a stable,
// persistent location — NOT this npm package's own install directory, which
// can be pruned/reinstalled by the package manager) and point Codex's
// hooks.json commands at that copy, then run the installer exactly as
// documented in its own header comment (`node install-codex-hooks.cjs`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dmemoHome } from '../dmemoConfig.js';
import { codexHome } from '../hostDetect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** This file lives at `dist/installers/codex.js` after build; the vendored
 * bundle ships at `<package root>/vendor/codex-plugin/`. */
function vendoredCodexPluginDir(): string {
  return path.resolve(__dirname, '..', '..', 'vendor', 'codex-plugin');
}

function copyRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, entry.name.endsWith('.cjs') ? 0o755 : 0o644);
    }
  }
}

export interface CodexInstallResult {
  installedPluginDir: string;
  hooksFile: string;
  stdout: string;
}

export function installCodex(env: NodeJS.ProcessEnv = process.env): CodexInstallResult {
  const vendorDir = vendoredCodexPluginDir();
  if (!fs.existsSync(path.join(vendorDir, 'scripts', 'install-codex-hooks.cjs'))) {
    throw new Error(
      `vendored Codex plugin scripts not found at ${vendorDir} — this dmemo build is broken ` +
        `(run 'pnpm --filter dmemo run prebuild' in the monorepo, or reinstall the package)`
    );
  }

  const destDir = path.join(dmemoHome(env), 'codex-plugin');
  copyRecursive(vendorDir, destDir);

  const installerPath = path.join(destDir, 'scripts', 'install-codex-hooks.cjs');
  const codexHomeDir = codexHome(env);

  const stdout = execFileSync('node', [installerPath], {
    env: { ...env, CODEX_HOME: codexHomeDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    installedPluginDir: destDir,
    hooksFile: path.join(codexHomeDir, 'hooks.json'),
    stdout,
  };
}

export function uninstallCodex(env: NodeJS.ProcessEnv = process.env): string {
  const destDir = path.join(dmemoHome(env), 'codex-plugin');
  const installerPath = path.join(destDir, 'scripts', 'install-codex-hooks.cjs');
  if (!fs.existsSync(installerPath)) {
    return 'no dMemo Codex install found, nothing to uninstall';
  }
  const codexHomeDir = codexHome(env);
  return execFileSync('node', [installerPath, '--uninstall'], {
    env: { ...env, CODEX_HOME: codexHomeDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
