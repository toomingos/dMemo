// T4.1 orchestrator — `dmemo setup`. Steps run in the exact order the task
// spec lists: wallet -> faucet/funding -> ~/.dmemo/config.json -> per-host
// install -> optional inference leg (instructions only, never scripted).
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
import { generateWallet, importWallet } from './wallet.js';
import { faucetInstructions, checkBalance, MAINNET_CHAIN_ID } from './network.js';
import { writeDmemoConfig, inspectExistingKey, recoveryHint, } from './dmemoConfig.js';
import { installDetectedHosts } from './installHosts.js';
import { promptText, promptYesNo, promptSecret } from './prompt.js';
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
export async function runSetup(opts = {}) {
    const env = opts.env ?? process.env;
    const log = opts.log ?? ((line) => console.log(line));
    const nonInteractive = Boolean(opts.yes) || !process.stdin.isTTY;
    log('dMemo setup — private, encrypted, portable memory backed by 0G Storage\n');
    // --- Step 1: wallet ---------------------------------------------------
    // Read what is already on record BEFORE doing anything, so a re-run never
    // reaches the point of having generated a key it then has to talk itself
    // out of writing.
    const existing = inspectExistingKey(env);
    const wantsNewKey = Boolean(opts.importKey || opts.newWallet);
    // An existing config's network wins over the built-in default, so a plain
    // re-run of a mainnet install doesn't quietly demote it to testnet.
    const network = opts.network ?? env.DMEMO_NETWORK ?? existing?.network ?? 'testnet';
    let wallet = null;
    if (existing && !wantsNewKey) {
        log(`Wallet already configured: ${existing.address ?? '<unreadable key>'} (${existing.source}).`);
        log('Keeping it — re-running setup never replaces a wallet.');
        log('To replace it deliberately: `dmemo setup --new-wallet`, or');
        log('`dmemo setup --import-key <hex>`.\n');
    }
    else {
        wallet = await obtainWallet(opts, nonInteractive);
        if (existing && existing.address?.toLowerCase() === wallet.address.toLowerCase()) {
            // Imported the key that is already configured — not a replacement at
            // all, so no gate and nothing to back up.
            log(`Wallet ${wallet.address} is already the configured one — nothing to replace.\n`);
        }
        else if (existing) {
            await confirmReplacement(existing, wallet.address, { nonInteractive, force: opts.force, log });
        }
        else {
            log(`Wallet ${wallet.generated ? 'generated' : 'imported'}. Address: ${wallet.address}`);
            log('(The private key is never printed — it is written directly to ~/.dmemo/config.json, mode 0600.)\n');
        }
    }
    const address = wallet?.address ?? existing?.address ?? '';
    // --- Step 2: faucet / funding -----------------------------------------
    if (network === 'testnet') {
        log(faucetInstructions(address));
        log('');
        const shouldCheck = opts.checkBalanceOnce ?? (!nonInteractive && (await promptYesNo('Check balance now?', false)));
        if (shouldCheck) {
            await pollBalanceOnce(address, network, log);
        }
        else {
            log('Skipping balance check. Re-run `dmemo setup --check-balance` any time.\n');
        }
    }
    else {
        log(`Network: mainnet (chain ${MAINNET_CHAIN_ID}) — fund ${address} yourself; no faucet on mainnet.\n`);
    }
    // --- Step 3: ~/.dmemo/config.json --------------------------------------
    // When reusing, DMEMO_PRIVATE_KEY is deliberately absent from the updates:
    // the merge preserves it, and the write cannot possibly disturb it.
    const { path: configPath, backupPath } = writeDmemoConfig({
        ...(wallet ? { DMEMO_PRIVATE_KEY: wallet.privateKey } : {}),
        DMEMO_NETWORK: network,
        // Not read by @dmemo/core's loadConfigFromEnv (derivable from the
        // key) — stored purely so `dmemo balance` and other CLI niceties
        // don't need to re-derive the address from the private key on every
        // invocation.
        DMEMO_ADDRESS: address,
        ...(wallet ? { DMEMO_KEY_SOURCE: 'generated' } : {}),
    }, env, 
    // Only ever true on the path that already passed the consent gate above.
    { allowKeyReplacement: Boolean(wallet && existing) });
    log(`Wrote ${configPath} (mode 0600).\n`);
    if (backupPath && existing) {
        log(recoveryHint(existing, backupPath));
        log('');
    }
    // --- Step 4: per-host install -------------------------------------------
    let hosts = {};
    if (!opts.skipHosts) {
        hosts = installDetectedHosts(env, log);
        log('');
    }
    // --- Step 5: optional inference leg -------------------------------------
    log(INFERENCE_INSTRUCTIONS);
    return { address, network, configPath, hosts, walletReused: wallet === null, backupPath };
}
/** Generate or import, per flags and (when interactive) a prompt. Does not
 * consider what is already on disk — that is the caller's gate. */
async function obtainWallet(opts, nonInteractive) {
    if (opts.importKey)
        return importWallet(opts.importKey);
    if (opts.newWallet || nonInteractive)
        return generateWallet();
    const choice = (await promptText('Generate a new wallet or import an existing key? [generate/import] ', 'generate')).toLowerCase();
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
async function confirmReplacement(existing, incomingAddress, ctx) {
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
        throw new Error(`Refusing to replace the configured wallet ${existing.address ?? ''} without confirmation.\n` +
            'Re-run interactively, or pass --force to replace it (the old config is backed up either way).');
    }
    const ok = await promptYesNo('Replace it?', false);
    if (!ok)
        throw new Error('Aborted — the configured wallet is untouched.');
    log('');
}
async function pollBalanceOnce(address, network, log) {
    try {
        const result = await checkBalance(address, network);
        if (result.funded) {
            log(`Balance: ${result.balanceFormatted} 0G — funded.\n`);
        }
        else {
            log('Balance: 0 0G — not funded yet. Claim from the faucet above, then re-run `dmemo setup --check-balance`.\n');
        }
    }
    catch (err) {
        log(`Balance check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
    }
}
//# sourceMappingURL=setup.js.map