import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F7 — SIGTERM/SIGINT skip dispose(), losing an unflushed capture at
// shutdown. These tests exercise the real signal-handling machinery against
// a *real child process* (node:test in-process signal delivery to yourself
// is not representative of what a host receives), per the repo's testing
// requirements: hermetic, no network, no real 0G calls, nothing written
// outside a fs.mkdtempSync scratch dir.
//
// `../../dist/runtime/shutdown.js` is this same module, already compiled by
// `tsc -b` (this test file is compiled alongside it and run from `dist/`).

const SHUTDOWN_MODULE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shutdown.js');

interface SpawnScenarioOptions {
  scenario: 'quick' | 'hang' | 'slow' | 'no-signal';
  timeoutMs: number;
  cwd: string;
}

interface RunningChild {
  child: ReturnType<typeof spawn>;
  sentinel: string;
  disposeCallsFile: string;
  waitReady: () => Promise<void>;
  waitExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>;
}

/** Writes a small standalone ESM script into `cwd` that installs
 * `installGracefulShutdown` exactly like a real host would, then either
 * idles (waiting for a signal, like a long-lived plugin host with its own
 * open sockets would) or exits immediately (nothing buffered). */
function spawnScenario(opts: SpawnScenarioOptions): RunningChild {
  const sentinel = path.join(opts.cwd, 'flushed.json');
  const disposeCallsFile = path.join(opts.cwd, 'dispose-calls.txt');
  const scriptPath = path.join(opts.cwd, 'child.mjs');

  const script = `
import { installGracefulShutdown } from ${JSON.stringify(SHUTDOWN_MODULE_PATH)};
import fs from 'node:fs';

const sentinel = ${JSON.stringify(sentinel)};
const disposeCallsFile = ${JSON.stringify(disposeCallsFile)};
const scenario = ${JSON.stringify(opts.scenario)};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function dispose() {
  fs.appendFileSync(disposeCallsFile, '1\\n');
  if (scenario === 'hang') {
    return new Promise(() => {}); // simulates a 0G upload that never returns
  }
  if (scenario === 'slow') {
    return sleep(1500).then(() => fs.writeFileSync(sentinel, 'flushed'));
  }
  fs.writeFileSync(sentinel, 'flushed');
  return Promise.resolve();
}

installGracefulShutdown({ dispose, timeoutMs: ${opts.timeoutMs} });

if (scenario === 'no-signal') {
  process.exitCode = 0;
} else {
  // Stand-in for a long-lived host's own open sockets/handles — without
  // this the child would exit the instant it's spawned, before a signal
  // could ever be delivered.
  setInterval(() => {}, 1 << 30);
  console.log('ready');
}
`;
  fs.writeFileSync(scriptPath, script);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let readyResolve!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let stdout = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.includes('ready')) readyResolve();
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const t0 = performance.now();
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    sentinel,
    disposeCallsFile,
    waitReady: () => readyPromise,
    waitExit: async () => {
      const { code, signal } = await exitPromise;
      if (code !== 0 && signal === null) {
        // Surface stderr on unexpected failures to make CI failures debuggable.
        // eslint-disable-next-line no-console
        console.error('child stderr:', stderr);
      }
      return { code, signal, elapsedMs: performance.now() - t0 };
    },
  };
}

function mkScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-shutdown-test-'));
}

test('SIGTERM runs dispose() (flush) before the process terminates', async () => {
  const dir = mkScratchDir();
  const run = spawnScenario({ scenario: 'quick', timeoutMs: 4_000, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGTERM');
  const { code, signal } = await run.waitExit();

  assert.ok(fs.existsSync(run.sentinel), 'dispose() should have run and written the flush sentinel');
  assert.equal(fs.readFileSync(run.sentinel, 'utf8'), 'flushed');
  assert.notEqual(code, 134, 'must never surface the onnxruntime/better-sqlite3 mutex-abort exit code');
  // Graceful path re-delivers the original signal once our listener is off
  // (see shutdown.ts) rather than fabricating process.exit(0) — the process
  // is genuinely signal-terminated, so Node reports it as such.
  assert.equal(signal, 'SIGTERM');
});

test('SIGINT also runs dispose() before terminating (same path as SIGTERM)', async () => {
  const dir = mkScratchDir();
  const run = spawnScenario({ scenario: 'quick', timeoutMs: 4_000, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGINT');
  const { signal, code } = await run.waitExit();

  assert.ok(fs.existsSync(run.sentinel));
  assert.equal(signal, 'SIGINT');
  assert.notEqual(code, 134);
});

test('a hung flush is bounded: the process is force-terminated after the timeout, not left unkillable', async () => {
  const dir = mkScratchDir();
  const timeoutMs = 300;
  const run = spawnScenario({ scenario: 'hang', timeoutMs, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGTERM');
  const { code, signal, elapsedMs } = await run.waitExit();

  assert.equal(signal, 'SIGKILL', 'a hung dispose() must be force-terminated, not left running forever');
  assert.notEqual(code, 134);
  // Bounded: terminates close to the configured timeout, not "eventually".
  assert.ok(elapsedMs < timeoutMs + 2_000, `expected a bounded exit, took ${elapsedMs}ms (timeout was ${timeoutMs}ms)`);
  assert.ok(!fs.existsSync(run.sentinel), 'a hung flush never completes, so nothing should have been marked flushed');
});

test('a second signal during shutdown force-quits immediately instead of starting a second flush', async () => {
  const dir = mkScratchDir();
  // dispose() takes 1.5s; timeoutMs is generous (10s) so only the second
  // signal — not the timeout — should be what ends this run.
  const run = spawnScenario({ scenario: 'slow', timeoutMs: 10_000, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 100));
  run.child.kill('SIGTERM'); // the user's "ok, I mean it" second Ctrl-C/SIGTERM
  const { signal, elapsedMs } = await run.waitExit();

  assert.equal(signal, 'SIGKILL', 'the second signal must force-quit rather than wait out the first flush');
  assert.ok(elapsedMs < 1_400, `expected a fast force-quit well before the 1.5s flush would finish, took ${elapsedMs}ms`);
  assert.ok(!fs.existsSync(run.sentinel), 'the in-progress flush should have been abandoned, not completed');
  const disposeCalls = fs.existsSync(run.disposeCallsFile) ? fs.readFileSync(run.disposeCallsFile, 'utf8').trim().split('\n') : [];
  assert.equal(disposeCalls.length, 1, 'dispose() must not be re-entered by the second signal');
});

test('nothing buffered: a clean run with no signal still exits promptly with status 0', async () => {
  const dir = mkScratchDir();
  const run = spawnScenario({ scenario: 'no-signal', timeoutMs: 4_000, cwd: dir });
  const { code, signal, elapsedMs } = await run.waitExit();

  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.ok(elapsedMs < 2_000, `installGracefulShutdown must not delay a clean exit, took ${elapsedMs}ms`);
});
