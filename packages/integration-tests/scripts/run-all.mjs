#!/usr/bin/env node
// Convenience runner: executes every T5.1 test script sequentially and
// prints a combined PASS/FAIL summary. Each script is also independently
// runnable on its own (`node scripts/test-*.mjs`) per T5.1's requirement.
// NOT wired into `pnpm -r test` (real testnet spend) — invoke explicitly:
//   node scripts/run-all.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Do NOT import __dirname from common.mjs here — it resolves to lib/ (where
// common.mjs itself lives), not scripts/ (where these test files live).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TESTS = [
  'test-blob-roundtrip.mjs',
  'test-tamper.mjs',
  'test-pointer.mjs',
  'test-crash-recovery.mjs',
  'test-checkpoint-consolidation.mjs',
  'test-host-node-adapter.mjs',
  'test-host-opencode.mjs',
  'test-host-openclaw.mjs',
  'collect-latency-samples.mjs',
];

function runOne(name) {
  return new Promise((resolve) => {
    console.log(`\n############ RUNNING ${name} ############`);
    const child = spawn(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve({ name, code }));
  });
}

async function main() {
  const results = [];
  for (const name of TESTS) {
    results.push(await runOne(name));
  }
  console.log('\n============ FINAL SUMMARY ============');
  let allPass = true;
  for (const { name, code } of results) {
    console.log(`${code === 0 ? 'PASS' : 'FAIL'}: ${name}`);
    if (code !== 0) allPass = false;
  }
  process.exitCode = allPass ? 0 : 1;
}

main();
