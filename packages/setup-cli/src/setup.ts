// T4.1 orchestrator — `dmemo setup`. Steps: wallet -> ~/.dmemo/config.json
// -> funding -> per-host install -> optional inference leg (instructions
// only, never scripted).
//
// Funding used to sit before the config write, back when it was just a
// printed faucet link. It now opens a browser and can take minutes (a card
// purchase clears KYC first), so the config has to be on disk before it
// starts: a user who abandons the funding step must still end up with their
// wallet persisted and `dmemo fund` re-runnable against it. Losing a
// generated key to a closed browser tab would be unrecoverable.
//
// The memory leg (steps 1-4) completes with ZERO interactive web steps.
// Step 5 (inference) is documented, not automated (accepted gap, D-cited in
// TASKS.md T4.1: "no documented headless first-key mint").
//
// Re-run semantics (F3): a wallet already on record is KEPT. Setup's job on a
// re-run is to wire up hosts, not to mint a new identity — and since
// `DMEMO_PRIVATE_KEY` is the only thing that can decrypt this wallet's blobs
// on 0G, generating a fresh one silently would orphan every memory the user
// has. Replacing a wallet therefore takes an explicit ask (`--new-wallet` or
// `--import-key`) AND consent (an interactive y/N, or `--force`), and always
// leaves a timestamped backup behind.

import { generateWallet, importWallet, type WalletResult } from './wallet.js';
import {
  faucetInstructions,
  checkBalance,
  chainNameFor,
  chainIdFor,
  CURRENCY_SYMBOL,
  COST_PER_WRITE_0G_LOW,
  COST_PER_WRITE_0G_HIGH,
} from './network.js';
import { runFund } from './fund.js';
import {
  writeDmemoConfig,
  inspectExistingKey,
  recoveryHint,
  type ExistingKeyInfo,
  type NetworkName,
} from './dmemoConfig.js';
import { installDetectedHosts, type InstalledHosts } from './installHosts.js';
import { promptText, promptYesNo, promptSecret } from './prompt.js';

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** Non-interactive mode: no prompts, sensible defaults, never blocks on
   * stdin. Used by CI and by this task's own sandboxed test run. */
  yes?: boolean;
  network?: NetworkName;
  /** Import this key instead of generating one (still never printed). */
  importKey?: string;
  /** Explicitly mint a NEW wallet even though one is already configured.
   * Still subject to the consent gate below — this states the intent, it
   * does not grant permission. */
  newWallet?: boolean;
  /** Grant permission to replace the configured wallet without a prompt.
   * The old config is backed up regardless. */
  force?: boolean;
  skipHosts?: boolean;
  /** Never open the funding flow; print how to fund and move on. */
  skipFunding?: boolean;
  /** Passed through to the funding step: print the URL, don't spawn a
   * browser (headless/CI/remote shells). */
  noOpen?: boolean;
  checkBalanceOnce?: boolean;
  log?: (line: string) => void;
}

export interface SetupResult {
  address: string;
  network: NetworkName;
  configPath: string;
  hosts: InstalledHosts;
  /** True when an already-configured wallet was kept as-is. */
  walletReused: boolean;
  /** Where the pre-replacement config was copied, when one was replaced. */
  backupPath: string | null;
}

const INFERENCE_INSTRUCTIONS = [
  '',
  'Optional: private LLM inference via the 0G Compute Router',
  '(separate from the memory leg above; skip this if you only want memory).',
  '',
  '1. Open https://pc.0g.ai and sign in with the SAME wallet address printed',
  '   above (interactive web step — this cannot be scripted; there is no',
  '   documented headless first-credential mint as of 2026-07-25).',
  '2. Mint a Router API key (starts with "sk-").',
  '3. Export it as ZEROG_API_KEY, or add it to ~/.dmemo/config.json under',
  '   the same key name.',
  '4. See each host adapter README for how to point that host\'s chat calls',
  '   at the Router (Claude Code: ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN;',
  '   OpenCode: opencode.json "provider" entry; OpenClaw: models.providers).',
  '   Codex has no Router inference leg (no /v1/responses endpoint) —',
  '   memory-only, by design.',
].join('\n');

