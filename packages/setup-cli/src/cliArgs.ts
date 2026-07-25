// F2 fix: argument parsing for the `dmemo` CLI.
//
// Split out of `cli.ts` so it can be imported by tests without triggering
// `cli.ts`'s top-level `main()` call (that file's shebang script runs as soon
// as it is loaded — importing it from a test would actually run `dmemo
// setup` against the test process's real argv/HOME).
//
// Root cause of F2: the old hand-rolled loop only assigned `command` when the
// first token did NOT start with `-`, so `dmemo --help` left `command` at its
// default (`setup`) and ran the full wizard. Unknown flags were matched
// against nothing and silently dropped — a typo'd flag ran a *different*
// operation than the one asked for. Both are fixed here by handing parsing to
// `node:util`'s `parseArgs` in `strict` mode: it throws
// `ERR_PARSE_ARGS_UNKNOWN_OPTION` for any flag not in `OPTION_SPEC` and
// `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` when a string flag's value is missing
// or looks like another flag (`--network --yes`), which is exactly the "hard
// error, never silently swallowed" behavior this bug needs — for free,
// instead of hand-rolling it.
import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const COMMANDS = ['setup', 'connect', 'balance', 'help'] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliArgs {
  command: Command;
  /** `--help`/`-h`, from any position. Wins over everything else — never
   * dispatches to a command. */
  help: boolean;
  /** `--version`/`-v`, from any position. Same precedence as `help`. */
  version: boolean;
  yes: boolean;
  network: 'testnet' | 'mainnet' | undefined;
  importKey: string | undefined;
  skipHosts: boolean;
  checkBalance: boolean;
  scope: string | undefined;
  fundAmount: string | undefined;
  noOpen: boolean;
  port: number | undefined;
  newWallet: boolean;
  force: boolean;
}

/** Anything the user typed wrong: an unknown command, an unknown flag, a flag
 * missing its value, or a stray extra positional. `cli.ts` catches this
 * specifically and turns it into a clean stderr message + a non-zero exit —
 * it must never be mistaken for an unexpected internal error, and it must
 * never result in falling through to a command anyway (that fallthrough is
 * the bug this type exists to prevent). */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

// The full flag surface across every subcommand, in one table, so a typo in
// any of them is rejected the same way. Flags that are only meaningful for
// one subcommand (e.g. `--scope` for `connect`, `--import-key` for `setup`)
// are still accepted globally here, same as the old hand-rolled loop did —
// each command simply reads only the fields it cares about. That is a
// pre-existing, unrelated design choice; F2 is only about *unknown* flags
// being silently ignored, not about cross-command flag validation.
const OPTION_SPEC = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  yes: { type: 'boolean', short: 'y' },
  network: { type: 'string' },
  'import-key': { type: 'string' },
  'skip-hosts': { type: 'boolean' },
  'check-balance': { type: 'boolean' },
  scope: { type: 'string' },
  'fund-amount': { type: 'string' },
  'no-open': { type: 'boolean' },
  port: { type: 'string' },
  'new-wallet': { type: 'boolean' },
  force: { type: 'boolean', short: 'f' },
} as const;

const HELP_VERSION_DEFAULTS = {
  yes: false,
  network: undefined,
  importKey: undefined,
  skipHosts: false,
  checkBalance: false,
  scope: undefined,
  fundAmount: undefined,
  noOpen: false,
  port: undefined,
  newWallet: false,
  force: false,
} as const;

