#!/usr/bin/env node
import { runSetup } from './setup.js';
import { runFund } from './fund.js';
import { checkBalance } from './network.js';
import { readDmemoConfig } from './dmemoConfig.js';
import { parseArgs, printHelp, readPackageVersion, CliUsageError } from './cliArgs.js';

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      console.error('Run `dmemo --help` for usage.');
      return 1;
    }
    throw err;
  }

  // `--version`/`-v` and `--help`/`-h` (or the `help` command) take priority
  // over everything else, from any position — see cliArgs.ts. Neither one
  // ever reaches the command dispatch below.
  if (args.version) {
    console.log(readPackageVersion());
    return 0;
  }

  if (args.help || args.command === 'help') {
    printHelp();
    return 0;
  }

  if (args.command === 'balance') {
    const config = readDmemoConfig();
    const address = typeof config?.DMEMO_ADDRESS === 'string' ? config.DMEMO_ADDRESS : undefined;
    if (!address) {
      console.log('No wallet address on record. Run `npx @dmemo/cli setup` first.');
      return 1;
    }
    const network = (config?.DMEMO_NETWORK as 'testnet' | 'mainnet') ?? 'mainnet';
    const result = await checkBalance(address, network);
    console.log(`${address} on ${network}: ${result.balanceFormatted} 0G${result.funded ? '' : ' (not funded)'}`);
    return 0;
  }

  if (args.command === 'fund') {
    await runFund({
      network: args.network,
      usd: args.usd,
      fundAmount: args.fundAmount,
      noOpen: args.noOpen,
      port: args.port,
    });
    return 0;
  }

  if (args.command === 'setup' || args.command === 'connect') {
    // `connect` was its own command back when setup could only generate or
    // import a key. Setup's step 1 now offers the same browser flow, so the
    // command survives only as an alias — the wallet flow is the default path
    // through onboarding, not a separate one.
    if (args.command === 'connect') {
      console.error(
        '`dmemo connect` is deprecated — `npx @dmemo/cli setup` now connects a wallet by default.\n' +
          'Running setup with the wallet flow preselected.\n'
      );
    }

    await runSetup({
      yes: args.yes,
      network: args.network,
      walletMode: args.command === 'connect' ? 'connect' : args.walletMode,
      scope: args.scope,
      fundAmount: args.fundAmount,
      port: args.port,
      importKey: args.importKey,
      newWallet: args.newWallet,
      force: args.force,
      skipHosts: args.skipHosts,
      skipFunding: args.skipFunding,
      noOpen: args.noOpen,
      checkBalanceOnce: args.checkBalance || undefined,
    });
    return 0;
  }

  // Unreachable: `parseArgs` only ever returns a `command` from `COMMANDS`,
  // and every member is handled above. Kept as a defensive net so a future
  // command added to one list but not the other fails loudly instead of
  // silently falling through to a wizard — which is the exact shape of F2.
  throw new Error(`internal: unhandled command '${args.command}'`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
