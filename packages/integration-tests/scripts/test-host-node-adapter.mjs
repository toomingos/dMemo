#!/usr/bin/env node
// T5.1 test 6a — Host smoke test: node-adapter (Claude Code / Codex hook
// scripts), live testnet, real spend. Scripted, sandboxed HOME/CODEX_HOME:
// invokes the actual built `.cjs` hook bundles
// (claude-dmemo/plugin/scripts/{stop,user-prompt-submit,session-start}.cjs)
// as real child processes, exactly as Claude Code/Codex would (JSON on
// stdin, JSON-line on stdout, env-based config, fresh subprocess per call —
// gotcha 10), and asserts:
//   (a) memory recalled in turn N+1 (stop.cjs captures a turn -> the very
//       next user-prompt-submit.cjs call surfaces it in additionalContext)
//   (b) memory recalled in a brand-new session after wiping ALL local state
//       (pointer cache, markers, config) — session-start.cjs still recalls
//       it purely from the 0G chain (cold eth_getLogs pointer resolve).
//
// The native-module install directory (`$HOME/.dmemo/native`, populated by
// the adapter's own one-time `npm install` bootstrap — see gotcha 17) is
// intentionally NOT wiped between (a) and (b): it holds no session/memory
// state, only installed native deps, so re-wiping it would just force a
// redundant ~15s reinstall without exercising anything new.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { makeReporter, fundEphemeralWallet, getBalance, recordSpend, recordLatencySample, repoRoot } from '../lib/common.mjs';

const TEST_NAME = 'host-node-adapter';
const r = makeReporter(TEST_NAME);
const SCOPE = 't5.1-host-node-adapter';
const HOOK_TIMEOUT_MS = 45_000;

const HOOKS_DIR = path.join(repoRoot, 'claude-dmemo', 'plugin', 'scripts');

