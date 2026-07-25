#!/usr/bin/env node
// SessionStart hook (Claude Code + Codex, CC-schema-compatible): open a
// dMemo session, fetch a top-N memory summary, inject it as
// `additionalContext`. Fails open on any error (unconfigured wallet,
// native-module bootstrap failure, empty memory store, subagent session).

import { readStdin, writeOutput } from '../lib/stdin.js';
import { withSession, isSubagentInvocation } from '../lib/dmemo.js';
import { debugLog } from '../lib/settings.js';

const TOP_N = 10;

async function main(): Promise<void> {
  const input = await readStdin();
  if (isSubagentInvocation(input)) return;

  const summary = await withSession(async ({ session, scope }) => {
    const result = await session.memory.getAll({ filters: { user_id: scope }, topK: TOP_N });
    if (!result.results.length) return null;
    const lines = result.results.map((m: { memory: string }) => `- ${m.memory}`);
    return `Relevant memory from previous sessions (dMemo):\n${lines.join('\n')}`;
  });

  if (summary) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: summary,
      },
    });
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    // Gotcha 12: process.exitCode only, never process.exit() (fastembed's
    // onnxruntime native teardown SIGABRTs on process.exit()).
    debugLog('session-start: uncaught error, fail-open', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 0;
  });
