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
// has. Replacing a wallet therefore takes an explicit ask (`--new-wallet`,
// `--connect` or `--import-key`) AND consent (an interactive y/N, or
// `--force`), and always leaves a timestamped backup behind.
//
// STEP 1 IS A BROWSER FLOW NOW. It used to offer "import an existing key" and
// then ask the user to paste one into the terminal. A private key is the most
// sensitive string a person owns; asking for it in a prompt teaches exactly
// the habit that phishing relies on, and it cannot be un-taught by a
// reassuring line of copy underneath. So the interactive menu offers
// "connect a wallet" instead, which opens the loopback page in
// `connect/` — the user picks a wallet, signs a message twice, and dMemo
// derives a dedicated account from the signature. The wallet's own key never
// leaves the wallet. `--import-key <hex>` survives as a flag for scripted
// installs and for restoring from a backup, where there is no prompt to
// phish.

import { generateWallet, importWallet, type WalletResult } from './wallet.js';
import {
  acquireWalletViaBrowser,
  connectPreamble,
  DEFAULT_FUND_AMOUNT_ETHER,
} from './connect/acquire.js';
import { DERIVATION_VERSION } from './connect/derive.js';
import {
  fundingHelp,
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
import { promptSelect, promptYesNo } from './prompt.js';
import {
  amber,
  bold,
  dim,
  indent,
  lime,
  outcome,
  red,
  status,
  step,
  symbols,
  tildify,
  wrap,
} from './theme.js';

/** Steps the user is walked through, in order. Only used for the `n/5`
 * counter — the step bodies live inline in `runSetup`. */
const TOTAL_STEPS = 5;

/** How step 1 gets a key.
 *  - `connect`  browser wallet + signature -> derived account (the default)
 *  - `generate` a random local key, no wallet involved
 *  - `import`   an existing key supplied via `--import-key` (flag only; there
 *               is deliberately no prompt that asks for one) */
export type WalletMode = 'connect' | 'generate' | 'import';

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** Non-interactive mode: no prompts, sensible defaults, never blocks on
   * stdin. Used by CI and by this task's own sandboxed test run. */
  yes?: boolean;
  network?: NetworkName;
  /** Force step 1 down one path instead of asking. Stating a mode is itself
   * an explicit ask for a new key, so it goes through the same consent gate
   * as `--new-wallet`. */
  walletMode?: WalletMode;
  /** Memory namespace, for `connect`. Part of the signed message, so a
   * different scope on the same wallet yields a separate, isolated account. */
  scope?: string;
  /** Amount (in 0G) the connect page offers to send to the derived account. */
  fundAmount?: string;
  /** Fixed loopback port for the browser flows, instead of an ephemeral one. */
  port?: number;
  /** How long the connect page may sit unanswered before giving up. */
  timeoutMs?: number;
  /** Override the chain's default RPC endpoint — for a private/rate-limited
   * node, and for tests that must not reach the public one. */
  rpcUrl?: string;
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
  /** How the key in `address` came to be. */
  keySource: 'connect' | 'generated';
  /** The wallet the user connected, when `keySource` is `connect`. It funds
   * the account and proves identity; it never holds memory data. */
  walletAddress: string | null;
  /** Memory namespace, when `keySource` is `connect`. */
  scope: string | null;
}

// A numbered procedure whose indentation carries meaning, so this one stays
// hand-shaped rather than going through `wrap()`.
const INFERENCE_INSTRUCTIONS = [
  '  1. Open https://pc.0g.ai and sign in with the SAME wallet address',
  '     printed above (interactive web step — this cannot be scripted;',
  '     there is no documented headless first-credential mint).',
  '  2. Mint a Router API key (starts with "sk-").',
  '  3. Export it as ZEROG_API_KEY, or add it to ~/.dmemo/config.json',
  '     under the same key name.',
  '  4. See each host adapter README for how to point that host\'s chat',
  '     calls at the Router (Claude Code: ANTHROPIC_BASE_URL and',
  '     ANTHROPIC_AUTH_TOKEN; OpenCode: opencode.json "provider" entry;',
  '     OpenClaw: models.providers). Codex has no Router inference leg',
  '     (no /v1/responses endpoint) — memory-only, by design.',
].join('\n');

