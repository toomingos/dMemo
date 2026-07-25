// Single seam every hook goes through: one DmemoSession open + close per
// hook invocation (gotcha 10 — hooks are fresh subprocesses, no resident
// state), MEM0_TELEMETRY set before the dynamic import (gotcha 13),
// native-module bootstrap (better-sqlite3/fastembed) run first, and the
// whole thing wrapped so any failure anywhere fails open (never throws out
// of this module — callers still get null and must exit 0 themselves).

import type { DmemoSession } from '@dmemo/core';
import { ensureNativeDeps } from './native-bootstrap.js';
import { loadDmemoEnv, isConfigured, resolveScope, debugLog } from './settings.js';

type DmemoCoreModule = typeof import('@dmemo/core');

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
  try {
    session = await core.DmemoSession.open({
      privateKey: env.DMEMO_PRIVATE_KEY as string,
      scope,
      network: (env.DMEMO_NETWORK as 'testnet' | 'mainnet' | undefined) ?? 'testnet',
    });
    return await fn({ core, session, scope });
  } catch (err) {
    debugLog('withSession: failed, fail-open', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (err) {
        debugLog('withSession: close() failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
