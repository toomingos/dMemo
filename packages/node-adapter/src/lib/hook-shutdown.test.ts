import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F7 follow-up (gotcha 28): Claude Code/Codex hook processes are
// *short-lived* (gotcha 10 — fresh subprocess per invocation), unlike the
// long-lived OpenCode/OpenClaw plugin hosts F7 originally covered. Those
// hosts keep the process alive with their own open sockets/handles and
// `installGracefulShutdown` is installed once for the process's whole
// life; a hook process has no such thing — it opens a session, does one
// bounded unit of work (a search/add + flush, real network I/O), and would
// otherwise exit the moment that work's promise settles. This file proves
// the same signal-handling machinery still works correctly in that shape:
// installed only around the open-session window (mirroring `withSession()`
// in `dmemo.ts`), with NO artificial keep-alive (no `setInterval` the way
// `../../../core/src/runtime/shutdown.test.ts`'s scenarios use to stand in
// for a long-lived host) — the only thing keeping the child process alive
// during a test is the same kind of real, bounded timer a network call
// would use, exactly as production code has.
//
// Hermetic per the task's testing requirements: real child process (in-
// process self-signaling is not representative of what a host delivers),
// no network, no real 0G, nothing written outside a `fs.mkdtempSync`
// scratch dir. The "session" here is a stub (`closeSession()` below) —
// this suite is about the wiring/timing contract, not `DmemoSession`
// itself (already covered by `packages/core`'s own tests).

const SHUTDOWN_MODULE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'core',
  'dist',
  'runtime',
  'shutdown.js'
);