export async function runSetup(opts: SetupOptions = {}): Promise<SetupResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const nonInteractive = Boolean(opts.yes) || !process.stdin.isTTY;

  const started = Date.now();

  log(`${lime(symbols().mark)} ${bold('dMemo')} ${dim('private, encrypted, portable memory on 0G Storage')}\n`);

  // --- Step 1: wallet ---------------------------------------------------
  // Read what is already on record BEFORE doing anything, so a re-run never
  // reaches the point of having generated a key it then has to talk itself
  // out of writing.
  const existing = inspectExistingKey(env);
  // Naming a mode is itself a request for a different key, so it counts the
  // same as `--new-wallet` here and goes through the same consent gate.
  const wantsNewKey = Boolean(opts.importKey || opts.newWallet || opts.walletMode);

  // Mainnet is the default: it is the only network the funding rails reach
  // (card, cross-chain), and the only one whose memories are durable. The
  // testnet faucet is still one flag away for anyone evaluating.
  //
  // An existing config's network still wins over that default, so a plain
  // re-run of a testnet install is not silently promoted to mainnet (nor a
  // mainnet one demoted).
  const network: NetworkName =
    opts.network ?? (env.DMEMO_NETWORK as NetworkName) ?? (existing?.network as NetworkName) ?? 'mainnet';

  const scope = opts.scope ?? env.DMEMO_SCOPE ?? 'default';

  let wallet: ObtainedWallet | null = null;

  log(step(1, TOTAL_STEPS, 'Wallet'));

  if (existing && !wantsNewKey) {
    log(status('ok', `kept ${bold(existing.address ?? '<unreadable key>')}`, `(${existing.source})`));
    log(wrap('Keeping it — re-running setup never replaces a wallet. To replace it deliberately: `dmemo setup --new-wallet`, `--connect`, or `--import-key <hex>`.', 4));
    log('');
  } else {
    const mode = await chooseWalletMode(opts, nonInteractive);

    // The consent gate runs BEFORE `connect` and AFTER the other two, and the
    // asymmetry is deliberate. Generating or importing is instant and free, so
    // the gate can name the exact address it is about to displace — strictly
    // better information. Connecting costs a browser round-trip and asks the
    // user to sign twice; making them do all that only to be told "actually,
    // no" would be rude, and we cannot know the derived address until they
    // have already done it.
    if (mode === 'connect' && existing) {
      await confirmReplacement(existing, null, { nonInteractive, force: opts.force, log });
    }

    wallet = await obtainWallet(mode, { ...opts, scope, network, nonInteractive, log });

    if (existing && existing.address?.toLowerCase() === wallet.address.toLowerCase()) {
      // Imported (or re-derived) the key that is already configured — not a
      // replacement at all, so no gate and nothing to back up.
      log(status('ok', `${bold(wallet.address)} is already the configured one`, '— nothing to replace'));
      log('');
    } else if (existing && mode !== 'connect') {
      await confirmReplacement(existing, wallet.address, { nonInteractive, force: opts.force, log });
    } else if (mode === 'connect') {
      log(status('ok', `dMemo account ${bold(wallet.address)}`, '— derived from your signature'));
      log(dim(wrap(`Derived from ${wallet.connectedWallet} in scope "${scope}". Connect that same wallet on another machine to get this same account back — the key itself is never displayed or transmitted.`, 4)));
      log('');
    } else {
      log(status('ok', `${wallet.generated ? 'generated' : 'imported'} ${bold(wallet.address)}`));
      log(dim(wrap('the only key that can decrypt your memory — never printed, written straight to ~/.dmemo/config.json at mode 0600', 4)));
      log('');
    }
  }

  const address = wallet?.address ?? existing?.address ?? '';
  const keySource: 'connect' | 'generated' =
    wallet ? (wallet.mode === 'connect' ? 'connect' : 'generated') : (existing?.source ?? 'generated');
  const walletAddress = wallet?.connectedWallet ?? (wallet ? null : existing?.connectedWallet ?? null);

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
      // Provenance. Neither field is read by core; they exist so a later run
      // can tell a reproducible connect-derived account from an
      // irreproducible local one (which is what decides whether replacing it
      // is recoverable), and so the user can see which wallet to reconnect on
      // another machine.
      ...(wallet
        ? wallet.mode === 'connect'
          ? {
              DMEMO_KEY_SOURCE: 'connect' as const,
              DMEMO_KEY_VERSION: String(DERIVATION_VERSION),
              DMEMO_CONNECTED_WALLET: wallet.connectedWallet,
              DMEMO_SCOPE: scope,
            }
          : { DMEMO_KEY_SOURCE: 'generated' as const }
        : {}),
    },
    env,
    // Only ever true on the path that already passed the consent gate above.
    { allowKeyReplacement: Boolean(wallet && existing) }
  );
  log(step(2, TOTAL_STEPS, 'Config'));
  log(status('ok', `wrote ${bold(tildify(configPath, env))}`, 'mode 0600'));
  if (backupPath && existing) {
    // The backup path stays untildified: it is the one string a user may need
    // to paste verbatim into `cp`, and this is the only place it is printed.
    log(wrap(recoveryHint(existing, backupPath), 4));
  }
  log('');

  // --- Step 3: funding -----------------------------------------------------
  log(step(3, TOTAL_STEPS, 'Funding'));
  const funding = await fundingStep(address, network, { ...opts, nonInteractive, log });

  // --- Step 4: per-host install -------------------------------------------
  log(step(4, TOTAL_STEPS, 'Agents'));
  let hosts: SetupResult['hosts'] = {};
  if (opts.skipHosts) {
    log(status('skip', 'skipped', '(--skip-hosts)'));
  } else {
    hosts = installDetectedHosts(env, log);
  }
  log('');

  // --- Step 5: optional inference leg -------------------------------------
  log(step(5, TOTAL_STEPS, 'Inference'));
  log(status('skip', 'optional', '— private LLM via the 0G Compute Router'));
  log(dim(wrap('Separate from the memory leg above; skip this entirely if you only want memory.', 4)));
  log('');
  log(dim(indent(INFERENCE_INSTRUCTIONS, 2)));
  log('');

  // --- Summary -------------------------------------------------------------
  // Last, deliberately. The inference block above is the step most users skip,
  // and it used to be the final thing on screen.
  printSummary({
    address,
    network,
    hosts,
    funding,
    skipHosts: Boolean(opts.skipHosts),
    started,
    log,
    walletAddress,
    scope: keySource === 'connect' ? scope : null,
  });

  return {
    address,
    network,
    configPath,
    hosts,
    walletReused: wallet === null,
    backupPath,
    keySource,
    walletAddress,
    scope: keySource === 'connect' ? scope : null,
  };
}

