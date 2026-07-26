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
import { dim, indent, red, status, tildify, wrap } from './theme.js';

/** `detectHosts` keys are camelCase internals; these are what the user is
 * shown, and they match how each tool names itself on the command line. */
const DISPLAY: Record<string, string> = {
  claudeCode: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  openclaw: 'openclaw',
};

/** Widest label, so the outcomes line up in a column. */
const LABEL = Math.max(...Object.values(DISPLAY).map((n) => n.length));

const pad = (name: string): string => name.padEnd(LABEL);

/**
 * A failed install: a marked, indented cause under the host's own line, so it
 * reads as one host's problem rather than as loose output from the run.
 *
 * The cause text is still printed in full. Collapsing it to a single line
 * needs somewhere for the detail to go, and `--verbose` does not exist yet —
 * that pairing lands together rather than dropping diagnostics now and
 * restoring them later.
 */
function failure(log: (line: string) => void, name: string, cause: string, guidance?: string): void {
  log(status('bad', pad(name)));
  for (const line of dedupeLines(cause)) {
    log(red(wrap(line, 5)));
  }
  // Guidance is not more error text — it is the manual procedure that gets
  // this host working — so it is separated and dimmed rather than stacked
  // into the red block above. `indent`, not `wrap`: these are commands and
  // config paths whose line breaks already mean something.
  if (guidance?.trim()) {
    log('');
    log(dim(indent(guidance.trim(), 5)));
  }
  log('');
}

/**
 * Installers wrap a child's stderr into their error message, and that stderr
 * is frequently already a repeat of itself — one missing npm package produced
 * the same two sentences twice inside a single message. Identical lines say
 * nothing the first one didn't.
 */
function dedupeLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

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
  const names = Object.entries(detected)
    .filter(([, v]) => v)
    .map(([k]) => k);

  if (names.length === 0) {
    log(status('skip', 'no supported agent found on this machine'));
    log(dim(wrap('The memory config is ready for whenever you install one — re-run `npx @dmemo/cli setup` then.', 4)));
    return hosts;
  }

  log(dim(`  found ${names.length}: ${names.map((n) => DISPLAY[n] ?? n).join(', ')}`));

  if (detected.claudeCode) {
    hosts.claudeCode = installClaudeCode(env);
    if (hosts.claudeCode.succeeded) log(status('ok', pad('claude-code'), 'plugin installed'));
    else failure(log, 'claude-code', 'plugin not installed', hosts.claudeCode.manualInstructions);
  }

  if (detected.codex) {
    try {
      hosts.codex = installCodex(env);
      log(status('ok', pad('codex'), `hooks → ${tildify((hosts.codex as { hooksFile: string }).hooksFile, env)}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hosts.codex = { error: message };
      failure(log, 'codex', message);
    }
  }

  if (detected.opencode) {
    hosts.opencode = installOpenCode(env);
    if (hosts.opencode.succeeded) {
      log(
        status(
          'ok',
          pad('opencode'),
          `plugin installed${hosts.opencode.usedLocalFallback ? ' (local monorepo fallback)' : ''}`
        )
      );
    } else {
      failure(
        log,
        'opencode',
        hosts.opencode.attempted ? (hosts.opencode.error ?? 'install did not complete') : 'plugin not installed',
        hosts.opencode.manualInstructions
      );
    }
  }

  if (detected.openclaw) {
    hosts.openclaw = installOpenClaw(env);
    if (hosts.openclaw.succeeded) {
      log(status('ok', pad('openclaw'), 'plugin installed, memory slot claimed'));
      // Success still leaves the user one manual step: install claims the
      // slot but never sets secrets.
      log(dim(indent(hosts.openclaw.configGuidance.trim(), 5)));
    } else {
      // Binary was there and `plugins install` ran, but something after that
      // didn't check out (install itself failed, or the slot verification
      // says another plugin still owns it) — surface the specific reason
      // rather than a generic "not installed".
      failure(
        log,
        'openclaw',
        hosts.openclaw.attempted ? (hosts.openclaw.error ?? 'install did not complete') : 'plugin not installed',
        hosts.openclaw.configGuidance
      );
    }
  }

  return hosts;
}
