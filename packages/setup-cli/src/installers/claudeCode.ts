// T4.1 step 4 — Claude Code leg. No config file to hand-edit here: the
// `~/.dmemo/config.json` this CLI already wrote (step 3) is picked up
// automatically by the plugin's hooks via `@dmemo/node-adapter`'s
// `loadDmemoEnv()` — Claude Code's own `userConfig.privateKey` prompt
// (`plugin.json`) is an alternative entry point, not a requirement. This
// installer's only job is getting the `dmemo` plugin itself installed.
//
// Per `research/followup-claude-code-packaging.md` §2, `claude plugin
// marketplace add <source>` / `claude plugin install <plugin>@<marketplace>`
// are documented as "scriptable" CI-safe CLI subcommands (mirrors the
// interactive `/plugin ...` slash commands) — so this installer attempts
// them automatically when the `claude` binary is present, but treats
// failure as non-fatal and always prints the manual fallback: the
// `dmemo-ai/claude-dmemo` marketplace repo doesn't exist on GitHub yet
// (T4.2 is local-only, by design — no repo/publish in this phase), so a
// live run today WILL fail here until a human completes RELEASE.md.

import { execFileSync } from 'node:child_process';
import { alreadyInstalled, failureText } from './idempotence.js';

const MARKETPLACE_SOURCE = 'dmemo-ai/claude-dmemo';
const MARKETPLACE_NAME = 'dmemo-plugins';
const PLUGIN_ID = 'dmemo';

export interface ClaudeCodeInstallResult {
  attempted: boolean;
  succeeded: boolean;
  /** True when the marketplace and/or plugin were already there — a re-run of
   * `dmemo setup`. Still `succeeded`, because the end state is the one we
   * wanted. */
  alreadyPresent?: boolean;
  output?: string;
  error?: string;
  manualInstructions: string;
  localDevInstructions: (pluginDir: string) => string;
}

function manualInstructions(): string {
  return [
    'Claude Code: install the dMemo plugin (once dmemo-ai/claude-dmemo is published):',
    `  claude plugin marketplace add ${MARKETPLACE_SOURCE}`,
    `  claude plugin install ${PLUGIN_ID}@${MARKETPLACE_NAME}`,
    '  (or inside a Claude Code session: /plugin marketplace add ' +
      `${MARKETPLACE_SOURCE}` +
      ' then /plugin install ' +
      PLUGIN_ID +
      ')',
    'No private key to paste: this CLI already wrote ~/.dmemo/config.json,',
    "which the plugin's hooks read automatically.",
  ].join('\n');
}

function localDevInstructions(pluginDir: string): string {
  return [
    'Local plugin path option (no marketplace, e.g. testing a checkout of',
    'the dMemo monorepo before it is published):',
    `  claude plugin marketplace add ${pluginDir}`,
    `  claude plugin install ${PLUGIN_ID}@${MARKETPLACE_NAME}`,
    '  # or launch Claude Code pointed straight at the plugin directory:',
    `  claude --plugin-dir ${pluginDir}`,
  ].join('\n');
}

export function installClaudeCode(env: NodeJS.ProcessEnv = process.env): ClaudeCodeInstallResult {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', env });
  } catch (err) {
    return {
      attempted: false,
      succeeded: false,
      error: err instanceof Error ? err.message : String(err),
      manualInstructions: manualInstructions(),
      localDevInstructions,
    };
  }

  /**
   * Runs one `claude plugin …` step. "Already added" / "already installed" is
   * success with `already: true` — re-running setup must reach the same end
   * state as the first run, and the previous single try/catch turned the
   * second run of a working install into a reported failure.
   */
  const run = (args: string[]): { ok: boolean; text: string; already: boolean } => {
    try {
      return {
        ok: true,
        text: execFileSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }),
        already: false,
      };
    } catch (err) {
      const detail = failureText(err);
      if (alreadyInstalled(detail)) return { ok: true, text: detail.trim(), already: true };
      return { ok: false, text: err instanceof Error ? err.message : String(err), already: false };
    }
  };

  const add = run(['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE]);
  if (!add.ok) {
    return {
      attempted: true,
      succeeded: false,
      error: add.text,
      manualInstructions: manualInstructions(),
      localDevInstructions,
    };
  }

  const install = run(['plugin', 'install', `${PLUGIN_ID}@${MARKETPLACE_NAME}`]);
  return {
    attempted: true,
    succeeded: install.ok,
    alreadyPresent: add.already || install.already,
    output: install.ok ? `${add.text}\n${install.text}` : undefined,
    error: install.ok ? undefined : install.text,
    manualInstructions: manualInstructions(),
    localDevInstructions,
  };
}