interface FundingOutcome {
  funded: boolean;
  balanceLabel: string | null;
}

/** Detected-and-wired vs detected-but-failed, derived from what the installers
 * returned so the summary cannot disagree with the step-4 lines above it. */
function hostTally(hosts: InstalledHosts): { wired: number; detected: number } {
  const results = [
    hosts.claudeCode ? Boolean(hosts.claudeCode.succeeded) : null,
    hosts.codex ? !('error' in hosts.codex) : null,
    hosts.opencode ? Boolean(hosts.opencode.succeeded) : null,
    hosts.openclaw ? Boolean(hosts.openclaw.succeeded) : null,
  ].filter((r): r is boolean => r !== null);

  return { wired: results.filter(Boolean).length, detected: results.length };
}

/**
 * The closing block. Its whole job is to answer, without scrolling: did this
 * work, what is my account, can it actually write yet, and what do I run next.
 */
function printSummary(ctx: {
  address: string;
  network: NetworkName;
  hosts: InstalledHosts;
  funding: FundingOutcome;
  skipHosts: boolean;
  started: number;
  log: (line: string) => void;
  walletAddress: string | null;
  scope: string | null;
}): void {
  const { log, funding } = ctx;
  const { wired, detected } = hostTally(ctx.hosts);
  const elapsed = `${((Date.now() - ctx.started) / 1000).toFixed(1)}s`;

  const agents = ctx.skipHosts
    ? 'agents skipped'
    : detected === 0
      ? 'no agents detected'
      : `${wired} of ${detected} agents wired`;

  log(outcome('Ready', `${agents}  ${symbols().bullet}  ${elapsed}`));
  log('');
  log(`  ${dim('account')}   ${bold(ctx.address)}`);
  if (ctx.walletAddress) log(`  ${dim('wallet')}    ${ctx.walletAddress} ${dim('— reconnect this to restore your memories')}`);
  if (ctx.scope) log(`  ${dim('scope')}     ${ctx.scope}`);
  log(`  ${dim('network')}   ${chainNameFor(ctx.network)} ${dim(`(chain ${chainIdFor(ctx.network)})`)}`);

  if (funding.funded) {
    log(`  ${dim('balance')}   ${lime(`${funding.balanceLabel} ${CURRENCY_SYMBOL}`)}`);
  } else {
    const label = funding.balanceLabel ?? '0.0';
    log(`  ${dim('balance')}   ${amber(`${label} ${CURRENCY_SYMBOL}`)} ${dim('— fund it before your first write')}`);
  }

  log('');
  const next: Array<[string, string]> = [];
  if (!funding.funded) next.push(['npx @dmemo/cli fund', 'add 0G']);
  next.push(['npx @dmemo/cli balance', 'check the balance']);
  if (!ctx.skipHosts && detected > 0 && wired < detected) {
    next.push(['npx @dmemo/cli setup', 're-run to retry the agents above']);
  }

  const pad = Math.max(...next.map(([cmd]) => cmd.length));
  next.forEach(([cmd, why], i) => {
    log(`  ${dim(i === 0 ? 'next' : '    ')}  ${lime(cmd.padEnd(pad))}  ${dim(why)}`);
  });
  log('');
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
): Promise<FundingOutcome> {
  const { log, nonInteractive } = ctx;

  // The one instruction for "you still need to put money in this account".
  // Shared with `dmemo fund` (see `fundingHelp`) so the two commands cannot
  // give different answers to the same question.
  const howToFund = (): void => log(fundingHelp(address, network));

  const costNote = `writes cost ~${COST_PER_WRITE_0G_LOW}–${COST_PER_WRITE_0G_HIGH} ${CURRENCY_SYMBOL} each`;

  if (ctx.skipFunding) {
    log(status('skip', 'skipped', `(--skip-funding) — ${costNote}`));
    howToFund();
    log('');
    return { funded: false, balanceLabel: null };
  }

  // Cheap pre-check so an already-funded re-run says nothing at all rather
  // than offering to solve a problem the user does not have.
  let balanceLabel: string | null = null;
  try {
    const balance = await checkBalance(address, network);
    balanceLabel = balance.balanceFormatted;
    if (balance.balanceWei > 0n) {
      log(status('ok', `already funded`, `${balance.balanceFormatted} ${CURRENCY_SYMBOL}`));
      log('');
      return { funded: true, balanceLabel };
    }
    // `--check-balance` predates this step, when funding was a printed faucet
    // link and the poll was opt-in. The poll is now unconditional, so the
    // flag's remaining job is to state the result out loud.
    if (ctx.checkBalanceOnce) {
      log(status('skip', `not funded yet`, `${balance.balanceFormatted} ${CURRENCY_SYMBOL}`));
    }
  } catch (err) {
    log(status('skip', 'balance check failed', `(non-fatal) ${err instanceof Error ? err.message : String(err)}`));
  }

  if (nonInteractive) {
    // No browser, no prompt, no blocking. `--yes` means "do not ask me
    // things", and opening a payment page unattended would be the single
    // most surprising thing this CLI could do.
    log(status('skip', 'not funded', `— ${costNote}`));
    howToFund();
    log('');
    return { funded: false, balanceLabel };
  }

  const wantsFunding = await promptYesNo('  Fund it now?', true);
  if (!wantsFunding) {
    log(status('skip', 'skipped', `— ${costNote}`));
    howToFund();
    log('');
    return { funded: false, balanceLabel };
  }

  try {
    await runFund({ env: ctx.env, address, network, noOpen: ctx.noOpen, log, embedded: true });
    // runFund's own completion is authoritative; re-read so the summary
    // reports what actually landed rather than what was requested.
    const after = await checkBalance(address, network);
    log('');
    return { funded: after.balanceWei > 0n, balanceLabel: after.balanceFormatted };
  } catch (err) {
    // Funding is the one step that talks to a browser, a public RPC, and a
    // payment provider — the three least reliable things in this flow. It
    // must never take the rest of setup down with it.
    log(status('bad', 'funding did not complete', err instanceof Error ? err.message : String(err)));
    log(dim(wrap('Run `npx @dmemo/cli fund` to pick it back up — nothing else is affected.', 4)));
    log('');
    return { funded: false, balanceLabel };
  }
}

