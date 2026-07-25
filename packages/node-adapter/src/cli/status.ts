#!/usr/bin/env node
// Backing script for the `/dmemo:status` command.

import { loadDmemoEnv, isConfigured, resolveScope } from '../lib/settings.js';
import { withSession } from '../lib/dmemo.js';

async function main(): Promise<void> {
  const env = loadDmemoEnv();
  if (!isConfigured(env)) {
    console.log('dMemo: not configured. Set DMEMO_PRIVATE_KEY (see `npx dmemo setup`).');
    return;
  }

  console.log(`dMemo: configured`);
  console.log(`  network: ${env.DMEMO_NETWORK ?? 'testnet'}`);
  console.log(`  scope:   ${resolveScope(env)}`);

  const stats = await withSession(async ({ session }) => {
    const all = await session.memory.getAll({ filters: { user_id: resolveScope(env) }, topK: 1000 });
    return {
      memoryCount: all.results.length,
      restored: session.restoreStats.restored,
      chainLength: session.restoreStats.chainLength,
      restoreMs: Math.round(session.restoreStats.totalMs),
    };
  });

  if (stats) {
    console.log(`  memories: ${stats.memoryCount}`);
    console.log(`  restored: ${stats.restored} (chain length ${stats.chainLength}, ${stats.restoreMs}ms)`);
  } else {
    console.log('  (failed to open session — see DMEMO_DEBUG=true logs at ~/.dmemo/hooks.log)');
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch(() => {
    process.exitCode = 0;
  });
