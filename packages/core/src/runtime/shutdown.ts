import os from 'node:os';

// F7 fix: SIGTERM/SIGINT/SIGHUP currently skip every host's dispose() path,
// so a buffered-but-unflushed capture is silently lost at process exit —
// there are zero signal handlers anywhere in the repo today (verified by a
// repo-wide grep for SIGTERM/SIGINT/beforeExit/`process.on('exit'`). This
// module is the one, generic, host-agnostic fix, built on three constraints
// established from this repo's own history plus upstream research:
//
//  1. Never call `process.exit()` in a process that has used fastembed's
//     onnxruntime-node embedder: its native teardown races a static mutex
//     destructor and SIGABRTs (exit 134) specifically when exit is *forced*
//     rather than reached by natural event-loop drain (spike/RESULTS.md:154-157,
//     TASKS.md gotcha 12; upstream: microsoft/onnxruntime#24579, a
//     known 1.21.x static-destructor-order bug on macOS, reported as
//     happening "during inference cleanup/destruction" — i.e. exactly the
//     forced/immediate teardown `process.exit()` triggers, not the ordinary
//     "let the loop drain to empty" exit path). `process.exitCode` is the
//     documented (nodejs.org/api/process.md) safe alternative.
//  2. Per Node's docs ("Signal events"): SIGTERM/SIGINT have a default
//     disposition (terminate the process) that installing a listener
//     *removes* until that listener is taken back off. Every host this repo
//     talks to relies on that default disposition to die today (finding
//     #F7: no other handler exists anywhere) — so after our own cleanup we
//     must remove our listener and re-deliver the same signal to ourselves
//     (`process.kill(pid, signal)`), or the host would flush correctly and
//     then simply never exit. Re-delivering with no listener left re-enters
//     the kernel's default disposition directly (like SIGKILL) — it does
//     NOT go through Node's own exit()/cleanup-hook machinery, so it can't
//     reintroduce the mutex-abort race from constraint 1 either. This is
//     also the conventional, not-fabricated exit status: to a shell/parent
//     the process looks exactly as if the unhandled signal had killed it in
//     the first place.
//  3. A hung flush (0G Storage network I/O) must not make the process
//     unkillable: `dispose()` races a bounded timeout, and losing that race
//     force-terminates via `SIGKILL` against our own pid — unconditionally
//     safe (uncatchable, no userspace unwind of any kind) and bounded by
//     construction, satisfying "after the timeout, exit anyway."
//
// Idempotent/re-entrant: a signal received while shutdown is already running
// skips straight to the forced SIGKILL path — the user's second Ctrl-C (or a
// second SIGTERM from a process manager's escalation) always force-quits
// rather than queuing a second flush.

export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';

const DEFAULT_SIGNALS: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** 4s: long enough for a small delta upload (typical case, T0.3 measured
 * cold end-to-end well under this), short enough that an interactive
 * Ctrl-C (SIGINT) doesn't feel hung. Judgement call — see the F7 report;
 * override via `timeoutMs` per host/config if a slower/faster bound is
 * warranted. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;

export interface ShutdownReport {
  signal: ShutdownSignal;
  /** true if `dispose()` did not finish within `timeoutMs` and the process
   * is being force-terminated instead. */
  timedOut: boolean;
  /** true if this is the forced (SIGKILL) path — either a timeout, or a
   * second signal arriving while shutdown was already in progress. */
  forced: boolean;
}

export interface GracefulShutdownOptions {
  /** Runs the flush/close path (e.g. `session.waitForPendingFlush()` then
   * `session.close()`). Rejections are swallowed — fail-open, matching
   * every host's existing `dispose()` contract; memory must never break
   * process shutdown. Must be safe to call at most once per process. */
  dispose: () => Promise<void>;
  /** Bound on how long to wait for `dispose()` before forcing a hard exit.
   * Default `DEFAULT_SHUTDOWN_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Signals to intercept. Default: SIGTERM, SIGINT, SIGHUP. */
  signals?: readonly ShutdownSignal[];
  /** Best-effort diagnostics callback, fired once right before the process
   * actually terminates. Counts/reasons only (`ShutdownReport`) — never
   * pass memory contents or key material through this. Must not throw;
   * thrown errors are swallowed so a broken logger can't block shutdown. */
  onShutdown?: (report: ShutdownReport) => void;
}

/**
 * Install bounded, idempotent, re-entrant-safe shutdown handling for
 * SIGTERM/SIGINT/SIGHUP. Returns an `uninstall()` — call it if this host
 * tears the caller down without a process exit (e.g. a plugin unload/reload
 * that isn't a process shutdown), so a stale `dispose` can't fire later.
 *
 * Safe to call when nothing is buffered: `dispose()` should resolve almost
 * immediately in that case (matching every host's existing no-op-when-empty
 * flush/close), and this function never itself keeps the event loop alive
 * (a plain `process.on(signal, ...)` listener does not — verified against
 * this repo's Node runtime — only live handles like timers/sockets do), so
 * a clean process with nothing to flush still exits promptly.
 */
export function installGracefulShutdown(opts: GracefulShutdownOptions): () => void {
  const signals = opts.signals ?? DEFAULT_SIGNALS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  let shuttingDown = false;
  let settled = false;

  function uninstall(): void {
    for (const s of signals) process.removeListener(s, onSignal);
  }

  function report(r: ShutdownReport): void {
    try {
      opts.onShutdown?.(r);
    } catch {
      // Diagnostics must never break shutdown.
    }
  }

  function finish(signal: ShutdownSignal, timedOut: boolean, forced: boolean): void {
    if (settled) return;
    settled = true;
    uninstall();
    report({ signal, timedOut, forced: forced || timedOut });
    if (timedOut || forced) {
      // Unconditionally safe and bounded: SIGKILL cannot be caught and runs
      // no userspace unwind, so it can't hit the mutex-abort race and it
      // always terminates (constraint 3).
      process.kill(process.pid, 'SIGKILL');
      return;
    }
    // Graceful path: our listener is already off (uninstall() above), so
    // re-delivering the original signal now hits whatever would otherwise
    // handle it — the kernel's default disposition if nothing else in this
    // process is listening (constraint 2), or another host-owned listener,
    // untouched, if one exists. Never `process.exit()` (constraint 1).
    process.kill(process.pid, signal);
  }

  function onSignal(signal: ShutdownSignal): void {
    if (shuttingDown) {
      // Re-entrant: a second signal while shutdown is already running is
      // the user asking to force-quit — do not wait for `dispose()`.
      finish(signal, false, true);
      return;
    }
    shuttingDown = true;

    const timer = setTimeout(() => finish(signal, true, false), timeoutMs);
    // Our own bound must never be the reason the process stays alive.
    timer.unref();

    Promise.resolve()
      .then(() => opts.dispose())
      .catch(() => {
        // fail-open — mirrors every host's existing dispose() contract
      })
      .finally(() => {
        clearTimeout(timer);
        finish(signal, false, false);
      });
  }

  for (const s of signals) process.on(s, onSignal);
  return uninstall;
}

/** POSIX signal number via Node's own `os.constants.signals` table — used
 * only for documentation/diagnostics (`ShutdownReport` doesn't need it, but
 * host adapters logging a message may want "128+n" for humans). Exported so
 * callers don't need to re-derive it. */
export function conventionalExitCode(signal: ShutdownSignal): number {
  return 128 + (os.constants.signals[signal] ?? 0);
}
