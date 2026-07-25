#!/usr/bin/env node
// T5.1 test 6c — Host smoke test: openclaw-plugin. Mirrors
// test-host-opencode.mjs: REUSES
// packages/openclaw-plugin/scripts/live-integration.mjs unmodified (real
// DmemoSession on testnet: capture add() -> flush -> cold restore ->
// search parity, plus its own before_prompt_build 10s budget check). See
// test-host-opencode.mjs's header comment for why reopen-search-parity
// stands in for "brand-new session recall" here (content is always
// chain-sourced; the cold-cache pointer-resolve path is covered directly by
// scripts/test-pointer.mjs).

import path from 'node:path';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { makeReporter, loadSpikeEnv, repoRoot, fmtEther, recordSpend } from '../lib/common.mjs';

const TEST_NAME = 'host-openclaw';
const r = makeReporter(TEST_NAME);
const SCRIPT_PATH = path.join(repoRoot, 'packages', 'openclaw-plugin', 'scripts', 'live-integration.mjs');

function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      stdout += s;
      process.stdout.write(`[openclaw-live] ${s}`);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      stderr += s;
      process.stderr.write(`[openclaw-live] ${s}`);
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

  r.section('STEP 1: run packages/openclaw-plugin/scripts/live-integration.mjs unmodified');
  const t0 = performance.now();
  const result = await runScript(SCRIPT_PATH);
  const ms = performance.now() - t0;

  if (result.code === 0 && /\[live\] PASS/.test(result.stdout)) {
    r.pass(`openclaw-plugin live-integration.mjs PASSED in ${ms.toFixed(0)}ms`);
  } else {
    r.fail(`openclaw-plugin live-integration.mjs FAILED (exit ${result.code}). See [openclaw-live] output above.`);
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
