// T4.1 step 4 — OpenClaw leg. `research/openclaw.md` documents
// `openclaw plugins install @<org>/<pkg>` as the install command, so this
// installer attempts it best-effort (non-fatal — the package isn't
// published to npm yet, so a live run today will legitimately fail until a
// human completes RELEASE.md).
//
// Unlike OpenCode's `opencode.json` (a confirmed, documented global-config
// path/shape), OpenClaw's config *file* location and on-disk format for
// `plugins.slots.memory` / `plugins.entries.dmemo.config` were not pinned
// down to a specific path in the T3.3 research pass (`research/openclaw.md`
// cites the *keys*, e.g. `plugins.slots.memory`, via doc line references,
// not a concrete `~/.openclaw/config.*` file to parse-and-merge). Rather
// than guess a schema and risk corrupting a user's real OpenClaw config,
// this installer prints the exact manual steps (mirrors
// `packages/openclaw-plugin/README.md`) instead of writing a file. This is
// a deliberate, narrower scope than the Codex/OpenCode installers — see the
// Phase 4 final report "deviations" section.

import { execFileSync } from 'node:child_process';

const PLUGIN_SPEC = '@dmemo/openclaw-plugin';

export interface OpenClawInstallResult {
  attempted: boolean;
  succeeded: boolean;
  output?: string;
  error?: string;
  manualInstructions: string;
}

function manualInstructions(): string {
  return [
    'OpenClaw: install + register the dMemo memory plugin:',
    `  openclaw plugins install ${PLUGIN_SPEC}`,
    '  Then add to your OpenClaw config (see packages/openclaw-plugin/README.md):',
    '    plugins.slots.memory = "dmemo"',
    '    plugins.entries.dmemo.config = {',
    '      privateKey: "${DMEMO_PRIVATE_KEY}",  // or paste directly (not recommended)',
    '      scope: "default",',
    '      network: "testnet"',
    '    }',
    '  dMemo already wrote ~/.dmemo/config.json with DMEMO_PRIVATE_KEY — export it',
    '  into the environment OpenClaw runs in, or reference the key value directly.',
  ].join('\n');
}

export function installOpenClaw(env: NodeJS.ProcessEnv = process.env): OpenClawInstallResult {
  let attempted = false;
  let succeeded = false;
  let output: string | undefined;
  let error: string | undefined;

  try {
    execFileSync('openclaw', ['--version'], { stdio: 'ignore', env });
    attempted = true;
    output = execFileSync('openclaw', ['plugins', 'install', PLUGIN_SPEC], { encoding: 'utf8', env });
    succeeded = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { attempted, succeeded, output, error, manualInstructions: manualInstructions() };
}
