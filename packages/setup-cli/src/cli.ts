#!/usr/bin/env node
import { runSetup } from './setup.js';
import { checkBalance } from './network.js';
import { readDmemoConfig } from './dmemoConfig.js';

function parseArgs(argv: string[]) {
  const args = { command: 'setup', yes: false, network: undefined as 'testnet' | 'mainnet' | undefined, importKey: undefined as string | undefined, skipHosts: false, checkBalance: false };
  const rest = [...argv];
  const first = rest[0];
  if (first && !first.startsWith('-')) {
    args.command = first;
    rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--network') args.network = rest[++i] as 'testnet' | 'mainnet';
    else if (arg === '--import-key') args.importKey = rest[++i];
    else if (arg === '--skip-hosts') args.skipHosts = true;
    else if (arg === '--check-balance') args.checkBalance = true;
  }
  return args;
}

function printHelp(): void {
  console.log(
    [
      'dmemo — onboarding CLI for dMemo (private, encrypted, portable memory on 0G Storage)',
      '',
      'Usage:',
      '  npx dmemo setup [options]      Generate/import a wallet, write config, wire up hosts',
      '  npx dmemo balance              Check the funding balance of the configured wallet',
      '  npx dmemo help                 Show this message',
      '',
      'Options for `setup`:',
      '  --yes, -y            Non-interactive: generate a wallet, skip prompts',
      '  --network <name>     testnet (default) | mainnet',
      '  --import-key <hex>   Import an existing private key instead of generating one',
      '  --skip-hosts         Skip host detection/install (wallet + config only)',
      '  --check-balance      Poll the wallet balance once after printing the faucet link',
      '',
      'Env overrides (mainly for sandboxed testing — never used against a real install):',
      '  DMEMO_HOME   overrides ~/.dmemo',
      '  CODEX_HOME   overrides ~/.codex (Codex hook install target)',
      '  HOME         overrides the home directory used for all host detection/config paths',
    ].join('\n')
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return 0;
  }

  if (args.command === 'balance') {
    const config = readDmemoConfig();
    const address = typeof config?.DMEMO_ADDRESS === 'string' ? config.DMEMO_ADDRESS : undefined;
    if (!address) {
      console.log('No wallet address on record. Run `npx dmemo setup` first.');
      return 1;
    }
    const network = (config?.DMEMO_NETWORK as 'testnet' | 'mainnet') ?? 'testnet';
    const result = await checkBalance(address, network);
    console.log(`${address} on ${network}: ${result.balanceFormatted} 0G${result.funded ? '' : ' (not funded)'}`);
    return 0;
  }

  if (args.command === 'setup') {
    await runSetup({
      yes: args.yes,
      network: args.network,
      importKey: args.importKey,
      skipHosts: args.skipHosts,
      checkBalanceOnce: args.checkBalance || undefined,
    });
    return 0;
  }

  console.error(`Unknown command: ${args.command}`);
  printHelp();
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
