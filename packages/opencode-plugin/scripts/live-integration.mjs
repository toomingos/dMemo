#!/usr/bin/env node
// T3.2 live integration check (plain node, no test framework): drives this
// plugin's ACTUAL hook functions (chat.message injection, event-driven
// capture cadence, experimental.session.compacting) against a REAL
// DmemoSession on 0G testnet — inject -> capture -> flush -> reopen ->
// search parity. The OpenCode host itself is fixture-mocked (no server
// running here); only the memory leg is real. Never prints the private
// key. Run from the package root (after `pnpm run build` at the repo
// root):
//   node scripts/live-integration.mjs
// Requires `spike/.env`'s PRIVATE_KEY funded on Galileo testnet (small
// spend authorized — flush cost is ~0.00125 0G per TASKS.md).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { DmemoSession } from '@dmemo/core';
import { createDmemoPlugin } from '../dist/index.js';
import { resolveUserId } from '../dist/identity.js';

// mem0-oss requires at least one of user_id/agent_id/run_id on every
// search — mirror the plugin's own identity resolution (OS username,
// scope-independent; see src/identity.ts) for this script's direct
// `session.memory.search()` calls (the plugin's own hooks already do this
// internally, but this script also inspects the session directly for
// before/after-restore parity, which must use the same filter shape).
const userId = resolveUserId();
const searchOpts = { topK: 5, filters: { user_id: userId } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

/**
 * Resolve the private key to run against, entirely in-process — the raw hex
 * secret is never written to a file, printed, or passed as a bash
 * argument/env-literal.
 *
 * The shared `spike/.env` wallet already carries pre-existing chain history
 * (years of Phase 0-2 spike-script uploads that are NOT dMemo blob-spec
 * envelopes, plus concurrent writes from sibling T3.1/T3.3 host-adapter
 * agents against the same address). A direct `DmemoSession.open()` against
 * that wallet hit `decrypt failed: blob is not ECIES-encrypted to this
 * wallet, or key mismatch` on the very first open — not a funding problem
 * (the spike wallet holds ~6.8 0G). Sibling T3.3 hit and solved the
 * identical issue by generating a throwaway ephemeral wallet and funding it
 * directly from the spike wallet (a local signed transfer, no faucet
 * needed) so the on-chain chain-walk starts from genuinely empty history.
 * Same fix applied here.
 */
async function resolvePrivateKey() {
  const envPath = path.join(repoRoot, 'spike', '.env');
  const raw = fs.readFileSync(envPath, 'utf-8');
  const m = raw.match(/^PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error(`PRIVATE_KEY not found in ${envPath}`);
  const funderKey = m[1].trim();

  const provider = new ethers.JsonRpcProvider('https://evmrpc-testnet.0g.ai');
  const funder = new ethers.Wallet(funderKey, provider);
  const ephemeral = ethers.Wallet.createRandom();
  const FUND_AMOUNT = ethers.parseEther('0.05'); // ~40x the measured single-flush cost

  console.log(`[live] funding fresh ephemeral wallet ${ephemeral.address} with 0.05 0G...`);
  const tx = await funder.sendTransaction({ to: ephemeral.address, value: FUND_AMOUNT });
  await tx.wait();
  console.log(`[live] funded (tx ${tx.hash}); running the integration test against the ephemeral wallet.`);

  return ephemeral.privateKey;
}

function fmtWei(w) {
  const s = w.toString().padStart(19, '0');
  const whole = s.slice(0, -18) || '0';
  const frac = s.slice(-18, -12);
  return `${whole}.${frac}`;
}

function makeCtx({ assistantText, providerID, modelID, contextLimit }) {
  const logs = [];
  return {
    ctx: {
      client: {
        app: { log: async (o) => { logs.push(o); } },
        provider: {
          list: async () => ({
            data: { all: [{ id: providerID, models: { [modelID]: { limit: { context: contextLimit } } } }] },
          }),
        },
        session: {
          messages: async () => ({
            data: [
              { info: { role: 'assistant', id: 'live-a1' }, parts: [{ type: 'text', text: assistantText }] },
            ],
          }),
        },
      },
      directory: '/tmp/dmemo-t3.2-live-project',
      worktree: '/tmp/dmemo-t3.2-live-project',
      project: {},
      serverUrl: new URL('http://localhost:0'),
      $: async () => {},
      experimental_workspace: { register() {} },
    },
    logs,
  };
}

async function main() {
  const privateKey = await resolvePrivateKey(); // NEVER logged.
  const runId = `${Date.now()}`;
  process.env.DMEMO_OPENCODE_SCOPE = `t3.2-opencode-live-${runId}`;
  const network = 'testnet';

  let capturedSession; // reference for cost/timing reporting only — the
  // Hooks API deliberately never leaks the session instance to the host.
  const openSession = async (opts) => {
    const t0 = Date.now();
    const s = await DmemoSession.open(opts);
    console.log(`[live] session1.open() ${Date.now() - t0}ms restoreStats=${JSON.stringify(s.restoreStats)}`);
    capturedSession = s;
    return s;
  };

  const distinctiveFact =
    "dMemo's OpenCode plugin captures verbatim (infer:false) every 3rd assistant turn and pre-compaction.";
  const { ctx, logs } = makeCtx({
    assistantText: distinctiveFact,
    providerID: 'anthropic',
    modelID: 'claude-live-test',
    contextLimit: 100_000,
  });

  const plugin = createDmemoPlugin({
    openSession,
    loadConfig: () => ({
      network,
      privateKey,
      infer: false,
      checkpointEveryNFlushes: 2,
      checkpointSizeThresholdBytes: 65536,
      uploadTimeoutMs: 120_000,
      networkOverrides: {},
    }),
  });

  const hooks = await plugin(ctx);
  if (Object.keys(hooks).length === 0) {
    console.error('[live] FAILED: plugin returned empty hooks (fail-open path) — check PRIVATE_KEY/testnet funding');
    console.error('[live] plugin logs:', JSON.stringify(logs, null, 2));
    process.exitCode = 1;
    return;
  }

  const sessionID = 'live-session-1';

  // ---- inject: chat.message searches memory (expect 0 hits, fresh scope) --
  const tInject0 = Date.now();
  await hooks['chat.message']({ sessionID }, { message: {}, parts: [{ type: 'text', text: 'What have we captured about the capture cadence?' }] });
  const injectMs = Date.now() - tInject0;

  const transformOutput = {
    messages: [{ info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'What have we captured about the capture cadence?' }] }],
  };
  await hooks['experimental.chat.messages.transform']({}, transformOutput);
  console.log(`[live] pre-capture injection: ${injectMs}ms, block injected=${transformOutput.messages[0].parts.length > 1}`);

  // ---- capture: every-3rd-assistant-turn cadence via the `event` hook -----
  await hooks['chat.message']({ sessionID }, { message: {}, parts: [{ type: 'text', text: 'Remind me how the capture cadence works.' }] });
  const tCapture0 = Date.now();
  for (let i = 1; i <= 3; i++) {
    await hooks.event({
      event: { type: 'message.updated', properties: { info: { role: 'assistant', finish: 'stop', sessionID, id: `live-turn-${i}` } } },
    });
  }
  const captureMs = Date.now() - tCapture0;
  const addsAfterCadence = capturedSession.flushLog.length;
  console.log(`[live] cadence capture (3 assistant turns): ${captureMs}ms, flushLog entries so far=${addsAfterCadence}`);

  // ---- compaction hook: pre-compaction capture + context note -------------
  const compactingOutput = { context: [] };
  await hooks['experimental.session.compacting']({ sessionID }, compactingOutput);
  console.log(`[live] compaction hook context note: ${JSON.stringify(compactingOutput.context)}`);

  // Search on session1 BEFORE flush/close settles, to capture "before" state.
  const beforeClose = await capturedSession.memory.search(distinctiveFact, searchOpts);

  // ---- flush + close (dispose awaits pending flush, then closes) ----------
  const tFlush0 = Date.now();
  await hooks.dispose();
  const flushMs = Date.now() - tFlush0;
  const lastFlush = capturedSession.flushLog[capturedSession.flushLog.length - 1];
  console.log(
    `[live] dispose() (await flush + close) ${flushMs}ms; last flush: kind=${lastFlush?.kind} bytes=${lastFlush?.bytes} uploadMs=${lastFlush?.uploadMs} costWei=${lastFlush?.costWei}`
  );

  // ---- reopen (cold restore) + search parity -------------------------------
  const t1 = Date.now();
  const session2 = await DmemoSession.open({ privateKey, scope: process.env.DMEMO_OPENCODE_SCOPE, network });
  const openMs2 = Date.now() - t1;
  console.log(`[live] session2.open() (cold restore) ${openMs2}ms restoreStats=${JSON.stringify(session2.restoreStats)}`);

  const afterRestore = await session2.memory.search(distinctiveFact, searchOpts);
  await session2.close();

  const beforeIds = beforeClose.results.map((r) => r.id).sort();
  const afterIds = afterRestore.results.map((r) => r.id).sort();
  const idsMatch = JSON.stringify(beforeIds) === JSON.stringify(afterIds);
  const beforeText = beforeClose.results.map((r) => r.memory);
  const afterText = afterRestore.results.map((r) => r.memory);
  const textMatch = JSON.stringify(beforeText) === JSON.stringify(afterText);

  const totalCostWei = capturedSession.flushLog.reduce((acc, e) => acc + e.costWei, 0n);

  console.log('\n=== T3.2 live integration summary ===');
  console.log(`inject search: ${injectMs}ms; cadence capture (3 events): ${captureMs}ms; dispose flush: ${flushMs}ms; cold restore: ${openMs2}ms`);
  console.log(`total spend this run: ${fmtWei(totalCostWei)} 0G (${totalCostWei} wei)`);
  console.log(`search parity (IDs match): ${idsMatch}`);
  console.log(`search parity (text match): ${textMatch}`);
  console.log(`before: ${JSON.stringify(beforeText)}`);
  console.log(`after:  ${JSON.stringify(afterText)}`);

  if (!idsMatch || !textMatch || beforeText.length === 0) {
    console.error('[live] FAIL: search results after restore do not match pre-close results');
    process.exitCode = 1;
    return;
  }
  console.log('[live] PASS');
}

main()
  .catch((err) => {
    console.error('[live] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // fastembed/onnxruntime native teardown SIGABRTs on process.exit()
    // (Phase 0 gotcha 12) — set exitCode and return instead.
  });
