#!/usr/bin/env node
// T5.1 test 6b — Host smoke test: opencode-plugin. Per the task brief,
// REUSES packages/opencode-plugin/scripts/live-integration.mjs unmodified
// (rather than rewriting it) — that script already drives the plugin's real
// hook functions against a real DmemoSession on testnet: inject search ->
// event-driven capture cadence -> dispose flush -> reopen -> search parity
// (IDs + text). Search-parity-after-reopen is this host's analogue of
// "memory recalled in a brand-new session": session2 is a structurally new
// DmemoSession restoring purely from the 0G chain (content is never served
// from any local cache — the pointer cache is a non-content-bearing block-
// range shortcut only), so a parity match here IS a real recall of content
// that only exists on-chain. The cold/no-cache pointer-resolve code path
// itself (shared by all three hosts) already has a dedicated direct test:
// scripts/test-pointer.mjs.
//
// This wrapper just spawns that script as a child process, captures its
// PASS/FAIL and self-funds (it funds its OWN ephemeral wallet directly from
// spike/.env — 0.05 0G per its own comments), and folds the resulting
// spike-wallet balance delta into this suite's spend accounting.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { makeReporter, loadSpikeEnv, repoRoot, fmtEther, recordSpend } from '../lib/common.mjs';

const TEST_NAME = 'host-opencode';
const r = makeReporter(TEST_NAME);
const SCRIPT_PATH = path.join(repoRoot, 'packages', 'opencode-plugin', 'scripts', 'live-integration.mjs');

function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      stdout += s;
      process.stdout.write(`[opencode-live] ${s}`);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      stderr += s;
      process.stderr.write(`[opencode-live] ${s}`);
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

async function main() {
  r.section('SETUP: snapshot spike wallet balance (this reused script self-funds from spike/.env)');
  const env = loadSpikeEnv();
  const provider = new ethers.JsonRpcProvider(env.RPC);
  const balanceBefore = await provider.getBalance(env.ADDRESS);
  r.pass(`spike wallet balance before: ${fmtEther(balanceBefore)} 0G`);

  r.section('STEP 1: run packages/opencode-plugin/scripts/live-integration.mjs unmodified');
  const t0 = performance.now();
  const result = await runScript(SCRIPT_PATH);
  const ms = performance.now() - t0;

  if (result.code === 0 && /\[live\] PASS/.test(result.stdout)) {
    r.pass(`opencode-plugin live-integration.mjs PASSED in ${ms.toFixed(0)}ms (covers (a) capture+recall via search parity across reopen; content recall is always chain-sourced, never local-cache-sourced)`);
  } else {
    r.fail(`opencode-plugin live-integration.mjs FAILED (exit ${result.code}). See [opencode-live] output above.`);
  }

  r.section('SUMMARY');
  const balanceAfter = await provider.getBalance(env.ADDRESS);
  const entry = recordSpend({ test: TEST_NAME, address: env.ADDRESS, fundedWei: balanceBefore, remainingWei: balanceAfter });
  console.log(`spike wallet: before ${entry.fundedEther} 0G, after ${entry.remainingEther} 0G, spent this run ${entry.spentEther} 0G (funds an ephemeral wallet the reused script does not sweep back)`);

  return r.summary();
}

main().catch((err) => {
  r.fail(`uncaught error: ${err && err.stack ? err.stack : err}`);
  r.summary();
});
