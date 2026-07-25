// Per-agent memory isolation. Ported near-verbatim (KEEP, per T3.3/D18) from
// `@mem0/openclaw-mem0`'s `isolation.ts:17-107` — multi-agent setups
// read/write separate scoped namespaces derived from the OpenClaw session
// key, subagents read the parent's scope but never capture into it.

/** Non-interactive trigger kinds whose turns must never pollute memory. */
const SKIP_TRIGGERS = new Set(["cron", "heartbeat", "automation", "schedule"]);

/** True if the session trigger (or session-key shape) indicates a
 * system-initiated, non-interactive run that recall/capture must skip. */
export function isNonInteractiveTrigger(
  trigger: string | undefined,
  sessionKey: string | undefined,
): boolean {
  if (trigger && SKIP_TRIGGERS.has(trigger.toLowerCase())) return true;
  if (sessionKey) {
    if (/:cron:/i.test(sessionKey) || /:heartbeat:/i.test(sessionKey)) return true;
  }
  return false;
}

/** True if the session key identifies an ephemeral subagent session. */
export function isSubagentSession(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  return /:subagent:/i.test(sessionKey);
}

/**
 * Parse an agent id out of an OpenClaw session key.
 *   "agent:main:main"                  -> undefined (primary session)
 *   "agent:main:subagent:<uuid>"       -> "subagent-<uuid>"
 *   "agent:<agentId>:<session>"        -> agentId
 */
export function extractAgentId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;

  const subagentMatch = sessionKey.match(/:subagent:([^:]+)$/);
  if (subagentMatch?.[1]) return `subagent-${subagentMatch[1]}`;

  const match = sessionKey.match(/^agent:([^:]+):/);
  const agentId = match?.[1];
  if (!agentId || agentId === "main") return undefined;
  return agentId;
}

/** Derive the effective mem0 `user_id` (scope namespace) for a session key.
 * Subagents recall from the PARENT's namespace (no `:agent:` suffix is
 * added for them here) — callers must combine this with `isSubagentSession`
 * to decide whether to also skip capture. */
export function effectiveUserId(baseUserId: string, sessionKey?: string): string {
  if (isSubagentSession(sessionKey)) return baseUserId; // read parent scope
  const agentId = extractAgentId(sessionKey);
  return agentId ? `${baseUserId}:agent:${agentId}` : baseUserId;
}

/** Build a user_id for an explicit agentId (e.g. from a tool call param). */
export function agentUserId(baseUserId: string, agentId: string): string {
  return `${baseUserId}:agent:${agentId}`;
}

/** Resolve user_id with priority: explicit agentId > explicit userId > session-derived > configured base. */
export function resolveUserId(
  baseUserId: string,
  opts: { agentId?: string; userId?: string },
  sessionKey?: string,
): string {
  if (opts.agentId) return agentUserId(baseUserId, opts.agentId);
  if (opts.userId) return opts.userId;
  return effectiveUserId(baseUserId, sessionKey);
}
