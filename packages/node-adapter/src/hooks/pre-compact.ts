#!/usr/bin/env node
// PreCompact hook: capture-before-compaction, same write-back path as Stop
// (T3.1) — a compaction is about to discard transcript context, so this is
// a second, defensive capture point in addition to the per-turn Stop
// write-back. Fails open.

import { readStdin } from '../lib/stdin.js';
import { captureTurn } from '../lib/capture.js';
import { debugLog } from '../lib/settings.js';

async function main(): Promise<void> {
  const input = await readStdin();
  await captureTurn(input, 'pre-compact');
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    debugLog('pre-compact: uncaught error, fail-open', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 0;
  });
