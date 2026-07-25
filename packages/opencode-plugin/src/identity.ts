import { basename } from 'node:path';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';

/** OS user name, falling back to a stable placeholder rather than throwing
 * (fail-open — identity resolution must never break plugin load). */
export function resolveUserId(): string {
  try {
    return userInfo().username || 'dmemo-user';
  } catch {
    return 'dmemo-user';
  }
}

/** One dMemo flush-chain scope per (user, project) — mirrors the fork
 * base's `app_id` (project) concept, but as the actual chain-selector
 * string DmemoSession.open() takes (D18: dMemo isolates scopes by opening
 * a distinct chain, not via a Platform `app_id` filter). Derived from the
 * worktree/project directory name; callers may override via
 * `DMEMO_OPENCODE_SCOPE` for monorepos where the directory name collides. */
export function resolveScope(userId: string, directory: string | undefined, override: string | undefined): string {
  if (override) return `opencode:${override}`;
  const project = directory ? basename(directory) : 'default';
  return `opencode:${userId}:${project}`;
}

export function generateSessionRunId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
