// Per-host wiring, shared by `dmemo setup` (step 4) and `dmemo connect`.
// Extracted verbatim from setup.ts so the two entry points cannot drift —
// a host supported by one but silently skipped by the other is exactly the
// kind of bug that only shows up as "memory works on my machine".
//
// Every installer is best-effort: a host that fails to wire up must not
// abort the run, because the config on disk is already valid and the user
// can install that host by hand.

import { detectHosts } from './hostDetect.js';
import { installCodex } from './installers/codex.js';
import { installOpenCode } from './installers/opencode.js';
import { installClaudeCode } from './installers/claudeCode.js';
import { installOpenClaw } from './installers/openclaw.js';

export interface InstalledHosts {
  claudeCode?: Awaited<ReturnType<typeof installClaudeCode>>;
  codex?: Awaited<ReturnType<typeof installCodex>> | { error: string };
  opencode?: Awaited<ReturnType<typeof installOpenCode>>;
  openclaw?: Awaited<ReturnType<typeof installOpenClaw>>;
}

export function installDetectedHosts(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void
): InstalledHosts {
  const hosts: InstalledHosts = {};
  const detected = detectHosts(env);
  log(
    `Detected hosts: ${
      Object.entries(detected)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ') || '(none)'
    }`
  );

  if (detected.codex) {
    try {
      hosts.codex = installCodex(env);
      log(`Codex: installed hooks into ${(hosts.codex as { hooksFile: string }).hooksFile}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hosts.codex = { error: message };
      log(`Codex: installer failed (non-fatal): ${message}`);
    }
  }
  if (detected.opencode) {
    hosts.opencode = installOpenCode(env);
    if (hosts.opencode.succeeded) {
      log(
        `OpenCode: plugin installed (${hosts.opencode.specUsed}${
          hosts.opencode.usedLocalFallback ? ', local monorepo fallback' : ''
        }).`
      );
    } else {
      if (hosts.opencode.attempted) {
        log(`OpenCode: install did not complete as expected (non-fatal): ${hosts.opencode.error}`);
      }
      log(hosts.opencode.manualInstructions);
    }
  }
  if (detected.claudeCode) {
    hosts.claudeCode = installClaudeCode(env);
    log(hosts.claudeCode.succeeded ? 'Claude Code: plugin installed.' : hosts.claudeCode.manualInstructions);
  }
  if (detected.openclaw) {
    hosts.openclaw = installOpenClaw(env);
    if (hosts.openclaw.succeeded) {
      log('OpenClaw: plugin installed, memory slot claimed.');
    } else if (hosts.openclaw.attempted) {
      // Binary was there and `plugins install` ran, but something after
      // that didn't check out (install itself failed, or the slot
      // verification says another plugin still owns it) — surface the
      // specific reason rather than a generic "not installed".
      log(`OpenClaw: install did not complete as expected (non-fatal): ${hosts.openclaw.error}`);
    }
    log(hosts.openclaw.configGuidance);
  }
  if (!detected.codex && !detected.opencode && !detected.claudeCode && !detected.openclaw) {
    log('No supported host detected on this machine — memory config is ready for whenever you install one.');
  }

  return hosts;
}
