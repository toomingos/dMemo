#!/usr/bin/env node
// dMemo live demo — the 90-second story, on the real 0G Galileo testnet.
//
//   1. an agent learns things about you (mem0 OSS, local embeddings)
//   2. its memory is flushed to 0G Storage — encrypted to your wallet key
//   3. the on-chain bytes are provably ciphertext (grep finds nothing;
//      a stranger's wallet can't decrypt)
//   4. "new machine": a fresh session restores everything from the chain
//      with nothing but the wallet key
//
// Run from the repo root:  pnpm demo
// (needs spike/.env with a funded testnet wallet — see README quickstart)
//
// SECURITY: no private key (spike or ephemeral) is ever printed.

import { ethers } from 'ethers';
import { Indexer } from '@0gfoundation/0g-ts-sdk';
import { DmemoSession, StorageClient, decodeBlob } from '@dmemo/core';
import { fundEphemeralWallet, fmtEther, TESTNET_NETWORK_CONFIG } from '../lib/common.mjs';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function banner(n, title) {
  console.log(`\n${BOLD}${CYAN}━━ ${n}. ${title} ${'━'.repeat(Math.max(2, 58 - title.length))}${RESET}`);
}
function ok(msg) {
  console.log(`${GREEN}  ✓${RESET} ${msg}`);
}
function info(msg) {
  console.log(`${DIM}    ${msg}${RESET}`);
}

