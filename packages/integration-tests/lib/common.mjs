// Shared helpers for T5.1 integration tests. Mirrors the funding/reporting
// pattern proven in packages/core/scripts/smoke-testnet.mjs and reused by
// packages/{opencode,openclaw}-plugin/scripts/live-integration.mjs.
//
// SECURITY: never print/log a private key, spike or ephemeral. Only
// addresses and balances are ever logged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '../../..');
export const resultsDir = path.join(__dirname, '..', 'results');

const TESTNET_CHAIN_ID = 16602n;

// Mirrors packages/core/src/storage/network.ts's testnet tuple exactly
// (TASKS.md Global constants). Tests construct StorageClient directly (below
// mem0/DmemoSession) in a few places and need this shape.
export const TESTNET_NETWORK_CONFIG = {
  network: 'testnet',
  chainId: 16602,
  rpcUrl: 'https://evmrpc-testnet.0g.ai',
  indexerUrl: 'https://indexer-storage-testnet-turbo.0g.ai',
  flowAddress: '0x22e03a6a89b950f1c82ec5e74f8eca321a105296',
  routerUrl: 'https://router-api-testnet.integratenetwork.work/v1',
};

// ---------------------------------------------------------------------------
// PASS/FAIL harness
// ---------------------------------------------------------------------------
export function makeReporter(testName) {
  let failures = 0;
  const lines = [];
  function pass(msg) {
    const line = `PASS: ${msg}`;
    console.log(line);
    lines.push(line);
  }
  function fail(msg) {
    failures++;
    const line = `FAIL: ${msg}`;
    console.error(line);
    lines.push(line);
  }
  function section(title) {
    console.log(`\n=== ${title} ===`);
  }
  function summary() {
    console.log(
      failures === 0
        ? `\n=== [${testName}] ALL CHECKS PASSED ===`
        : `\n=== [${testName}] ${failures} CHECK(S) FAILED ===`
    );
    // Never call process.exit() — fastembed/onnxruntime native teardown
    // SIGABRTs on a forced exit (gotcha 12). Set exitCode and let the event
    // loop drain.
    process.exitCode = failures === 0 ? 0 : 1;
    return failures === 0;
  }
  return { pass, fail, section, summary, get failures() { return failures; }, lines };
}

// ---------------------------------------------------------------------------
// spike/.env funding wallet
// ---------------------------------------------------------------------------
export function loadSpikeEnv() {
  const envPath = path.join(repoRoot, 'spike', '.env');
  const raw = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  for (const key of ['PRIVATE_KEY', 'ADDRESS', 'RPC', 'INDEXER']) {
    if (!env[key]) throw new Error(`missing ${key} in spike/.env`);
  }
  return env;
}

/**
 * Connect to testnet using spike/.env's funding wallet, refuse anything
 * other than chain 16602 (never mainnet), and fund a fresh ephemeral wallet
 * from it with `amountEther`. Returns the ephemeral wallet's private key
 * (never logged) plus balances for reporting. Gotcha 18: one chain per
 * wallet — every test that needs a clean chain gets its own fresh wallet.
 */
export async function fundEphemeralWallet(amountEther, { reporter } = {}) {
  const env = loadSpikeEnv();
  const provider = new ethers.JsonRpcProvider(env.RPC);
  const funder = new ethers.Wallet(env.PRIVATE_KEY, provider);

  const network = await provider.getNetwork();
  if (network.chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`connected chain ${network.chainId} is NOT testnet Galileo (16602) — refusing to spend`);
  }

  const funderBalanceBefore = await provider.getBalance(funder.address);
  if (funderBalanceBefore === 0n) {
    throw new Error('spike wallet has 0 balance — fund it at https://faucet.0g.ai first');
  }

  const ephemeral = ethers.Wallet.createRandom();
  const amountWei = ethers.parseEther(String(amountEther));
  const tx = await funder.sendTransaction({ to: ephemeral.address, value: amountWei });
  await tx.wait();

  if (reporter) {
    reporter.pass(
      `funded fresh ephemeral wallet ${ephemeral.address} with ${amountEther} 0G from spike wallet ${funder.address} (tx ${tx.hash})`
    );
  }

  return {
    privateKey: ephemeral.privateKey,
    address: ephemeral.address,
    provider,
    funderAddress: funder.address,
    fundedWei: amountWei,
  };
}

export async function getBalance(provider, address) {
  return provider.getBalance(address);
}

export function fmtEther(wei) {
  return ethers.formatEther(wei);
}

// ---------------------------------------------------------------------------
// Spend accounting: each test appends {test, address, fundedWei, remainingWei,
// spentWei} to results/spend-log.jsonl so the final report can sum totals
// without re-querying the chain.
// ---------------------------------------------------------------------------
export function recordSpend({ test, address, fundedWei, remainingWei }) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const spentWei = fundedWei - remainingWei;
  const entry = {
    test,
    address,
    fundedEther: fmtEther(fundedWei),
    remainingEther: fmtEther(remainingWei),
    spentEther: fmtEther(spentWei),
    at: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(resultsDir, 'spend-log.jsonl'), JSON.stringify(entry) + '\n');
  return entry;
}

// ---------------------------------------------------------------------------
// Latency sample collection for T5.3. Each sample is one measured event
// (session-open-cold, session-open-warm, flush-delta, flush-checkpoint).
// ---------------------------------------------------------------------------
export function recordLatencySample({ kind, ms, costWei, bytes, test }) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const entry = { kind, ms, costWei: costWei !== undefined ? costWei.toString() : undefined, bytes, test, at: new Date().toISOString() };
  fs.appendFileSync(path.join(resultsDir, 'latency-samples.jsonl'), JSON.stringify(entry) + '\n');
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
