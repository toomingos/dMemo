// T4.1 step 4 — OpenClaw leg. `openclaw plugins install <path-or-spec>` is
// the documented, scriptable install command
// (`$REPOS/openclaw/docs/cli/plugins.md:36`), so this installer runs it
// best-effort — non-fatal, because the package isn't published to npm yet,
// so a live run today will legitimately fail until a human completes
// RELEASE.md.
//
// This file used to ALSO print manual instructions telling the user to
// hand-edit `plugins.slots.memory = "dmemo"` and
// `plugins.entries.dmemo.config`, on the theory that OpenClaw's config shape
// for slot selection "wasn't pinned down" by research. That justification is
// now disproven by source, not just assumed away:
//
//   - Docs, describing the equivalent official memory plugin: "Installing it
//     writes the plugin entry, enables it, and switches
//     `plugins.slots.memory` to `memory-lancedb`. If another plugin
//     currently owns the memory slot, that plugin is disabled with a
//     warning." (`$REPOS/openclaw/docs/plugins/memory-lancedb.md:24-27`)
//   - Mechanism: install runs `applySlotSelectionForPlugin` (per-plugin
//     entry point, `$REPOS/openclaw/src/plugins/slot-selection.ts`), which
//     looks up the plugin's declared `kind` and calls
//     `applyExclusiveSlotSelection` (`$REPOS/openclaw/src/plugins/slots.ts`)
//     to point `plugins.slots.memory` at that plugin's id and disable
//     whichever plugin owned the slot before.
//   - Our manifest (`packages/openclaw-plugin/openclaw.plugin.json`) already
//     declares `"kind": "memory"`, exactly like mem0's
//     (`$REPOS/mem0/integrations/openclaw/openclaw.plugin.json`).
//
// So `openclaw plugins install @dmemo/openclaw-plugin` claims the memory
// slot as a side effect of installing — no manual config-editing step is
// needed for that part. This installer no longer prints those instructions.
//
// It DOES still verify the slot was actually claimed rather than assume it,
// because "install exited 0" and "the slot points at us" are not the same
// fact, and the whole reason this file is being rewritten is that a past
// version of this codebase asserted something about OpenClaw's config
// behavior without checking. The real way to check a live config value
// non-interactively is `openclaw config get <path> --json`
// (`$REPOS/openclaw/src/cli/config-cli.ts`, `runConfigGet` — prints the
// value as JSON on stdout, `1` exit / `{"error": ...}` on a missing path),
// so we read `plugins.slots.memory` back after install and compare it to our
// plugin id.
//
// The one thing install genuinely does NOT set — because it is a user
// secret, not install's job — is the wallet key the plugin needs to talk to
// 0G. That guidance still needs to be printed.

import { execFileSync } from 'node:child_process';
import { alreadyInstalled, failureText } from './idempotence.js';

const PLUGIN_SPEC = '@dmemo/openclaw-plugin';
const PLUGIN_ID = 'dmemo';
const MEMORY_SLOT_PATH = 'plugins.slots.memory';

export interface OpenClawInstallResult {
  attempted: boolean;
  /** True only once install ran AND the memory slot was verified to point at
   * `dmemo` — matching the "verify, don't assume" behavior described above. */
  succeeded: boolean;
  /** Set once the post-install slot check ran, regardless of outcome. */
  slotClaimed?: boolean;
  /** What `plugins.slots.memory` actually reads as, when the check ran but
   * didn't match — lets a caller tell "another plugin still owns the slot"
   * apart from "the verification read itself failed". */
  slotOwner?: string;
  /** True when the plugin was already tracked and we replaced/updated it in
   * place instead of failing — the re-run case. */
  replaced?: boolean;
  output?: string;
  error?: string;
  /** What install does NOT set for the user (the wallet key) — always
   * present so the setup CLI can print it regardless of outcome. */
  configGuidance: string;
}

