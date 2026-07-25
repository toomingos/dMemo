import type { OpenSessionOptions } from '@dmemo/core';

/**
 * Structural subset of `DmemoSession` this plugin actually calls. Kept
 * narrow and dependency-free (no `mem0ai` types imported here — only
 * `@dmemo/core` depends on `mem0ai`, per the gotcha-3 eager-import trap)
 * so unit tests can pass a structural mock without touching the network,
 * 0G Storage, or the embedder.
 */
export interface DmemoSessionLike {
  readonly memory: {
    add(
      messages: string | Array<{ role: string; content: string }>,
      config: { userId?: string; agentId?: string; runId?: string; metadata?: Record<string, unknown>; infer?: boolean }
    ): Promise<{ results: Array<{ id: string; memory?: string }> }>;
    search(
      query: string,
      config: { topK?: number; filters?: Record<string, unknown> }
    ): Promise<{ results: Array<{ id: string; memory: string; score?: number }> }>;
  };
  flush(): void;
  waitForPendingFlush(): Promise<void>;
  close(): Promise<void>;
}

/** Factory seam for opening a session — swapped for a fake in unit tests. */
export type OpenSessionFn = (opts: OpenSessionOptions) => Promise<DmemoSessionLike>;

export const realOpenSession: OpenSessionFn = async (opts) => {
  const { DmemoSession: Session } = await import('@dmemo/core');
  const session = await Session.open(opts);
  return session as unknown as DmemoSessionLike;
};
