#!/usr/bin/env node
// UserPromptSubmit hook: deterministic top-5 search(prompt) on every turn
// (mem0-plugin's behavior, NOT claude-supermemory's model-gated recall
// directive — T3.1 is explicit about this). Fails open.

import { readStdin, writeOutput } from '../lib/stdin.js';
import { withSession, isSubagentInvocation } from '../lib/dmemo.js';
import { debugLog } from '../lib/settings.js';

const TOP_K = 5;
const MIN_PROMPT_LENGTH = 8; // acknowledgements/short replies aren't worth a search round trip

async function main(): Promise<void> {
  const input = await readStdin();
  if (isSubagentInvocation(input)) return;

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (prompt.trim().length < MIN_PROMPT_LENGTH) return;

  const context = await withSession(async ({ session, scope }) => {
    const result = await session.memory.search(prompt, { filters: { user_id: scope }, topK: TOP_K });
    if (!result.results.length) return null;
    const lines = result.results.map((m: { memory: string }) => `- ${m.memory}`);
    return `Potentially relevant memory (dMemo):\n${lines.join('\n')}`;
  });

  if (context) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    });
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    debugLog('user-prompt-submit: uncaught error, fail-open', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 0;
  });