export async function runSetup(opts: SetupOptions = {}): Promise<SetupResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const nonInteractive = Boolean(opts.yes) || !process.stdin.isTTY;

  log('dMemo setup — private, encrypted, portable memory backed by 0G Storage\n');

  // --- Step 1: wallet ---------------------------------------------------
  // Read what is already on record BEFORE doing anything, so a re-run never
  // reaches the point of having generated a key it then has to talk itself
  // out of writing.
  const existing = inspectExistingKey(env);
  const wantsNewKey = Boolean(opts.importKey || opts.newWallet);

  // Mainnet is the default: it is the only network the funding rails reach
  // (card, cross-chain), and the only one whose memories are durable. The
  // testnet faucet is still one flag away for anyone evaluating.
  //
  // An existing config's network still wins over that default, so a plain
  // re-run of a testnet install is not silently promoted to mainnet (nor a
  // mainnet one demoted).
  const network: NetworkName =
    opts.network ?? (env.DMEMO_NETWORK as NetworkName) ?? (existing?.network as NetworkName) ?? 'mainnet';

  let wallet: WalletResult | null = null;

  if (existing && !wantsNewKey) {
    log(`Wallet already configured: ${existing.address ?? '<unreadable key>'} (${existing.source}).`);
    log('Keeping it — re-running setup never replaces a wallet.');
    log('To replace it deliberately: `dmemo setup --new-wallet`, or');
    log('`dmemo setup --import-key <hex>`.\n');
  } else {
    wallet = await obtainWallet(opts, nonInteractive);

    if (existing && existing.address?.toLowerCase() === wallet.address.toLowerCase()) {
      // Imported the key that is already configured — not a replacement at
      // all, so no gate and nothing to back up.
      log(`Wallet ${wallet.address} is already the configured one — nothing to replace.\n`);
    } else if (existing) {
      await confirmReplacement(existing, wallet.address, { nonInteractive, force: opts.force, log });
    } else {
      log(`Wallet ${wallet.generated ? 'generated' : 'imported'}. Address: ${wallet.address}`);
      log('(The private key is never printed — it is written directly to ~/.dmemo/config.json, mode 0600.)\n');
    }
  }

  const address = wallet?.address ?? existing?.address ?? '';

  // --- Step 2: ~/.dmemo/config.json --------------------------------------
  // When reusing, DMEMO_PRIVATE_KEY is deliberately absent from the updates:
  // the merge preserves it, and the write cannot possibly disturb it.
  const { path: configPath, backupPath } = writeDmemoConfig(
    {
      ...(wallet ? { DMEMO_PRIVATE_KEY: wallet.privateKey } : {}),
      DMEMO_NETWORK: network,
      // Not read by @dmemo/core's loadConfigFromEnv (derivable from the
      // key) — stored purely so `dmemo balance` and other CLI niceties
      // don't need to re-derive the address from the private key on every
      // invocation.
      DMEMO_ADDRESS: address,
      ...(wallet ? { DMEMO_KEY_SOURCE: 'generated' } : {}),
    },
    env,
    // Only ever true on the path that already passed the consent gate above.
    { allowKeyReplacement: Boolean(wallet && existing) }
  );
  log(`Wrote ${configPath} (mode 0600).\n`);
  if (backupPath && existing) {
    log(recoveryHint(existing, backupPath));
    log('');
  }

  // --- Step 3: funding -----------------------------------------------------
  await fundingStep(address, network, { ...opts, nonInteractive, log });

  // --- Step 4: per-host install -------------------------------------------
  let hosts: SetupResult['hosts'] = {};
  if (!opts.skipHosts) {
    hosts = installDetectedHosts(env, log);
    log('');
  }

  // --- Step 5: optional inference leg -------------------------------------
  log(INFERENCE_INSTRUCTIONS);

  return { address, network, configPath, hosts, walletReused: wallet === null, backupPath };
}

/**
 * Step 3. Every branch here is about not stranding the user: an empty
 * account cannot write a single memory, so "you are set up" is a lie until
 * this is resolved one way or another.
 *
 * Unattended runs never open a browser and never block — they print the
 * command and move on. Only an interactive run offers the flow, and even
 * then it is a question, not a redirect.
 */