// The 0G SDK logs verbose upload/download progress straight to console.
// Silence it around SDK-heavy calls so the demo output stays narratable.
async function quiet(fn) {
  const saved = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const MEMORIES = [
  'Tomas prefers pnpm workspaces — never run npm install in this monorepo.',
  'TypeScript strict mode is mandatory, including noUncheckedIndexedAccess.',
  'The rate-limiter bug was fixed by switching to a Redis sliding window.',
  'Deploys go through the Helm chart in deploy/helm; staging first, always.',
  'Tomas drinks espresso while debugging — suggest breaks after long sessions.',
  'The secret demo codeword is octopus-umbrella.',
];
const QUERY = 'what package manager does this project use?';
const SCOPE = 'demo';
const USER = 'demo-user';

async function search(session, q) {
  const r = await session.memory.search(q, { filters: { user_id: USER }, topK: 3 });
  return r.results.map((m) => ({ id: m.id, score: m.score, memory: m.memory }));
}

async function main() {
  const t0 = performance.now();

  banner(1, 'Your memory is a wallet');
  console.log('  dMemo has no accounts and no server. A wallet key IS the memory identity.');
  const { privateKey, address, provider, fundedWei } = await fundEphemeralWallet('0.05');
  ok(`fresh demo wallet ${address} funded on 0G Galileo testnet (chain 16602)`);
  info(`inspect it live: https://chainscan-galileo.0g.ai/address/${address}`);

  banner(2, 'The agent learns (100% local)');
  const session = await quiet(() => DmemoSession.open({
    privateKey,
    scope: SCOPE,
    network: 'testnet',
    pointerCachePath: `/tmp/dmemo-demo-${Date.now()}-a.json`,
  }));
  ok(`session open — restored=${session.restoreStats.restored} (new wallet, empty chain)`);
  for (const m of MEMORIES) {
    await session.memory.add(m, { userId: USER, infer: false });
    console.log(`  + remembered: ${DIM}"${m}"${RESET}`);
  }
  info('extraction: mem0 OSS in-process · embeddings: bge-small-en-v1.5 via fastembed, on this laptop');
  info('no API call, no cloud, nothing has left this machine yet');

  const hits = await search(session, QUERY);
  ok(`recall check — "${QUERY}"`);
  console.log(`    → ${BOLD}${hits[0].memory}${RESET} ${DIM}(score ${hits[0].score.toFixed(3)})${RESET}`);

  banner(3, 'Flush: only ciphertext leaves the machine');
  await quiet(async () => {
    session.flush();
    await session.waitForPendingFlush();
  });
  const flush = session.flushLog.at(-1);
  ok(`flushed ${flush.kind} blob → 0G Storage in ${(flush.uploadMs / 1000).toFixed(1)}s`);
  info(`Merkle root ${flush.rootHash}`);
  info(`${flush.bytes} bytes · cost ${fmtEther(flush.costWei)} 0G (~a tenth of a cent)`);

  banner(4, 'Prove it: the chain holds ciphertext, not your life');
  const indexer = new Indexer(TESTNET_NETWORK_CONFIG.indexerUrl);
  const raw = await quiet(async () => {
    const [rawBlob, dlErr] = await indexer.downloadToBlob(flush.rootHash, { proof: false });
    if (dlErr) throw new Error(`raw download failed: ${dlErr.message ?? dlErr}`);
    return Buffer.from(await rawBlob.arrayBuffer());
  });
  console.log(`  raw on-chain bytes (first 48 of ${raw.length}):`);
  info(raw.subarray(0, 48).toString('hex').replace(/(.{32})/g, '$1\n    '));
  const leaked = raw.includes(Buffer.from('octopus-umbrella'));
  if (leaked) throw new Error('PLAINTEXT LEAKED ON CHAIN — this should be impossible');
  ok(`grep for "octopus-umbrella" in the on-chain bytes: ${BOLD}not found${RESET} — ECIES-encrypted to the wallet key`);

  // ECIES here rides on AES-CTR (unauthenticated), so a wrong key never
  // throws at decrypt time — it just yields deterministic garbage. The real
  // guard is that garbage can't parse as a dmemo/1 blob (decodeBlob throws),
  // and confidentiality holds either way: no key, no plaintext.
  const stranger = new StorageClient({
    network: TESTNET_NETWORK_CONFIG,
    privateKey: ethers.Wallet.createRandom().privateKey,
    pointerCachePath: `/tmp/dmemo-demo-${Date.now()}-stranger.json`,
  });
  const strangerBytes = await quiet(async () => {
    try {
      const dl = await stranger.downloadAndVerify(flush.rootHash);
      return dl.plaintext;
    } catch {
      return null; // also fine: some paths reject outright
    }
  });
  if (strangerBytes) {
    if (strangerBytes.includes(Buffer.from('octopus-umbrella'))) {
      throw new Error('stranger recovered plaintext — this should be impossible');
    }
    try {
      decodeBlob(strangerBytes);
      throw new Error('stranger-decrypted bytes parsed as a valid blob — this should be impossible');
    } catch (e) {
      if (String(e.message).includes('impossible')) throw e;
      ok(`a stranger's wallet "decrypts" it to ${strangerBytes.length} bytes of ${RED}garbage${RESET} — unparseable, zero plaintext recovered`);
    }
  } else {
    ok(`a stranger's wallet cannot decrypt it — rejected outright`);
  }

  banner(5, '"New machine": restore from chain with only the key');
  await quiet(() => session.close());
  ok('session closed, local state wiped — imagine this laptop in a river');
  const session2 = await quiet(() => DmemoSession.open({
    privateKey, // the ONLY thing you carried
    scope: SCOPE,
    network: 'testnet',
    pointerCachePath: `/tmp/dmemo-demo-${Date.now()}-b.json`, // cold: no local cache
  }));
  const rs = session2.restoreStats;
  ok(`restored=${rs.restored} — ${rs.chainLength} blob(s) replayed in ${(rs.totalMs / 1000).toFixed(1)}s`);
  info(`pointer via eth_getLogs ${rs.pointerResolveMs.toFixed(0)}ms · download ${rs.downloadMs.toFixed(0)}ms · Merkle-verify ${rs.verifyMs.toFixed(1)}ms · decrypt ${rs.decryptMs.toFixed(1)}ms · replay ${rs.replayMs.toFixed(0)}ms`);

  const hits2 = await search(session2, QUERY);
  ok(`same question — "${QUERY}"`);
  console.log(`    → ${BOLD}${hits2[0].memory}${RESET} ${DIM}(score ${hits2[0].score.toFixed(3)})${RESET}`);
  const identical = hits2[0].id === hits[0].id && hits2[0].score === hits[0].score;
  ok(identical ? 'identical top hit, identical score — byte-for-byte memory survival' : 'top hit restored');

  await quiet(() => session2.close());

  const remaining = await provider.getBalance(address);
  const totalS = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`\n${BOLD}${GREEN}  Done in ${totalS}s. Total spend: ${fmtEther(fundedWei - remaining)} 0G testnet.${RESET}`);
  console.log(`${DIM}  Private by construction · portable · verifiable · cheap — github.com/dmemo-ai/dmemo${RESET}\n`);
}

main().catch((err) => {
  console.error(`\n${RED}DEMO FAILED:${RESET}`, err?.stack ?? err);
  process.exitCode = 1;
});
