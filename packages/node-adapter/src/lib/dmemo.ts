// Single seam every hook goes through: one DmemoSession open + close per
// hook invocation (gotcha 10 — hooks are fresh subprocesses, no resident
// state), MEM0_TELEMETRY set before the dynamic import (gotcha 13),
// native-module bootstrap (better-sqlite3/fastembed) run first, and the
// whole thing wrapped so any failure anywhere fails open (never throws out
// of this module — callers still get null and must exit 0 themselves).

import type { DmemoSession, ShutdownReport } from '@dmemo/core';
import { ensureNativeDeps } from './native-bootstrap.js';
import { loadDmemoEnv, isConfigured, resolveScope, debugLog } from './settings.js';

type DmemoCoreModule = typeof import('@dmemo/core');

/** F7 follow-up (gotcha 28): Claude Code/Codex hooks are fresh, short-lived
 * subprocesses (gotcha 10) — until now nothing here handled SIGTERM/SIGINT
 * mid-flush, so a hook killed while `session.close()`'s 0G upload was still
 * in flight lost that capture silently, same gap F7 closed for the
 * OpenCode/OpenClaw plugin hosts via `installGracefulShutdown`. Reused
 * as-is here, not re-implemented: `withSession()` is the one seam every
 * hook goes through (open -> fn -> close), so installing right after
 * `open()` and leaving it in place through the `finally`'s close() covers
 * exactly the flush window and nothing more — there's no need for a
 * whole-process-lifetime install the way a long-lived plugin host needs
 * one, since the hook process has nothing else to protect.
 *
 * Timeout: reuses `installGracefulShutdown`'s own `DEFAULT_SHUTDOWN_TIMEOUT_MS`
 * (4s) unless overridden via `DMEMO_SHUTDOWN_TIMEOUT_MS`. Verified against
 * every hook's own host-enforced timeout (`claude-dmemo/plugin/hooks/hooks.json`,
 * `src/codex/hooks-template.json`): the tightest is `UserPromptSubmit`/
 * `PreToolUse` at 10s, the rest are 30s. 4s leaves >=6s of margin under the
 * tightest budget for signal-delivery latency + the bounded dispose() itself
 * + re-delivering the original signal — comfortably bounded well inside what
 * either host will wait before it would otherwise SIGKILL/orphan the process
 * itself. Do not raise this default past a few seconds without re-checking
 * the 10s floor above.
 */
function parseShutdownTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

let cachedModule: DmemoCoreModule | null = null;

async function loadCore(): Promise<DmemoCoreModule> {
  if (cachedModule) return cachedModule;
  // Gotcha 13: must be set before the dynamic import('mem0ai/oss') that
  // @dmemo/core performs internally — static imports would hoist above an
  // assignment placed after this call, but this IS the first touch of any
  // mem0ai-importing module in the process, so setting it here (before the
  // dynamic `import('@dmemo/core')` below) is early enough.
  process.env.MEM0_TELEMETRY = 'false';
  cachedModule = await import('@dmemo/core');
  return cachedModule;
}

export interface SessionContext {
  core: DmemoCoreModule;
  session: DmemoSession;
  scope: string;
}

/**
 * Fail-open session wrapper: resolves to `null` (never throws) if dMemo is
 * unconfigured, native deps can't be bootstrapped, or `open()`/`fn` throws.
 * Always closes the session (final flush) before returning, per T1.4's
 * close() contract, even when `fn` throws.
 */
export async function withSession<T>(
  fn: (ctx: SessionContext) => Promise<T>
): Promise<T | null> {
  const env = loadDmemoEnv();
  if (!isConfigured(env)) {
    debugLog('withSession: unconfigured, fail-open');
    return null;
  }

  const boot = ensureNativeDeps();
  if (boot.error) {
    debugLog('withSession: native bootstrap failed, fail-open', boot);
    return null;
  }

  let core: DmemoCoreModule;
  try {
    core = await loadCore();
  } catch (err) {
    debugLog('withSession: failed to load @dmemo/core, fail-open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const scope = resolveScope(env);
  let session: DmemoSession | undefined;
  let uninstallShutdown: (() => void) | undefined;
  try {
    session = await core.DmemoSession.open({
      privateKey: env.DMEMO_PRIVATE_KEY as string,
      scope,
      network: (env.DMEMO_NETWORK as 'testnet' | 'mainnet' | undefined) ?? 'testnet',
    });
    const openedSession = session;
    const shutdownTimeoutMs = parseShutdownTimeoutMs(process.env.DMEMO_SHUTDOWN_TIMEOUT_MS);
    // Installed for exactly the open-session window (see the comment above
    // this function's imports) — a SIGTERM/SIGINT/SIGHUP arriving anywhere
    // between here and the `finally` below now runs the same bounded
    // flush/close a normal return would, instead of losing it to the
    // signal's default disposition.
    uninstallShutdown = core.installGracefulShutdown({
      dispose: async () => {
        await openedSession.waitForPendingFlush();
        await openedSession.close();
      },
      ...(shutdownTimeoutMs !== undefined ? { timeoutMs: shutdownTimeoutMs } : {}),
      onShutdown: (report: ShutdownReport) => {
        debugLog(`withSession: ${report.signal} received mid-hook`, {
          timedOut: report.timedOut,
          forced: report.forced,
        });
      },
    });
    return await fn({ core, session, scope });
  } catch (err) {
    debugLog('withSession: failed, fail-open', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    // Order matters: close() first, while the shutdown handler installed
    // above is still active, so a signal landing mid-close still gets the
    // bounded dispose() path rather than racing an already-removed
    // listener; uninstall only once close() has settled. `session.close()`
    // is idempotent (T1.4), so this is safe even if the shutdown handler's
    // own `dispose()` already ran/is running concurrently.
    if (session) {
      try {
        await session.close();
      } catch (err) {
        debugLog('withSession: close() failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    uninstallShutdown?.();
  }
}

/** mem0-plugin's subagent-skip guard, ported generically: Claude Code /
 * Codex Task-spawned subagent invocations carry a non-empty `agent_id` in
 * the hook stdin payload; dMemo's memory loop only tracks the top-level
 * user session, so subagent invocations are a deterministic no-op. */
export function isSubagentInvocation(input: Record<string, unknown>): boolean {
  const agentId = input.agent_id;
  return typeof agentId === 'string' && agentId.trim() !== '';
}
