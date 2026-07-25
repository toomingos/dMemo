import { ethers } from 'ethers';
import { DmemoSession } from '../../packages/core/dist/index.js';
import { startServer } from '../shim/server.mjs';

const w = ethers.Wallet.createRandom();
const session = await DmemoSession.open({
  privateKey: w.privateKey,
  scope: 'dmemo-smoke',
  network: 'testnet',
  embedder: { provider: 'fastembed', model: 'fast-bge-small-en-v1.5' },
  pointerCachePath: '/private/tmp/claude-501/-Users-tomasdomingos-dMemo/dfa56a0a-2e10-44e9-be3a-2ce6edf47970/scratchpad/dry-run-pointer-cache.json',
});
console.log('session opened, restored=', session.restoreStats.restored);
const state = { session };
const server = await startServer(state, 8901);
console.log('shim listening on 8901');
process.stdin.resume(); // keep alive until killed
