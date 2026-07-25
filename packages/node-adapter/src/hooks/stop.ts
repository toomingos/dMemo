#!/usr/bin/env node
// Stop hook: read stdin JSON (transcript_path, last_assistant_message,
// session_id), extract the new turn, add() + flush(). This is the ONLY
// write-back point (gotcha 9 — never SessionEnd/Codex's 3s-capped hook).
// Fails open.

import { readStdin } from '../lib/stdin.js';
import { captureTurn } from '../lib/capture.js';
import { debugLog } from '../lib/settings.js';

async function main(): Promise<void> {
  const input = await readStdin();
  await captureTurn(input, 'stop');
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    debugLog('stop: uncaught error, fail-open', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 0;
  });
