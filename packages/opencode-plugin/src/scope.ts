// Rewrite of the fork base's `resolveFilters`/`scope.ts` (Platform REST
// `{AND:[{user_id},{app_id}]}` DSL) for mem0-OSS's flat `SearchFilters`
// shape (`{user_id?, agent_id?, run_id?}` — see `mem0ai/oss` `Entity` /
// `SearchFilters`). dMemo isolates *across* projects at the DmemoSession
// layer (one 0G-backed flush chain per `scope` string, opened once at
// plugin init — see `session.ts`), so there is no "global" cross-scope
// search here: that would mean opening a second chain, out of scope for
// this adapter. Within a single opened scope, `run_id` narrows a search to
// the current OpenCode session only ("session" scope); the default
// ("project") searches the whole opened scope.

export type MemoryScope = 'project' | 'session';

export function asScope(value: unknown): MemoryScope {
  return value === 'session' ? 'session' : 'project';
}

export interface Identity {
  userId: string;
  sessionId: string;
}

/** Read-side filters for `memory.search`/`memory.getAll` (OSS `SearchFilters`). */
export function scopeSearchFilters(scope: MemoryScope, identity: Identity): Record<string, unknown> {
  const filters: Record<string, unknown> = { user_id: identity.userId };
  if (scope === 'session') filters.run_id = identity.sessionId;
  return filters;
}

/** Write-side identity for `memory.add` (OSS `Entity`: camelCase). */
export function scopeWriteParams(scope: MemoryScope, identity: Identity): { userId: string; runId?: string } {
  const params: { userId: string; runId?: string } = { userId: identity.userId };
  if (scope === 'session') params.runId = identity.sessionId;
  return params;
}

export const SCOPE_GUIDANCE =
  'Memory scope: "project" (default) searches everything remembered for this project; ' +
  '"session" restricts to memories captured during this OpenCode run.';