function configGuidance(): string {
  return [
    'OpenClaw: set the wallet key the plugin needs to talk to 0G (install',
    'claims the memory slot for you, but never sets secrets):',
    `  plugins.entries.${PLUGIN_ID}.config.privateKey`,
    '  dMemo already wrote ~/.dmemo/config.json with DMEMO_PRIVATE_KEY — export',
    '  it into the environment OpenClaw runs in, or reference it with a',
    '  SecretRef instead of pasting the key value directly',
    '  (see packages/openclaw-plugin/README.md).',
  ].join('\n');
}

function manualInstallInstructions(): string {
  return [
    'OpenClaw: install the dMemo memory plugin:',
    `  openclaw plugins install ${PLUGIN_SPEC}`,
    '  (this claims the memory slot automatically; no config hand-editing',
    '  needed for that part)',
    '',
    configGuidance(),
  ].join('\n');
}

function readMemorySlotOwner(env: NodeJS.ProcessEnv): string | undefined {
  const raw = execFileSync('openclaw', ['config', 'get', MEMORY_SLOT_PATH, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const value = JSON.parse(raw);
  return typeof value === 'string' ? value : undefined;
}

export function installOpenClaw(env: NodeJS.ProcessEnv = process.env): OpenClawInstallResult {
  try {
    execFileSync('openclaw', ['--version'], { stdio: 'ignore', env });
  } catch (err) {
    return {
      attempted: false,
      succeeded: false,
      error: err instanceof Error ? err.message : String(err),
      configGuidance: manualInstallInstructions(),
    };
  }

  const run = (args: string[]): string =>
    execFileSync('openclaw', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

  let output: string;
  let replaced = false;
  try {
    output = run(['plugins', 'install', PLUGIN_SPEC]);
  } catch (err) {
    const detail = failureText(err);
    if (!alreadyInstalled(detail)) {
      return {
        attempted: true,
        succeeded: false,
        error: err instanceof Error ? err.message : String(err),
        configGuidance: manualInstallInstructions(),
      };
    }

    // The plugin is already tracked — a re-run of `dmemo setup`, not a
    // problem. OpenClaw names the two commands that do work in that state
    // ("rerun install with '--force'", or "plugins update"), so run them
    // rather than surfacing its refusal as a failed step. `--force` first:
    // it replaces the checkout with exactly the spec we asked for, where
    // `update` re-resolves and may no-op if the registry looks unchanged.
    replaced = true;
    try {
      output = run(['plugins', 'install', PLUGIN_SPEC, '--force']);
    } catch (forceErr) {
      try {
        output = run(['plugins', 'update', PLUGIN_SPEC]);
      } catch {
        return {
          attempted: true,
          succeeded: false,
          error:
            `the plugin is already installed, and neither replacing it ` +
            `(\`openclaw plugins install ${PLUGIN_SPEC} --force\`) nor updating it ` +
            `(\`openclaw plugins update ${PLUGIN_SPEC}\`) worked: ` +
            (forceErr instanceof Error ? forceErr.message : String(forceErr)),
          configGuidance: manualInstallInstructions(),
        };
      }
    }
  }

  try {
    const slotOwner = readMemorySlotOwner(env);
    const slotClaimed = slotOwner === PLUGIN_ID;
    return {
      attempted: true,
      succeeded: slotClaimed,
      slotClaimed,
      slotOwner,
      replaced,
      output,
      error: slotClaimed
        ? undefined
        : `openclaw plugins install reported success, but ${MEMORY_SLOT_PATH} is ` +
          `"${slotOwner}", not "${PLUGIN_ID}" — the memory slot was not claimed.`,
      configGuidance: configGuidance(),
    };
  } catch (err) {
    return {
      attempted: true,
      succeeded: false,
      replaced,
      output,
      error:
        `install reported success, but verifying ${MEMORY_SLOT_PATH} failed: ` +
        (err instanceof Error ? err.message : String(err)),
      configGuidance: configGuidance(),
    };
  }
}
