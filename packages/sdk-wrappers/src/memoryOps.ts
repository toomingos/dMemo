// Shared search/write-back logic used by both write-back mechanisms
// (`fetchWrap.ts`'s custom-fetch path and `anthropicMiddleware.ts`'s native
// Anthropic middleware path) so the two stay in lock-step.

import { DEFAULT_TOP_K, renderMemoryBlock } from './inject.js';
import { defaultOnError, type DmemoMemorySession, type MemoryWrapOptions } from './memorySession.js';

export type ErrorStage = 'search' | 'inject' | 'writeback' | 'parse';
export type OnError = (stage: ErrorStage, error: unknown) => void;

export function resolveOnError(opts: MemoryWrapOptions): OnError {
  return opts.onError ?? defaultOnError;
}

export function resolveFailOpen(opts: MemoryWrapOptions): boolean {
  return opts.failOpen ?? true;
}

export async function searchMemoryBlock(
  session: DmemoMemorySession,
  query: string,
  opts: MemoryWrapOptions
): Promise<string> {
  const result = await session.memory.search(query, {
    filters: opts.userId ? { user_id: opts.userId } : undefined,
    topK: opts.topK ?? DEFAULT_TOP_K,
  });
  const render = opts.renderMemory ?? renderMemoryBlock;
  return render(result.results);
}

/** Fire-and-forget (D4): `session.memory.add()` the exchange, then
 * `session.flush()` — never awaited by callers of this function. */
export function writeBackMemory(
  session: DmemoMemorySession,
  opts: MemoryWrapOptions,
  onError: OnError,
  userText: string | undefined,
  assistantText: string | undefined
): void {
  if (!assistantText) return;
  const turns: Array<{ role: string; content: string }> = [];
  if (userText) turns.push({ role: 'user', content: userText });
  turns.push({ role: 'assistant', content: assistantText });

  session.memory
    .add(turns, { userId: opts.userId, infer: false })
    .then(() => session.flush())
    .catch((error) => onError('writeback', error));
}
