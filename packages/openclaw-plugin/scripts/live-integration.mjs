#!/usr/bin/env node
// T3.3 live integration check (plain node, no test framework): exercises
// this plugin's actual recall/capture/isolation code paths against a REAL
// DmemoSession on 0G testnet — before_prompt_build-shaped recall,
// agent_end-shaped capture, flush, close, reopen (cold restore), then
// search-parity against the freshly restored session. Never prints the
// private key. Run from the package root:
//   node scripts/live-integration.mjs
// Requires: packages/core and this package already built (`pnpm run build`
// at the repo root), and `spike/.env`'s PRIVATE_KEY funded on Galileo
// testnet (small spend authorized — flush cost is ~0.00125 0G per
// TASKS.md's measured constant).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { DmemoSession } from "@dmemo/core";
import { effectiveUserId } from "../dist/isolation.js";
import { renderMemoryBlock, extractTurns, sanitizeQuery } from "../dist/recall.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

/**
 * Resolve the private key to run against, entirely in-process — the raw
 * hex secret is never written to a file, printed, or passed as a bash
 * argument/env-literal by the caller.
 *
 * Default mode ("--fund"/no flag): generate a throwaway wallet and fund it
 * with a small amount from the shared spike wallet, so the on-chain
 * chain-walk starts from genuinely empty history. This is needed because
 * the shared `spike/.env` wallet already carries years of Phase 0-2
 * spike-script uploads that are NOT dMemo blob-spec envelopes — the first
 * attempt at this live test, run directly against that wallet, hit
 * `decrypt failed: blob is not ECIES-encrypted to this wallet, or key
 * mismatch` on the very first `DmemoSession.open()` for exactly this
 * reason (see final report).
 *
 * `--use-spike-wallet`: use spike/.env's key directly (will likely hit the
 * same pre-existing-chain collision above; kept for completeness/debugging).
 */
