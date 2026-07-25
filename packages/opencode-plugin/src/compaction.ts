// Compaction trigger math ported from `opencode-supermemory`'s
// `src/services/compaction.ts` (verified live: `DEFAULT_THRESHOLD = 0.80`
// at :13, `MIN_TOKENS_FOR_COMPACTION = 50_000` at :14,
// `COMPACTION_COOLDOWN_MS = 30_000` at :15 — the research doc's cited path
// `src/compaction.ts` had moved to `src/services/compaction.ts`; math
// unchanged). ONLY the math is ported — its file-writing wiring
// (`compaction.ts:169-235,406-410`, synthetic message/part files under
// `~/.opencode/`) is NOT: dMemo wires this onto the native
// `experimental.session.compacting` hook instead (`index.ts`).

export const COMPACTION_THRESHOLD_RATIO = 0.8;
export const COMPACTION_MIN_TOKENS = 50_000;
export const COMPACTION_COOLDOWN_MS = 30_000;

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite;
}

/**
 * Decide whether a proactive pre-compaction capture should fire right now.
 * Mirrors `checkAndTriggerCompaction` (`services/compaction.ts:329-373`):
 * cooldown gate first (cheapest), then the size gate, then the ratio gate.
 * `contextLimit` of `undefined` (model info not resolved yet) fails open
 * to "don't trigger" rather than throwing — this must never break the host.
 */
export function shouldTriggerCapture(params: {
  totalTokens: number;
  contextLimit: number | undefined;
  lastCaptureAtMs: number;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  if (now - params.lastCaptureAtMs < COMPACTION_COOLDOWN_MS) return false;
  if (params.totalTokens < COMPACTION_MIN_TOKENS) return false;
  if (!params.contextLimit || params.contextLimit <= 0) return false;
  return params.totalTokens / params.contextLimit >= COMPACTION_THRESHOLD_RATIO;
}
