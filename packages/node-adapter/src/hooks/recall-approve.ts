#!/usr/bin/env node
// PreToolUse hook (matcher "Skill|Bash"): auto-approve the read-only
// dmemo-search skill / its backing `search-memory.cjs` Bash invocation, so
// the deterministic recall path never stalls on a permission prompt.
// Ported pattern from claude-supermemory's recall-approve.js. Anything that
// isn't recognizably a dMemo search falls through with `continue: true` —
// this hook never blocks or grants permission for anything else.

import { readStdin, writeOutput } from '../lib/stdin.js';
import { debugLog } from '../lib/settings.js';

const SEARCH_BASH_RE = /node[\s\S]*search-memory\.cjs/;
const SHELL_OPS = /[;&|`>]|\$\(/;
const SEARCH_SKILL = 'dmemo-search';

function isDmemoSearch(toolName: unknown, toolInput: unknown): boolean {
  if (toolName === 'Skill') {
    return JSON.stringify(toolInput ?? {}).includes(SEARCH_SKILL);
  }
  if (toolName === 'Bash') {
    const cmd = String((toolInput as { command?: unknown })?.command ?? '');
    return SEARCH_BASH_RE.test(cmd) && !SHELL_OPS.test(cmd);
  }
  return false;
}

async function main(): Promise<void> {
  const input = await readStdin();

  if (isDmemoSearch(input.tool_name, input.tool_input)) {
    debugLog('recall-approve: auto-approving', { toolName: input.tool_name });
    writeOutput({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'dMemo deterministic recall runs automatically (read-only memory search).',
      },
    });
    return;
  }

  writeOutput({ continue: true, suppressOutput: true });
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch(() => {
    writeOutput({ continue: true, suppressOutput: true });
    process.exitCode = 0;
  });
