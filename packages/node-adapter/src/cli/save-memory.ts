#!/usr/bin/env node
// Backing script for the `dmemo-save` skill (explicit, model-invoked save —
// "remember this"). Usage: node save-memory.cjs "TEXT TO REMEMBER".

import { withSession } from '../lib/dmemo.js';

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) {
    console.log('Usage: save-memory.cjs "<text to remember>"');
    return;
  }

  const ok = await withSession(async ({ session, scope }) => {
    await session.memory.add(text, { userId: scope, infer: false });
    session.flush();
    return true;
  });

  console.log(ok ? 'Saved to dMemo.' : 'dMemo is not configured (no DMEMO_PRIVATE_KEY) — save skipped.');
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch(() => {
    process.exitCode = 0;
  });