interface ObtainedWallet extends WalletResult {
  mode: WalletMode;
  /** Only for `connect`: the wallet that signed. Never holds memory data. */
  connectedWallet?: string;
}

/**
 * Decides HOW step 1 gets a key, without doing it. Split from `obtainWallet`
 * so the caller can run the consent gate against the chosen mode before a
 * browser opens.
 *
 * Explicit flags win. Absent those, an unattended run always generates: `--yes`
 * means "do not ask me things", and spawning a browser that waits for a wallet
 * signature is the single most surprising thing this CLI could do to a CI job.
 */
async function chooseWalletMode(opts: SetupOptions, nonInteractive: boolean): Promise<WalletMode> {
  if (opts.importKey) return 'import';
  if (opts.walletMode) return opts.walletMode;
  if (opts.newWallet || nonInteractive) return 'generate';

  return await promptSelect<WalletMode>(
    'How do you want your wallet?',
    [
      {
        value: 'connect',
        label: 'Connect a wallet',
        hint: 'opens your browser — nothing to paste, and the same wallet restores your memories on any machine',
      },
      {
        value: 'generate',
        label: 'Generate a new one',
        hint: 'no wallet needed — minted locally, never printed, lives only in ~/.dmemo/config.json',
      },
    ],
    { defaultIndex: 0 }
  );
}

