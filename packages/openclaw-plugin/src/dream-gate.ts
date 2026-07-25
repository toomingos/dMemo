// Dream consolidation gate. Ported (KEEP, per T3.3/D18) from
// `@mem0/openclaw-mem0`'s `dream-gate.ts:104-185` — cheap local-file gates
// (time + session count) run before any expensive memory-count check,
// plus an exclusive file lock so only one consolidation run proceeds at a
// time. Consolidation mutations always get tagged `source: "dream"` and the
// whole burst is flushed as ONE delta blob (see `runDreamBatch` below) —
// `@dmemo/core`'s `JournalingVectorStore.drainJournal()` already batches
// every op queued since the last `flush()` into a single blob
// (`packages/core/src/session.ts:335-338`), so this falls out of calling
// `session.memory.add()` N times before a single `session.flush()`, with no
// core changes needed.

import * as fs from "node:fs";
import * as path from "node:path";
import type { DmemoSession } from "@dmemo/core";

interface DreamState {
  lastConsolidatedAt: number;
  sessionsSince: number;
  lastSessionId: string | null;
}

interface DreamLock {
  pid: number;
  startedAt: number;
}

export interface DreamGateConfig {
  minHours?: number;
  minSessions?: number;
  minMemories?: number;
}

const DEFAULTS: Required<DreamGateConfig> = {
  minHours: 24,
  minSessions: 5,
  minMemories: 20,
};

const LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour

function statePath(stateDir: string): string {
  return path.join(stateDir, "dream-state.json");
}
function lockPath(stateDir: string): string {
  return path.join(stateDir, "dream.lock");
}
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readState(stateDir: string): DreamState {
  try {
    return JSON.parse(fs.readFileSync(statePath(stateDir), "utf-8")) as DreamState;
  } catch {
    return { lastConsolidatedAt: 0, sessionsSince: 0, lastSessionId: null };
  }
}

function writeState(stateDir: string, state: DreamState): void {
  ensureDir(stateDir);
  fs.writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2));
}

/** Call from `agent_end` on every interactive turn to advance the session counter. */
export function incrementSessionCount(stateDir: string, sessionId: string): void {
  const state = readState(stateDir);
  if (state.lastSessionId !== sessionId) {
    state.sessionsSince++;
    state.lastSessionId = sessionId;
    writeState(stateDir, state);
  }
}

/** Cheap gates: local file reads only. Call BEFORE any memory-count check. */
export function checkCheapGates(
  stateDir: string,
  config: DreamGateConfig,
): { proceed: boolean; reason?: string } {
  const minHours = config.minHours ?? DEFAULTS.minHours;
  const minSessions = config.minSessions ?? DEFAULTS.minSessions;
  const state = readState(stateDir);

  const hoursSince = (Date.now() - state.lastConsolidatedAt) / 3_600_000;
  if (hoursSince < minHours) {
    return { proceed: false, reason: `time: ${hoursSince.toFixed(1)}h < ${minHours}h` };
  }
  if (state.sessionsSince < minSessions) {
    return { proceed: false, reason: `sessions: ${state.sessionsSince} < ${minSessions}` };
  }
  return { proceed: true };
}

/** Expensive memory-count gate — only call after `checkCheapGates` passes. */
export function checkMemoryGate(
  memoryCount: number,
  config: DreamGateConfig,
): { pass: boolean; reason?: string } {
  const minMemories = config.minMemories ?? DEFAULTS.minMemories;
  if (memoryCount < minMemories) {
    return { pass: false, reason: `memories: ${memoryCount} < ${minMemories}` };
  }
  return { pass: true };
}

/** Acquire the exclusive dream lock. Stale locks (>1h old) are reclaimed. */
export function acquireDreamLock(stateDir: string): boolean {
  ensureDir(stateDir);
  const lp = lockPath(stateDir);
  try {
    const lock = JSON.parse(fs.readFileSync(lp, "utf-8")) as DreamLock;
    if (Date.now() - lock.startedAt < LOCK_STALE_MS) return false;
    try {
      fs.unlinkSync(lp);
    } catch {
      /* race: someone else already removed/replaced it */
    }
  } catch {
    /* no lock file, proceed */
  }
  try {
    fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      flag: "wx",
    });
    return true;
  } catch {
    return false; // lost the race
  }
}

export function releaseDreamLock(stateDir: string): void {
  try {
    fs.unlinkSync(lockPath(stateDir));
  } catch {
    /* already gone */
  }
}

export function recordDreamCompletion(stateDir: string): void {
  writeState(stateDir, { lastConsolidatedAt: Date.now(), sessionsSince: 0, lastSessionId: null });
}

export function getDreamState(stateDir: string): DreamState {
  return readState(stateDir);
}

/** A single consolidation mutation produced by the agent-driven dream skill
 * (merge/rewrite/summarize existing memories into fewer, denser ones). */
export interface DreamMutation {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Run a full gated dream-consolidation batch: cheap gates -> memory-count
 * gate -> exclusive lock -> `mutations.length` tagged `add()` calls -> ONE
 * `flush()` for the whole burst -> record completion -> release lock.
 * Fail-open: any error releases the lock and rethrows nothing (caller only
 * gets `{ ran: false, reason }`).
 */
export async function runDreamBatch(
  session: DmemoSession,
  userId: string,
  stateDir: string,
  mutations: DreamMutation[],
  config: DreamGateConfig,
): Promise<{ ran: boolean; reason?: string; count: number }> {
  const cheap = checkCheapGates(stateDir, config);
  if (!cheap.proceed) return { ran: false, reason: cheap.reason, count: 0 };

  let memoryCount = 0;
  try {
    const all = await session.memory.getAll({ filters: { user_id: userId } });
    memoryCount = Array.isArray((all as { results?: unknown[] }).results)
      ? (all as { results: unknown[] }).results.length
      : Array.isArray(all)
        ? (all as unknown[]).length
        : 0;
  } catch {
    // Non-fatal — treat as zero, gate will simply block.
  }
  const memGate = checkMemoryGate(memoryCount, config);
  if (!memGate.pass) return { ran: false, reason: memGate.reason, count: 0 };

  if (!acquireDreamLock(stateDir)) {
    return { ran: false, reason: "lock: consolidation already in progress", count: 0 };
  }

  try {
    for (const mutation of mutations) {
      await session.memory.add([{ role: "system", content: mutation.content }], {
        userId,
        infer: false,
        metadata: { ...mutation.metadata, source: "dream" },
      });
    }
    session.flush(); // single delta blob for the whole burst (D4/T3.3)
    recordDreamCompletion(stateDir);
    return { ran: true, count: mutations.length };
  } finally {
    releaseDreamLock(stateDir);
  }
}