interface SpawnScenarioOptions {
  /** 'quick': dispose (close) resolves fast. 'hang': dispose never
   * resolves (simulated hung 0G upload). 'slow': dispose takes 1.5s.
   * 'no-signal': hook work finishes fast and nothing ever signals it. */
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

/** Writes a standalone ESM script mirroring `withSession()`'s real
 * open/work/close shape: `installGracefulShutdown` goes up right after
 * "open", the hook's actual unit of work runs inside `try`, and `close()`
 * (idempotent, matching `DmemoSession.close()`'s own `if (this.closed)
 * return`) runs once in `finally` — same order `dmemo.ts` uses: close()
 * first (while the handler is still installed), uninstall after. */
function spawnScenario(opts: SpawnScenarioOptions): RunningChild {
  const sentinel = path.join(opts.cwd, 'flushed.json');
  const disposeCallsFile = path.join(opts.cwd, 'dispose-calls.txt');
  const scriptPath = path.join(opts.cwd, 'hook-child.mjs');

  const script = `
import { installGracefulShutdown } from ${JSON.stringify(SHUTDOWN_MODULE_PATH)};
import fs from 'node:fs';

const sentinel = ${JSON.stringify(sentinel)};
const disposeCallsFile = ${JSON.stringify(disposeCallsFile)};
const scenario = ${JSON.stringify(opts.scenario)};
const timeoutMs = ${opts.timeoutMs};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

let closed = false;
async function closeSession() {
  if (closed) return; // idempotent, mirrors DmemoSession.close()
  closed = true;
  fs.appendFileSync(disposeCallsFile, '1\\n');
  if (scenario === 'hang') {
    return new Promise(() => {}); // simulates a 0G upload that never returns
  }
  if (scenario === 'slow') {
    await sleep(1500);
  }
  fs.writeFileSync(sentinel, 'flushed');
}

async function main() {
  // "open()" — instant, mirrors DmemoSession.open() having already
  // succeeded by the time withSession() installs the shutdown handler.
  const uninstallShutdown = installGracefulShutdown({
    dispose: async () => {
      await closeSession();
    },
    timeoutMs,
  });

  try {
    if (scenario === 'no-signal') {
      // Fast path: real hook work (a search/add round trip) that finishes
      // quickly on its own, nothing ever signals it.
      await sleep(20);
    } else {
      console.log('ready');
      // Stand-in for real hook work in flight (e.g. session.memory.search()
      // awaiting a network round trip) — a real, bounded timer, NOT an
      // artificial infinite keep-alive. Long enough for the test to
      // deliver its signal(s) well before this resolves on its own.
      await sleep(5000);
    }
  } finally {
    await closeSession();
    uninstallShutdown();
  }
}

main()
  .then(() => { process.exitCode = 0; })
  .catch(() => { process.exitCode = 0; }); // fail-open, matches every hook's own contract
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
        // eslint-disable-next-line no-console
        console.error('hook child stderr:', stderr);
      }
      return { code, signal, elapsedMs: performance.now() - t0 };
    },
  };
}

function mkScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dmemo-hook-shutdown-test-'));
}

test('SIGTERM mid-flush: a hook killed while its work is in flight still flushes and closes before exiting', async () => {
  const dir = mkScratchDir();
  const run = spawnScenario({ scenario: 'quick', timeoutMs: 4_000, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGTERM');
  const { code, signal } = await run.waitExit();

  assert.ok(fs.existsSync(run.sentinel), 'close()/flush should have run before the process terminated');
  assert.notEqual(code, 134, 'must never surface the onnxruntime mutex-abort exit code');
  assert.equal(signal, 'SIGTERM', 'the conventional signal-terminated status must be preserved, not fabricated');
});

test('SIGINT mid-flush follows the same path as SIGTERM', async () => {
  const dir = mkScratchDir();
  const run = spawnScenario({ scenario: 'quick', timeoutMs: 4_000, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGINT');
  const { code, signal } = await run.waitExit();

  assert.ok(fs.existsSync(run.sentinel));
  assert.equal(signal, 'SIGINT');
  assert.notEqual(code, 134);
});

test('a hung flush is bounded: the hook process is force-terminated, never left unkillable', async () => {
  const dir = mkScratchDir();
  const timeoutMs = 300;
  const run = spawnScenario({ scenario: 'hang', timeoutMs, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGTERM');
  const { code, signal, elapsedMs } = await run.waitExit();

  assert.equal(signal, 'SIGKILL', 'a hung dispose() must be force-terminated, not left running forever');
  assert.notEqual(code, 134);
  assert.ok(elapsedMs < timeoutMs + 2_000, `expected a bounded exit, took ${elapsedMs}ms (timeout was ${timeoutMs}ms)`);
  assert.ok(!fs.existsSync(run.sentinel), 'a hung flush never completes, so nothing should be marked flushed');
});

test('a second signal during a slow flush force-quits immediately instead of waiting it out', async () => {
  const dir = mkScratchDir();
  const run = spawnScenario({ scenario: 'slow', timeoutMs: 10_000, cwd: dir });
  await run.waitReady();
  run.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 100));
  run.child.kill('SIGTERM'); // the host/user's "ok, I mean it" second signal
  const { signal, elapsedMs } = await run.waitExit();

  assert.equal(signal, 'SIGKILL', 'the second signal must force-quit rather than wait out the first flush');
  assert.ok(elapsedMs < 1_400, `expected a fast force-quit well before the 1.5s flush would finish, took ${elapsedMs}ms`);
  assert.ok(!fs.existsSync(run.sentinel), 'the in-progress flush should have been abandoned, not completed');
  const disposeCalls = fs.existsSync(run.disposeCallsFile)
    ? fs.readFileSync(run.disposeCallsFile, 'utf8').trim().split('\n')
    : [];
  assert.equal(disposeCalls.length, 1, 'close() must not be re-entered by the second signal (idempotent)');
});

test('a normal fast hook run (nothing signals it) is not slowed down and exits 0', async () => {
  const dir = mkScratchDir();
  const run = spawnScenario({ scenario: 'no-signal', timeoutMs: 4_000, cwd: dir });
  const { code, signal, elapsedMs } = await run.waitExit();

  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(run.sentinel), 'the normal finally-block close() should still have run and flushed');
  assert.ok(elapsedMs < 1_000, `installing the handler must not delay a clean exit, took ${elapsedMs}ms`);
});