async function fundingStep(
  address: string,
  network: NetworkName,
  ctx: SetupOptions & { nonInteractive: boolean; log: (line: string) => void }
): Promise<void> {
  const { log, nonInteractive } = ctx;

  log(`Funding — memory writes cost ~${COST_PER_WRITE_0G_LOW}–${COST_PER_WRITE_0G_HIGH} ${CURRENCY_SYMBOL} each`);
  log(`on ${chainNameFor(network)} (chain ${chainIdFor(network)}), so this account needs a`);
  log('small balance to be useful.\n');

  if (ctx.skipFunding) {
    log(`Skipped (--skip-funding). Run \`npx @dmemo/cli fund\` when you are ready.\n`);
    if (network === 'testnet') {
      log(faucetInstructions(address));
      log('');
    }
    return;
  }

  // Cheap pre-check so an already-funded re-run says nothing at all rather
  // than offering to solve a problem the user does not have.
  let funded = false;
  try {
    const balance = await checkBalance(address, network);
    funded = balance.balanceWei > 0n;
    if (funded) {
      log(`Balance: ${balance.balanceFormatted} ${CURRENCY_SYMBOL} — already funded.\n`);
      return;
    }
    // `--check-balance` predates this step, when funding was a printed faucet
    // link and the poll was opt-in. The poll is now unconditional, so the
    // flag's remaining job is to state the result out loud.
    if (ctx.checkBalanceOnce) {
      log(`Balance: ${balance.balanceFormatted} ${CURRENCY_SYMBOL} — not funded yet.\n`);
    }
  } catch (err) {
    log(`Balance check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
  }

  if (nonInteractive) {
    // No browser, no prompt, no blocking. `--yes` means "do not ask me
    // things", and opening a payment page unattended would be the single
    // most surprising thing this CLI could do.
    log(`Not funded. Run \`npx @dmemo/cli fund\` to add ${CURRENCY_SYMBOL}`);
    log(network === 'mainnet'
      ? '  (card, Apple Pay, crypto from another chain, or your own wallet).\n'
      : '  (testnet faucet).\n');
    if (network === 'testnet') {
      log(faucetInstructions(address));
      log('');
    }
    return;
  }

  const wantsFunding = await promptYesNo('Fund it now?', true);
  log('');
  if (!wantsFunding) {
    log('Skipped. Run `npx @dmemo/cli fund` any time; `npx @dmemo/cli balance` checks it.\n');
    if (network === 'testnet') {
      log(faucetInstructions(address));
      log('');
    }
    return;
  }

  try {
    await runFund({ env: ctx.env, address, network, noOpen: ctx.noOpen, log });
  } catch (err) {
    // Funding is the one step that talks to a browser, a public RPC, and a
    // payment provider — the three least reliable things in this flow. It
    // must never take the rest of setup down with it.
    log(`Funding did not complete: ${err instanceof Error ? err.message : String(err)}`);
    log('Run `npx @dmemo/cli fund` to pick it back up — nothing else is affected.\n');
  }
}

/** Generate or import, per flags and (when interactive) a prompt. Does not
 * consider what is already on disk — that is the caller's gate. */
async function obtainWallet(opts: SetupOptions, nonInteractive: boolean): Promise<WalletResult> {
  if (opts.importKey) return importWallet(opts.importKey);
  if (opts.newWallet || nonInteractive) return generateWallet();

  const choice = (
    await promptText('Generate a new wallet or import an existing key? [generate/import] ', 'generate')
  ).toLowerCase();
  if (choice.startsWith('i')) {
    const key = await promptSecret('Paste your private key (input hidden, never echoed): ');
    return importWallet(key);
  }
  return generateWallet();
}

/**
 * The consent gate. Reached only when the user explicitly asked for a
 * different key than the one configured. `--force` is the non-interactive
 * escape hatch (same contract as `solana-keygen new --force`); without it an
 * unattended run refuses rather than guessing.
 */
async function confirmReplacement(
  existing: ExistingKeyInfo,
  incomingAddress: string,
  ctx: { nonInteractive: boolean; force?: boolean; log: (line: string) => void }
): Promise<void> {
  const { log } = ctx;
  log('');
  log('!! This replaces the wallet dMemo is already using.');
  log(`   on record: ${existing.address ?? '<unreadable key>'} (${existing.source})`);
  log(`   replacing with: ${incomingAddress}`);
  log('   Memories on 0G are encrypted to the key on record. Nothing written');
  log('   under it is readable by the new wallet — ever.');
  log(`   ${recoveryHint(existing, null).split('\n').join('\n   ')}`);
  log('');

  if (ctx.force) {
    log('Proceeding: --force was given. A timestamped backup will be written first.\n');
    return;
  }

  if (ctx.nonInteractive) {
    throw new Error(
      `Refusing to replace the configured wallet ${existing.address ?? ''} without confirmation.\n` +
        'Re-run interactively, or pass --force to replace it (the old config is backed up either way).'
    );
  }

  const ok = await promptYesNo('Replace it?', false);
  if (!ok) throw new Error('Aborted — the configured wallet is untouched.');
  log('');
}