/** Runs the chosen mode. Does not consider what is already on disk — that is
 * the caller's gate. */
async function obtainWallet(
  mode: WalletMode,
  ctx: SetupOptions & {
    scope: string;
    network: NetworkName;
    nonInteractive: boolean;
    log: (line: string) => void;
  }
): Promise<ObtainedWallet> {
  if (mode === 'import') {
    if (!ctx.importKey) throw new Error('internal: import mode without a key');
    return { ...importWallet(ctx.importKey), mode };
  }
  if (mode === 'generate') return { ...generateWallet(), mode };

  ctx.log(connectPreamble());
  ctx.log('');
  const acquired = await acquireWalletViaBrowser({
    network: ctx.network,
    scope: ctx.scope,
    fundAmount: ctx.fundAmount ?? DEFAULT_FUND_AMOUNT_ETHER,
    noOpen: ctx.noOpen,
    port: ctx.port,
    timeoutMs: ctx.timeoutMs,
    rpcUrl: ctx.rpcUrl,
    log: ctx.log,
  });

  return {
    privateKey: acquired.account.privateKey,
    address: acquired.account.address,
    // Derived, not minted: reproducible from the wallet forever, which is the
    // whole reason `generated` would be the wrong word here.
    generated: false,
    mode,
    connectedWallet: acquired.walletAddress,
  };
}

/**
 * The consent gate. Reached only when the user explicitly asked for a
 * different key than the one configured. `--force` is the non-interactive
 * escape hatch (same contract as `solana-keygen new --force`); without it an
 * unattended run refuses rather than guessing.
 *
 * `incomingAddress` is null on the pre-flight path (`connect`), where the
 * derived address genuinely is not knowable yet — the user has to sign first,
 * and asking them to do that before taking consent would be backwards.
 */
async function confirmReplacement(
  existing: ExistingKeyInfo,
  incomingAddress: string | null,
  ctx: { nonInteractive: boolean; force?: boolean; log: (line: string) => void }
): Promise<void> {
  const { log } = ctx;
  log(status('bad', red('This replaces the wallet dMemo is already using.')));
  log(`     ${dim('on record')}       ${existing.address ?? '<unreadable key>'} ${dim(`(${existing.source})`)}`);
  log(
    `     ${dim('replacing with')}  ${incomingAddress ?? dim('the account derived from the wallet you are about to connect')}`
  );
  log(dim(wrap('Memories on 0G are encrypted to the key on record. Nothing written under it is readable by the new wallet — ever.', 5)));
  log(dim(wrap(recoveryHint(existing, null), 5)));
  log('');

  if (ctx.force) {
    log(dim(wrap('Proceeding: --force was given. A timestamped backup will be written first.', 4)));
    log('');
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