async function resolvePrivateKey() {
  if (process.argv.includes("--use-spike-wallet")) {
    const envPath = path.join(repoRoot, "spike", ".env");
    const raw = fs.readFileSync(envPath, "utf-8");
    const m = raw.match(/^PRIVATE_KEY=(.+)$/m);
    if (!m) throw new Error(`PRIVATE_KEY not found in ${envPath}`);
    return m[1].trim();
  }

  const envPath = path.join(repoRoot, "spike", ".env");
  const raw = fs.readFileSync(envPath, "utf-8");
  const m = raw.match(/^PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error(`PRIVATE_KEY not found in ${envPath}`);
  const funderKey = m[1].trim();

  const provider = new ethers.JsonRpcProvider("https://evmrpc-testnet.0g.ai");
  const funder = new ethers.Wallet(funderKey, provider);
  const ephemeral = ethers.Wallet.createRandom();
  const FUND_AMOUNT = ethers.parseEther("0.05"); // ~40x the measured single-flush cost

  console.log(`[live] funding fresh ephemeral wallet ${ephemeral.address} with 0.05 0G...`);
  const tx = await funder.sendTransaction({ to: ephemeral.address, value: FUND_AMOUNT });
  await tx.wait();
  console.log(`[live] funded (tx ${tx.hash}); running the integration test against the ephemeral wallet.`);

  return ephemeral.privateKey;
}

function fmtWei(w) {
  // bigint wei -> 0G (18 decimals), 6 sig figs, no external deps.
  const s = w.toString().padStart(19, "0");
  const whole = s.slice(0, -18) || "0";
  const frac = s.slice(-18, -12); // first 6 fractional digits is plenty
  return `${whole}.${frac}`;
}

async function main() {
  const privateKey = await resolvePrivateKey(); // NEVER logged below.
  const scope = `t3.3-openclaw-live-${Date.now()}`;
  const userId = effectiveUserId(scope, undefined); // main session -> == scope
  const network = "testnet";

  console.log(`[live] scope=${scope} network=${network}`);

  // ---- open #1 (fresh scope -> empty restore) --------------------------
  const t0 = Date.now();
  const session1 = await DmemoSession.open({ privateKey, scope, network });
  const openMs1 = Date.now() - t0;
  console.log(
    `[live] session1.open() ${openMs1}ms restoreStats=${JSON.stringify(session1.restoreStats)}`,
  );

  // ---- before_prompt_build-shaped recall (should be empty: fresh scope) --
  const prompt = "What did we decide about the T3.3 OpenClaw plugin's dream-batch flush semantics?";
  const query = sanitizeQuery(prompt);
  const tRecall0 = Date.now();
  const preResult = await session1.memory.search(query, { filters: { user_id: userId }, topK: 5 });
  console.log(
    `[live] pre-capture search: ${Date.now() - tRecall0}ms, ${preResult.results.length} results (expect 0, fresh scope)`,
  );

  // ---- agent_end-shaped capture ------------------------------------------
  const distinctiveFact =
    "dMemo's OpenClaw dream-gate flushes an entire consolidation burst as exactly ONE delta blob, never one blob per mutation.";
  const messages = [
    { role: "user", content: "Remind me how dream-batch flushing works in the OpenClaw plugin." },
    { role: "assistant", content: distinctiveFact },
  ];
  const turns = extractTurns(messages);
  const tCapture0 = Date.now();
  await session1.memory.add(turns, { userId, infer: false, metadata: { source: "capture" } });
  const addMs = Date.now() - tCapture0;

  // Search on session1 BEFORE flush/close, to capture the "before" IDs/scores.
  const beforeFlush = await session1.memory.search(distinctiveFact, {
    filters: { user_id: userId },
    topK: 5,
  });
  console.log(`[live] add() ${addMs}ms; pre-flush search found ${beforeFlush.results.length} result(s)`);

  const tFlush0 = Date.now();
  session1.flush();
  await session1.waitForPendingFlush();
  const flushMs = Date.now() - tFlush0;
  const lastFlush = session1.flushLog[session1.flushLog.length - 1];
  console.log(
    `[live] flush() settled in ${flushMs}ms; log entry: kind=${lastFlush?.kind} bytes=${lastFlush?.bytes} uploadMs=${lastFlush?.uploadMs} costWei=${lastFlush?.costWei}`,
  );

  await session1.close();

  // ---- open #2 (cold restore from the flush we just made) ----------------
  const t1 = Date.now();
  const session2 = await DmemoSession.open({ privateKey, scope, network });
  const openMs2 = Date.now() - t1;
  console.log(
    `[live] session2.open() (cold restore) ${openMs2}ms restoreStats=${JSON.stringify(session2.restoreStats)}`,
  );

  const afterRestore = await session2.memory.search(distinctiveFact, {
    filters: { user_id: userId },
    topK: 5,
  });
  await session2.close();

  // ---- parity check --------------------------------------------------------
  const beforeIds = beforeFlush.results.map((r) => r.id).sort();
  const afterIds = afterRestore.results.map((r) => r.id).sort();
  const idsMatch = JSON.stringify(beforeIds) === JSON.stringify(afterIds);
  const beforeText = beforeFlush.results.map((r) => r.memory ?? r.text);
  const afterText = afterRestore.results.map((r) => r.memory ?? r.text);
  const textMatch = JSON.stringify(beforeText) === JSON.stringify(afterText);

  console.log(`[live] before-flush IDs: ${JSON.stringify(beforeIds)}`);
  console.log(`[live] after-restore IDs: ${JSON.stringify(afterIds)}`);
  console.log(`[live] rendered recall block after restore:\n${renderMemoryBlock(afterRestore.results)}`);

  const totalCostWei = session1.flushLog.reduce((acc, e) => acc + e.costWei, 0n);

  console.log("\n=== T3.3 live integration summary ===");
  console.log(`cold restore (before_prompt_build budget check): ${openMs2}ms (fresh-scope open: ${openMs1}ms)`);
  console.log(`capture add(): ${addMs}ms; flush: ${flushMs}ms`);
  console.log(`total spend this run: ${fmtWei(totalCostWei)} 0G (${totalCostWei} wei)`);
  console.log(`search parity (IDs match): ${idsMatch}`);
  console.log(`search parity (text match): ${textMatch}`);

  if (!idsMatch || !textMatch) {
    console.error("[live] FAIL: search results after restore do not match pre-flush results");
    process.exitCode = 1;
    return;
  }
  if (openMs2 > 10_000) {
    console.error(
      `[live] WARN: cold restore ${openMs2}ms exceeds this plugin's before_prompt_build timeoutMs (10000ms)`,
    );
  }
  console.log("[live] PASS");
}

main()
  .catch((err) => {
    console.error("[live] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // fastembed/onnxruntime native teardown SIGABRTs on process.exit()
    // (Phase 0 gotcha 12) — set exitCode and return instead.
  });
