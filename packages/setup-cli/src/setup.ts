// T4.1 orchestrator — `dmemo setup`. Steps run in the exact order the task
// spec lists: wallet -> faucet/funding -> ~/.dmemo/config.json -> per-host
// install -> optional inference leg (instructions only, never scripted).
//
// The memory leg (steps 1-4) completes with ZERO interactive web steps.
// Step 5 (inference) is documented, not automated (accepted gap, D-cited in
// TASKS.md T4.1: "no documented headless first-key mint").

import { generateWallet, importWallet, type WalletResult } from './wallet.js';
import { faucetInstructions, checkBalance, MAINNET_CHAIN_ID } from './network.js';
import { writeDmemoConfig, type NetworkName } from './dmemoConfig.js';
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
  skipHosts?: boolean;
  checkBalanceOnce?: boolean;
  log?: (line: string) => void;
}

export interface SetupResult {
  address: string;
  network: NetworkName;
  configPath: string;
  hosts: InstalledHosts;
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
  const network: NetworkName = opts.network ?? (env.DMEMO_NETWORK as NetworkName) ?? 'testnet';

  log('dMemo setup — private, encrypted, portable memory backed by 0G Storage\n');

  // --- Step 1: wallet ---------------------------------------------------
  let wallet: WalletResult;
  if (opts.importKey) {
    wallet = importWallet(opts.importKey);
  } else if (nonInteractive) {
    wallet = generateWallet();
  } else {
    const choice = (await promptText('Generate a new wallet or import an existing key? [generate/import] ', 'generate'))
      .toLowerCase();
    if (choice.startsWith('i')) {
      const key = await promptSecret('Paste your private key (input hidden, never echoed): ');
      wallet = importWallet(key);
    } else {
      wallet = generateWallet();
    }
  }
  log(`Wallet ${wallet.generated ? 'generated' : 'imported'}. Address: ${wallet.address}`);
  log('(The private key is never printed — it is written directly to ~/.dmemo/config.json, mode 0600.)\n');

  // --- Step 2: faucet / funding -----------------------------------------
  if (network === 'testnet') {
    log(faucetInstructions(wallet.address));
    log('');
    const shouldCheck = opts.checkBalanceOnce ?? (!nonInteractive && (await promptYesNo('Check balance now?', false)));
    if (shouldCheck) {
      await pollBalanceOnce(wallet.address, network, log);
    } else {
      log('Skipping balance check. Re-run `dmemo setup --check-balance` any time.\n');
    }
  } else {
    log(`Network: mainnet (chain ${MAINNET_CHAIN_ID}) — fund ${wallet.address} yourself; no faucet on mainnet.\n`);
  }

  // --- Step 3: ~/.dmemo/config.json --------------------------------------
  const { path: configPath } = writeDmemoConfig(
    {
      DMEMO_PRIVATE_KEY: wallet.privateKey,
      DMEMO_NETWORK: network,
      // Not read by @dmemo/core's loadConfigFromEnv (derivable from the
      // key) — stored purely so `dmemo balance` and other CLI niceties
      // don't need to re-derive the address from the private key on every
      // invocation.
      DMEMO_ADDRESS: wallet.address,
    },
    env
  );
  log(`Wrote ${configPath} (mode 0600).\n`);

  // --- Step 4: per-host install -------------------------------------------
  let hosts: SetupResult['hosts'] = {};
  if (!opts.skipHosts) {
    hosts = installDetectedHosts(env, log);
    log('');
  }

  // --- Step 5: optional inference leg -------------------------------------
  log(INFERENCE_INSTRUCTIONS);

  return { address: wallet.address, network, configPath, hosts };
}

async function pollBalanceOnce(
  address: string,
  network: NetworkName,
  log: (line: string) => void
): Promise<void> {
  try {
    const result = await checkBalance(address, network);
    if (result.funded) {
      log(`Balance: ${result.balanceFormatted} 0G — funded.\n`);
    } else {
      log('Balance: 0 0G — not funded yet. Claim from the faucet above, then re-run `dmemo setup --check-balance`.\n');
    }
  } catch (err) {
    log(`Balance check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
