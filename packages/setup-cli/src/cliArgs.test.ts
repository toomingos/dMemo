// F2 regression suite: `dmemo --help` must never fall through to setup/connect,
// and an unknown/misspelled flag or command must be a hard error rather than
// a silent no-op. Pure argv -> options parsing, no fs/network — hermetic by
// construction (`parseArgs` never touches disk or the network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, CliUsageError } from './cliArgs.js';

const DEFAULTS = {
  help: false,
  version: false,
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
};

test('no args at all: defaults to the setup command (unchanged default behavior)', () => {
  assert.deepEqual(parseArgs([]), { ...DEFAULTS, command: 'setup' });
});

test('--help in first position prints help, never runs setup', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
  assert.equal(args.command, 'help');
});

test('-h in first position is equivalent to --help', () => {
  const args = parseArgs(['-h']);
  assert.equal(args.help, true);
  assert.equal(args.command, 'help');
});

test('--help AFTER a command still short-circuits (F2: never runs the command)', () => {
  for (const argv of [
    ['setup', '--help'],
    ['connect', '--help'],
    ['setup', '--yes', '--help'],
    ['setup', '--new-wallet', '--force', '--help'],
  ]) {
    const args = parseArgs(argv);
    assert.equal(args.help, true, `expected help for ${JSON.stringify(argv)}`);
    assert.equal(args.command, 'help');
  }
});

test('`dmemo help` (positional) also prints help', () => {
  const args = parseArgs(['help']);
  assert.equal(args.command, 'help');
});

test('--version / -v report the version and never dispatch a command', () => {
  for (const argv of [['--version'], ['-v'], ['setup', '--version'], ['connect', '-v']]) {
    const args = parseArgs(argv);
    assert.equal(args.version, true, `expected version for ${JSON.stringify(argv)}`);
    assert.equal(args.command, 'help');
  }
});

test('an unknown flag is a hard error naming the offending token', () => {
  assert.throws(() => parseArgs(['setup', '--yolo']), (err: unknown) => {
    assert.ok(err instanceof CliUsageError);
    assert.match(err.message, /--yolo/);
    return true;
  });
});

test('a misspelled well-known flag is a hard error, not silently ignored', () => {
  assert.throws(() => parseArgs(['setup', '--newwallet']), CliUsageError);
  assert.throws(() => parseArgs(['connect', '--newtwork', 'testnet']), CliUsageError);
});

test('an unknown command is a hard error naming the offending token', () => {
  assert.throws(() => parseArgs(['bogus']), (err: unknown) => {
    assert.ok(err instanceof CliUsageError);
    assert.match(err.message, /bogus/);
    return true;
  });
});

test('a stray extra positional after a valid command is a hard error', () => {
  assert.throws(() => parseArgs(['setup', 'extra']), CliUsageError);
});

test('a flag that takes a value errors when the value is missing, rather than eating the next flag', () => {
  // Value simply absent (end of argv).
  assert.throws(() => parseArgs(['setup', '--network']), CliUsageError);
  assert.throws(() => parseArgs(['setup', '--import-key']), CliUsageError);
  assert.throws(() => parseArgs(['connect', '--scope']), CliUsageError);
  assert.throws(() => parseArgs(['connect', '--fund-amount']), CliUsageError);
  assert.throws(() => parseArgs(['connect', '--port']), CliUsageError);

  // Value looks like the next flag: must error, not silently consume '--yes'
  // as the value of '--network' (the exact F2-adjacent failure mode).
  assert.throws(() => parseArgs(['setup', '--network', '--yes']), (err: unknown) => {
    assert.ok(err instanceof CliUsageError);
    assert.match(err.message, /--network/);
    return true;
  });
});

test('--port must be numeric', () => {
  assert.throws(() => parseArgs(['connect', '--port', 'abc']), CliUsageError);
  const args = parseArgs(['connect', '--port', '4321']);
  assert.equal(args.port, 4321);
});

test('regression: every currently-documented invocation parses to the expected options, unchanged', () => {
  assert.deepEqual(parseArgs(['setup']), { ...DEFAULTS, command: 'setup' });

  assert.deepEqual(parseArgs(['setup', '--yes']), { ...DEFAULTS, command: 'setup', yes: true });
  assert.deepEqual(parseArgs(['setup', '-y']), { ...DEFAULTS, command: 'setup', yes: true });

  assert.deepEqual(parseArgs(['setup', '--import-key', '0xabc']), {
    ...DEFAULTS,
    command: 'setup',
    importKey: '0xabc',
  });

  assert.deepEqual(parseArgs(['setup', '--network', 'mainnet']), {
    ...DEFAULTS,
    command: 'setup',
    network: 'mainnet',
  });

  assert.deepEqual(parseArgs(['setup', '--skip-hosts']), { ...DEFAULTS, command: 'setup', skipHosts: true });

  assert.deepEqual(parseArgs(['setup', '--check-balance']), {
    ...DEFAULTS,
    command: 'setup',
    checkBalance: true,
  });

  assert.deepEqual(parseArgs(['setup', '--new-wallet']), { ...DEFAULTS, command: 'setup', newWallet: true });
  assert.deepEqual(parseArgs(['setup', '--new-wallet', '--force']), {
    ...DEFAULTS,
    command: 'setup',
    newWallet: true,
    force: true,
  });
  assert.deepEqual(parseArgs(['setup', '-f']), { ...DEFAULTS, command: 'setup', force: true });

  assert.deepEqual(parseArgs(['connect']), { ...DEFAULTS, command: 'connect' });
  assert.deepEqual(parseArgs(['connect', '--network', 'testnet']), {
    ...DEFAULTS,
    command: 'connect',
    network: 'testnet',
  });
  assert.deepEqual(parseArgs(['connect', '--scope', 'work']), {
    ...DEFAULTS,
    command: 'connect',
    scope: 'work',
  });
  assert.deepEqual(parseArgs(['connect', '--fund-amount', '0.1']), {
    ...DEFAULTS,
    command: 'connect',
    fundAmount: '0.1',
  });
  assert.deepEqual(parseArgs(['connect', '--no-open']), { ...DEFAULTS, command: 'connect', noOpen: true });
  assert.deepEqual(parseArgs(['connect', '--port', '5555']), {
    ...DEFAULTS,
    command: 'connect',
    port: 5555,
  });
  assert.deepEqual(parseArgs(['connect', '--skip-hosts']), {
    ...DEFAULTS,
    command: 'connect',
    skipHosts: true,
  });
  assert.deepEqual(parseArgs(['connect', '--force']), { ...DEFAULTS, command: 'connect', force: true });

  assert.deepEqual(parseArgs(['balance']), { ...DEFAULTS, command: 'balance' });

  assert.deepEqual(parseArgs(['help']), { ...DEFAULTS, command: 'help' });
});

test('never touches process.env or the filesystem (pure argv -> options)', () => {
  // No assertion beyond "doesn't throw for an unrelated reason" — this is a
  // structural guard: parseArgs takes only an argv array and returns a
  // plain object, so there is nothing here that could read ~/.dmemo or make
  // a network call. Combined with the security invariant enforced in
  // setup.test.ts/wallet.test.ts (private keys never printed/logged), a
  // typo'd --import-key value still never appears in a thrown error message
  // beyond being ordinary user input on the CLI the user already typed.
  const args = parseArgs(['setup', '--import-key', '0xdeadbeef']);
  assert.equal(args.importKey, '0xdeadbeef');
});