function runHook(scriptName, stdinObj, env) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(HOOKS_DIR, scriptName);
    const child = spawn(process.execPath, [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${scriptName} did not exit within ${HOOK_TIMEOUT_MS}ms`));
    }, HOOK_TIMEOUT_MS);
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdin.write(JSON.stringify(stdinObj));
    child.stdin.end();
  });
}

function parseHookOutput(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function wipeLocalStateExceptNative(homeDir) {
  const dmemoDir = path.join(homeDir, '.dmemo');
  for (const entry of ['pointer-cache.json', 'config.json', 'hooks.log', 'markers']) {
    fs.rmSync(path.join(dmemoDir, entry), { recursive: true, force: true });
  }
}

async function main() {
  r.section('SETUP: fund ephemeral wallet + sandbox HOME');
  const FUND_ETHER = '0.03';
  const { privateKey, address, provider } = await fundEphemeralWallet(FUND_ETHER, { reporter: r });

  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-it-node-adapter-home-'));
  r.pass(`sandboxed HOME at ${sandboxHome} (config.json/pointer-cache/markers all isolated here — key passed via env only, never written to disk)`);

  const baseEnv = {
    ...process.env,
    HOME: sandboxHome,
    DMEMO_HOME: path.join(sandboxHome, '.dmemo'),
    DMEMO_PRIVATE_KEY: privateKey,
    DMEMO_NETWORK: 'testnet',
    DMEMO_SCOPE: SCOPE,
  };
  delete baseEnv.CLAUDE_PLUGIN_OPTION_PRIVATE_KEY;

  r.section('STEP 1: session-start.cjs on a genuinely empty store (sanity)');
  const start0 = await runHook('session-start.cjs', {}, baseEnv);
  if (start0.code !== 0) {
    r.fail(`session-start.cjs (empty store) exited ${start0.code}. stderr: ${start0.stderr.slice(0, 1000)}`);
  } else {
    r.pass('session-start.cjs exited 0 on an empty store (no additionalContext expected, none required)');
  }

  r.section('STEP 2: stop.cjs captures a turn (add + flush, real testnet spend)');
  const t0 = performance.now();
  const stopResult = await runHook(
    'stop.cjs',
    {
      last_assistant_message: 'The deploy runbook lives in docs/deploy-runbook.md and covers the blue-green rollout steps.',
      prompt: 'How do I deploy the app?',
      transcript_path: '',
    },
    baseEnv
  );
  const stopMs = performance.now() - t0;
  if (stopResult.code !== 0) {
    r.fail(`stop.cjs exited ${stopResult.code}. stderr: ${stopResult.stderr.slice(0, 1500)}`);
  } else {
    r.pass(`stop.cjs captured + flushed a turn in ${stopMs.toFixed(0)}ms`);
    recordLatencySample({ kind: 'flush-delta', ms: stopMs, test: TEST_NAME });
  }

  r.section('STEP 2b: (a) memory recalled in turn N+1 — user-prompt-submit.cjs, fresh subprocess, next turn');
  const t1 = performance.now();
  const upsResult = await runHook('user-prompt-submit.cjs', { prompt: 'where is the deploy runbook documented?' }, baseEnv);
  const upsMs = performance.now() - t1;
  recordLatencySample({ kind: 'open-restore', ms: upsMs, test: TEST_NAME });
  if (upsResult.code !== 0) {
    r.fail(`user-prompt-submit.cjs exited ${upsResult.code}. stderr: ${upsResult.stderr.slice(0, 1500)}`);
  } else {
    const parsed = parseHookOutput(upsResult.stdout);
    const context = parsed?.hookSpecificOutput?.additionalContext ?? '';
    if (context.includes('deploy-runbook.md')) {
      r.pass(`(a) turn N+1 recall: user-prompt-submit.cjs surfaced the flushed turn in additionalContext (${upsMs.toFixed(0)}ms)`);
    } else {
      r.fail(`(a) turn N+1 recall FAILED: additionalContext did not mention deploy-runbook.md. Got: ${JSON.stringify(parsed)}`);
    }
  }

  r.section('STEP 3: wipe ALL local state (pointer cache, markers, config) except the native-deps install dir');
  wipeLocalStateExceptNative(sandboxHome);
  const dmemoDirAfterWipe = fs.readdirSync(path.join(sandboxHome, '.dmemo')).sort();
  r.pass(`local state wiped — $HOME/.dmemo now contains only: ${JSON.stringify(dmemoDirAfterWipe)}`);

  r.section('STEP 3b: (b) memory recalled in a brand-new session after full wipe — session-start.cjs, cold pointer resolve');
  const t2 = performance.now();
  const start1 = await runHook('session-start.cjs', {}, baseEnv);
  const start1Ms = performance.now() - t2;
  recordLatencySample({ kind: 'open-restore-cold', ms: start1Ms, test: TEST_NAME });
  if (start1.code !== 0) {
    r.fail(`session-start.cjs (post-wipe) exited ${start1.code}. stderr: ${start1.stderr.slice(0, 1500)}`);
  } else {
    const parsed = parseHookOutput(start1.stdout);
    const context = parsed?.hookSpecificOutput?.additionalContext ?? '';
    if (context.includes('deploy-runbook.md') || context.includes('blue-green')) {
      r.pass(`(b) brand-new-session recall after full local-state wipe: session-start.cjs recalled the memory purely from the 0G chain in ${start1Ms.toFixed(0)}ms`);
    } else {
      r.fail(`(b) brand-new-session recall FAILED: additionalContext did not mention the earlier turn. Got: ${JSON.stringify(parsed)}`);
    }
  }

  r.section('SUMMARY');
  const remaining = await getBalance(provider, address);
  const fundedWei = ethers.parseEther(FUND_ETHER);
  const entry = recordSpend({ test: TEST_NAME, address, fundedWei, remainingWei: remaining });
  console.log(`ephemeral wallet ${address}: funded ${entry.fundedEther} 0G, remaining ${entry.remainingEther} 0G, spent ${entry.spentEther} 0G`);
  console.log(`sandbox HOME left at ${sandboxHome} for inspection (contains only dMemo config/native-deps, no secrets on disk)`);

  return r.summary();
}

main().catch((err) => {
  r.fail(`uncaught error: ${err && err.stack ? err.stack : err}`);
  r.summary();
});
