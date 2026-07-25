#!/usr/bin/env node
// Child process for T5.1 test 4 (crash recovery). Never invoked directly —
// spawned by test-crash-recovery.mjs, which SIGKILLs it right after it
// prints READY_TO_KILL (i.e. strictly between the final add() and the flush
// that would have persisted it). Reads its private key from an env var
// (never argv, never a file) so it never appears in `ps`/shell history.

import { DmemoSession } from '@dmemo/core';
import { TURN1, TURN2, TURN3 } from '../lib/crash-fixtures.mjs';

const privateKey = process.env.DMEMO_TEST_PRIVATE_KEY;
const scope = process.env.DMEMO_TEST_SCOPE;
const pointerCachePath = process.env.DMEMO_TEST_POINTER_CACHE;
if (!privateKey || !scope || !pointerCachePath) {
  console.error('worker-crash-child: missing required env vars');
  process.exit(2);
}

async function main() {
  const session = await DmemoSession.open({ privateKey, scope, network: 'testnet', pointerCachePath });

  await session.memory.add(TURN1, { userId: scope, infer: false });
  session.flush();
  await session.waitForPendingFlush();

  await session.memory.add(TURN2, { userId: scope, infer: false });
  session.flush();
  await session.waitForPendingFlush();

  // Deliberately: add() but do NOT call flush(). Signal readiness, then hang
  // so the parent's SIGKILL lands strictly between this add() and any flush.
  await session.memory.add(TURN3, { userId: scope, infer: false });
  console.log('READY_TO_KILL');
  await new Promise(() => {}); // never resolves — parent kills us here
}

main().catch((err) => {
  console.error(`worker-crash-child: uncaught error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