export function parseArgs(argv: string[]): CliArgs {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = nodeParseArgs({
      args: argv,
      options: OPTION_SPEC,
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    // Re-thrown as our own error type so callers only ever need to catch one
    // thing; `err.message` from node:util is already a clear, specific
    // description of exactly which token was the problem.
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }

  const help = Boolean(values.help);
  const version = Boolean(values.version);

  // `--help`/`--version` win outright, from any position, and never require
  // (or even look at) a command — this is exactly the F2 contract: `dmemo
  // --help` must never run setup or connect, no matter where `--help`
  // appears or what else is on the command line.
  if (help || version) {
    return { command: 'help', help, version, ...HELP_VERSION_DEFAULTS };
  }

  if (positionals.length > 1) {
    throw new CliUsageError(`Unexpected argument: '${positionals[1]}'`);
  }
  const command = positionals[0] ?? 'setup';
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new CliUsageError(`Unknown command: '${command}'`);
  }

  let port: number | undefined;
  if (typeof values.port === 'string') {
    port = Number(values.port);
    if (!Number.isFinite(port)) {
      throw new CliUsageError(`--port expects a number, got '${values.port}'`);
    }
  }

  return {
    command: command as Command,
    help: false,
    version: false,
    yes: Boolean(values.yes),
    network: values.network as 'testnet' | 'mainnet' | undefined,
    importKey: values['import-key'] as string | undefined,
    skipHosts: Boolean(values['skip-hosts']),
    checkBalance: Boolean(values['check-balance']),
    scope: values.scope as string | undefined,
    fundAmount: values['fund-amount'] as string | undefined,
    noOpen: Boolean(values['no-open']),
    port,
    newWallet: Boolean(values['new-wallet']),
    force: Boolean(values.force),
  };
}

export function printHelp(): void {
  console.log(
    [
      'dmemo — onboarding CLI for dMemo (private, encrypted, portable memory on 0G Storage)',
      '',
      'Usage:',
      '  npx dmemo connect [options]    Connect a browser wallet; derive your memory key from a signature',
      '  npx dmemo setup [options]      Generate/import a wallet, write config, wire up hosts',
      '  npx dmemo balance              Check the funding balance of the configured wallet',
      '  npx dmemo help | --help | -h   Show this message',
      '  npx dmemo --version | -v       Show the CLI version',
      '',
      'Options for `connect`:',
      '  --network <name>     testnet (default) | mainnet',
      '  --scope <name>       Memory namespace (default: "default"). Part of the signed',
      '                       message, so a different scope on the same wallet yields a',
      '                       separate, isolated dMemo account.',
      '  --fund-amount <n>    Amount (in 0G) the page offers to send (default: 0.05)',
      '  --no-open            Print the URL instead of launching a browser',
      '  --port <n>           Bind a fixed loopback port instead of an ephemeral one',
      '  --skip-hosts         Skip host detection/install (wallet + config only)',
      '  --force, -f          Replace a locally-generated wallet without confirming',
      '',
      'Options for `setup`:',
      '  --yes, -y            Non-interactive: generate a wallet, skip prompts',
      '  --network <name>     testnet (default) | mainnet',
      '  --import-key <hex>   Import an existing private key instead of generating one',
      '  --new-wallet         Mint a new wallet even though one is configured (asks first)',
      '  --force, -f          Grant permission to replace the configured wallet',
      '  --skip-hosts         Skip host detection/install (wallet + config only)',
      '  --check-balance      Poll the wallet balance once after printing the faucet link',
      '',
      'About your wallet:',
      '  ~/.dmemo/config.json holds the ONLY key that can decrypt your memories on',
      '  0G Storage. Re-running `setup` keeps the wallet already on record; replacing',
      '  it takes an explicit flag plus confirmation, and always writes a timestamped',
      '  0600 backup of the old config next to it.',
      '',
      'Env overrides (mainly for sandboxed testing — never used against a real install):',
      '  DMEMO_HOME   overrides ~/.dmemo',
      '  CODEX_HOME   overrides ~/.codex (Codex hook install target)',
      '  HOME         overrides the home directory used for all host detection/config paths',
      '',
      'An unknown command or an unrecognized/misspelled flag is an error, not a',
      'silent no-op — dmemo exits non-zero rather than guessing what you meant.',
    ].join('\n')
  );
}

/** Reads this package's own `version` field. Never touches the network; the
 * only file it reads is the CLI's own `package.json`, which sits one
 * directory above the compiled `dist/*.js` this runs from. */
export function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
