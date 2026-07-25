import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { loadDmemoConfig, MissingConfigError, installGracefulShutdown, type DmemoConfig } from '@dmemo/core';
import { realOpenSession, type DmemoSessionLike, type OpenSessionFn } from './types.js';
import { resolveUserId, resolveScope, generateSessionRunId } from './identity.js';
import { asScope, scopeSearchFilters, scopeWriteParams, SCOPE_GUIDANCE, type Identity } from './scope.js';
import { extractText, lastMessageOfRole, buildTurnText, redact, type MessagePartsLike } from './capture.js';
import { shouldTriggerCapture, totalTokens, type TokenUsage } from './compaction.js';
import { SessionTurnTracker, turnBoundarySessionID, parseCaptureEveryNTurns, transformMessagesSessionID } from './sessionTurns.js';

// dMemo OpenCode plugin (T3.2). Forked from
// `mem0/integrations/mem0-plugin/.opencode-plugin/opencode-mem0.ts` (D18).
//
// Kept unchanged in spirit from the fork base:
//   - every-turn injection via `chat.message` + native
//     `experimental.chat.messages.transform` (fork: `:630-886`)
//   - a manual memory tool surface for the agent
//   - deterministic capture cadence, independent of model-gated recall
// Replaced: `new MemoryClient({apiKey})` (fork `:279`) -> in-process
// `DmemoSession` (`@dmemo/core`).
// Stripped (mem0-Platform-only, `:139-173,580-626`): autoSetupCategories,
// delete_entities, list_entities, get_event_status. Also stripped: mem0
// Platform telemetry (`captureEvent` posts to mem0.ai), dream-consolidation
// gate, `/mem0-*` slash-command + skills-dir registration, categories
// fingerprinting — none are part of T3.2's scope and the telemetry call in
// particular would leak usage data off-device, which conflicts with
// dMemo's privacy design. See the final report for the full list.
// Rewritten: `resolveFilters`/`scope.ts` Platform `{AND:[...]}` REST DSL ->
// OSS `SearchFilters` (`scope.ts`).
// New: compaction wired onto the native `experimental.session.compacting`
// hook using `opencode-supermemory`'s trigger math (`compaction.ts`) —
// its file-writing wiring is deliberately not ported.

interface SessionState {
  session: DmemoSessionLike;
  identity: Identity;
  msgCount: number;
  memoryCount: number;
  modelLimitCache: Map<string, number>;
  /** Per-OpenCode-session turn counting, capture dedupe, cooldown clock,
   * last user prompt, AND queued memory-injection context (`pendingContext`
   * used to live here as a single shared array — a cross-session leak, since
   * one plugin instance serves every session on the server; see gotcha 27).
   * Replaces the global `assistantTurnCount` / `lastCaptureAtMs` /
   * `capturedMessageIds` / `lastUserText` (F5) and the global
   * `pendingContext` (this fix). */
  turns: SessionTurnTracker;
}

export interface DmemoPluginDeps {
  openSession?: OpenSessionFn;
  /** Injected for tests; defaults to `@dmemo/core`'s `loadDmemoConfig`
   * (env wins, falls back to `~/.dmemo/config.json` — F1: this plugin used
   * to call env-only `loadConfigFromEnv` directly and silently never saw a
   * config written by `dmemo setup`). */
  loadConfig?: (env?: NodeJS.ProcessEnv) => DmemoConfig;
}

/**
 * Build the plugin. Exported (not just default-exported) so tests can pass
 * a structural `DmemoSessionLike` mock and never touch the network, 0G
 * Storage, or the local embedder.
 */
export function createDmemoPlugin(deps: DmemoPluginDeps = {}): Plugin {
  const openSession = deps.openSession ?? realOpenSession;
  const loadConfig = deps.loadConfig ?? loadDmemoConfig;

  return async (ctx: PluginInput): Promise<Hooks> => {
    // Fail-open (D-common to all host adapters): no wallet/config -> no-op
    // plugin. Memory must never break the host.
    let config: DmemoConfig;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof MissingConfigError || err instanceof Error) {
        await safeLog(ctx, `dmemo: disabled (${err.message})`);
      }
      return {};
    }

    const userId = resolveUserId();
    const scope = resolveScope(userId, ctx.directory ?? ctx.worktree, process.env.DMEMO_OPENCODE_SCOPE);

    let session: DmemoSessionLike;
    try {
      session = await openSession({
        privateKey: config.privateKey,
        network: config.network,
        scope,
        embedder: config.embedder,
        checkpointEveryNFlushes: config.checkpointEveryNFlushes,
        checkpointSizeThresholdBytes: config.checkpointSizeThresholdBytes,
        uploadTimeoutMs: config.uploadTimeoutMs,
        pointerCachePath: config.pointerCachePath,
        networkOverrides: config.networkOverrides,
      });
    } catch (err) {
      await safeLog(ctx, `dmemo: failed to open session, disabling — ${(err as Error)?.message}`);
      return {};
    }

    const captureEveryNTurns = parseCaptureEveryNTurns(process.env.DMEMO_OPENCODE_CAPTURE_EVERY);

    const state: SessionState = {
      session,
      identity: { userId, sessionId: generateSessionRunId() },
      msgCount: 0,
      memoryCount: 0,
      modelLimitCache: new Map(),
      turns: new SessionTurnTracker(captureEveryNTurns),
    };

    const infer = config.infer;

    // OpenCode drops the promise returned by the `event` hook — it is
    // fire-and-forget (anomalyco/opencode#16879), and in `opencode run` mode
    // teardown can start while a capture is still in flight
    // (anomalyco/opencode#15267). Track them so `dispose` can drain them
    // before closing the session.
    const pendingCaptures = new Set<Promise<unknown>>();
    function tracked(work: Promise<unknown>): Promise<unknown> {
      pendingCaptures.add(work);
      void work.catch(() => {}).finally(() => pendingCaptures.delete(work));
      return work;
    }

    async function resolveContextLimit(providerID: string | undefined, modelID: string | undefined): Promise<number | undefined> {
      if (!providerID || !modelID) return undefined;
      const key = `${providerID}/${modelID}`;
      const cached = state.modelLimitCache.get(key);
      if (cached !== undefined) return cached;
      try {
        const res: any = await ctx.client.provider.list();
        const providers = res?.data?.all ?? [];
        const provider = providers.find((p: any) => p.id === providerID);
        const limit = provider?.models?.[modelID]?.limit?.context;
        if (typeof limit === 'number') {
          state.modelLimitCache.set(key, limit);
          return limit;
        }
      } catch {
        // fail-open: no ratio-gated capture this turn, cadence capture still works
      }
      return undefined;
    }

    /** Fetch a session's transcript and return its newest assistant message.
     * One call per turn boundary, shared by the cadence decision, the
     * compaction gate and the captured text — the old code re-fetched inside
     * every `captureTurn`. */
    async function lastAssistantTurn(
      sessionID: string
    ): Promise<{ info: any; text: string } | undefined> {
      try {
        const res: any = await ctx.client.session.messages({ path: { id: sessionID } });
        const messages: MessagePartsLike[] = (res?.data ?? res ?? []) as MessagePartsLike[];
        const last = lastMessageOfRole(messages, 'assistant');
        if (!last) return undefined;
        return { info: last.info as any, text: extractText(last.parts as any) };
      } catch {
        // fail-open: no capture this turn, conversation proceeds normally
        return undefined;
      }
    }

    /** Verbatim capture of one turn (dMemo default: `infer:false`, D17 —
     * no second LLM call). Deduped per (session, assistant messageID) so the
     * cadence, compaction-proactive and pre-compaction paths can't double-add
     * the same turn. */
    async function captureTurn(
      sessionID: string,
      assistantMessageId: string | undefined,
      reason: string,
      assistantText: string
    ): Promise<void> {
      if (assistantMessageId && !state.turns.claimCapture(sessionID, assistantMessageId)) return;
      const userText = state.turns.userText(sessionID);
      const text = buildTurnText(userText, assistantText);
      if (!text) return;
      try {
        const write = scopeWriteParams('project', state.identity);
        await session.memory.add(text, {
          userId: write.userId,
          runId: state.identity.sessionId,
          metadata: { source: 'opencode', capture_reason: reason },
          infer,
        });
        session.flush();
      } catch {
        // fail-open: a dropped capture must never break the host
      }
    }

    /** Context-pressure capture: fires off-cadence when the transcript is
     * close enough to the model's context window that compaction is
     * imminent. Cooldown is per-session, like the turn counter. */
    async function maybeCaptureForCompaction(sessionID: string, info: any, assistantText: string): Promise<void> {
      const tokens: TokenUsage | undefined = info?.tokens
        ? {
            input: info.tokens.input ?? 0,
            output: info.tokens.output ?? 0,
            reasoning: info.tokens.reasoning ?? 0,
            cacheRead: info.tokens.cache?.read ?? 0,
            cacheWrite: info.tokens.cache?.write ?? 0,
          }
        : undefined;
      if (!tokens) return;
      const limit = await resolveContextLimit(info.providerID, info.modelID);
      const trigger = shouldTriggerCapture({
        totalTokens: totalTokens(tokens),
        contextLimit: limit,
        lastCaptureAtMs: state.turns.lastCaptureAtMs(sessionID),
      });
      if (!trigger) return;
      state.turns.noteCaptureAt(sessionID, Date.now());
      await captureTurn(sessionID, info.id, 'compaction-proactive', assistantText);
    }

    /** One assistant turn has completed in `sessionID`. Called from the turn
     * boundary (session idle), never from a per-step event. */
    async function onTurnEnd(sessionID: string): Promise<void> {
      const turn = await lastAssistantTurn(sessionID);
      if (!turn?.info?.id) return;

      // Idempotent per assistant message: OpenCode publishes the boundary
      // under both `session.status`(idle) and the deprecated `session.idle`,
      // and an idle with no new reply must not advance the cadence either.
      const { shouldCapture } = state.turns.observeTurn(sessionID, turn.info.id);
      if (shouldCapture) {
        await captureTurn(sessionID, turn.info.id, 'cadence', turn.text);
        return;
      }
      await maybeCaptureForCompaction(sessionID, turn.info, turn.text);
    }

    // F7: OpenCode's own `dispose` hook only runs on a clean plugin
    // teardown — it is never reached on SIGTERM/SIGINT (e.g. a process
    // manager stopping the host, or a user Ctrl-C'ing `opencode run`), so an
    // unflushed capture is silently lost. `disposeSession` is the single
    // flush/close path, cached so both the normal `dispose` hook and a
    // caught signal run it at most once (idempotent — a second signal must
    // force-quit, not re-run the flush).
    let disposePromise: Promise<void> | undefined;
    function disposeSession(): Promise<void> {
      if (!disposePromise) {
        disposePromise = (async () => {
          try {
            // Drain captures still in flight before flushing — see the
            // `pendingCaptures` note above.
            await Promise.allSettled([...pendingCaptures]);
            await session.waitForPendingFlush();
            await session.close();
          } catch {
            // fail-open on teardown too
          }
        })();
      }
      return disposePromise;
    }

    const shutdownTimeoutMs = parseShutdownTimeoutMs(process.env.DMEMO_SHUTDOWN_TIMEOUT_MS);
    const uninstallShutdown = installGracefulShutdown({
      dispose: disposeSession,
      ...(shutdownTimeoutMs !== undefined ? { timeoutMs: shutdownTimeoutMs } : {}),
      onShutdown: (report) => {
        const dropped = (session as { droppedFlushCount?: number }).droppedFlushCount ?? 0;
        void safeLog(
          ctx,
          `dmemo: ${report.signal} received — flush ${report.timedOut ? 'timed out, forcing exit' : 'completed'}` +
            (dropped > 0 ? `; ${dropped} batch(es) previously dropped` : '')
        );
      },
    });

    const hooks: Hooks = {
      dispose: async () => {
        // A normal (non-signal) teardown: stop listening for signals so a
        // stale `disposeSession` can't fire again later, then run it.
        uninstallShutdown();
        await disposeSession();
      },

      'chat.message': async (input, output) => {
        const userText = extractText(output?.parts as any);
        if (!userText) return;
        state.msgCount++;
        state.turns.noteUserText(input.sessionID, redact(userText));
        // Per-session reset (not a shared array — F5's invariant 4, gotcha
        // 27): a global reset here would clear another in-flight session's
        // still-unconsumed context.
        state.turns.resetPendingContext(input.sessionID);

        if (state.memoryCount === 0 && state.msgCount === 1) {
          try {
            const all = await session.memory.search('recent decisions and context', {
              topK: 1,
              filters: scopeSearchFilters('project', state.identity),
            });
            state.memoryCount = all.results?.length ?? 0;
          } catch {
            // fail-open
          }
        }

        try {
          const res = await session.memory.search(userText, {
            topK: 5,
            filters: scopeSearchFilters('project', state.identity),
          });
          if (res.results.length > 0) {
            const lines = res.results.map((m) => `- ${m.memory}`).join('\n');
            state.turns.pushPendingContext(input.sessionID, `## dMemo Memory Context\n\n${SCOPE_GUIDANCE}\n\n${lines}`);
          }
        } catch {
          // fail-open: no injected context this turn, conversation proceeds normally
        }
      },

      'experimental.chat.messages.transform': async (_input, output) => {
        if (!output?.messages?.length) return;
        const target = output.messages[output.messages.length - 1];
        if (!target || target.info.role !== 'user' || !target.parts) return;

        // This hook's `input` carries no `sessionID` (one plugin instance
        // serves every session on the server — F5/gotcha 27), so the owning
        // session must be recovered from `output.messages[].info.sessionID`
        // itself. If it can't be determined unambiguously, drop the queued
        // context rather than risk injecting session A's memory into
        // session B's prompt: a missed injection degrades one answer, a
        // misdelivered one leaks another session's private memory.
        const sessionID = transformMessagesSessionID(output.messages);
        if (!sessionID) {
          await safeLog(ctx, 'dmemo: transform could not resolve an owning session — dropping any queued memory context');
          return;
        }

        const pending = state.turns.takePendingContext(sessionID);
        if (pending.length === 0) return;
        const block = pending.join('\n\n');
        const ref: any = target.parts[0];
        target.parts.unshift({ ...ref, type: 'text', text: block });
      },

      // Capture is driven off the TURN boundary (the session going idle), not
      // off `message.updated`. `message.updated` fires twice per assistant
      // message and once per tool step, so counting it never measured turns —
      // see `sessionTurns.ts` for the measurements behind this.
      event: async ({ event }) => {
        const sessionID = turnBoundarySessionID(event as any);
        if (!sessionID) return;
        await tracked(onTurnEnd(sessionID));
      },

      'experimental.session.compacting': async (input, output) => {
        // Preserve memory across compaction: capture whatever the cadence/
        // compaction-proactive paths haven't already captured for this
        // session, right before OpenCode compacts the transcript away.
        const turn = await lastAssistantTurn(input.sessionID);
        if (turn?.info?.id) {
          await captureTurn(input.sessionID, turn.info.id, 'pre-compaction', turn.text);
        }
        output.context.push(
          `dMemo has captured this session's context to persistent memory (scope="${scope}"). ` +
            'Use the dmemo_search tool to recall it after compaction if needed.'
        );
      },

      tool: {
        dmemo_search: tool({
          description:
            "Search dMemo's persistent memory by semantic meaning. Use proactively when the request may depend on past work, decisions, or preferences — relevant memories are not always auto-injected.",
          args: {
            query: tool.schema.string().describe('Search query'),
            scope: tool.schema.enum(['project', 'session']).optional().describe('project (default, everything remembered here) or session (this run only)'),
            top_k: tool.schema.number().optional().describe('Max results (default 5)'),
          },
          async execute(args) {
            const filters = scopeSearchFilters(asScope(args.scope), state.identity);
            const res = await session.memory.search(args.query, { topK: args.top_k ?? 5, filters });
            return JSON.stringify(res.results.map((r) => ({ id: r.id, memory: r.memory, score: r.score })));
          },
        }),
        dmemo_add: tool({
          description:
            'Store a memory verbatim (no LLM inference by default — dMemo captures exactly what you write). Use when the user asks to remember something or states a durable preference/decision.',
          args: {
            text: tool.schema.string().describe('Memory text content'),
            scope: tool.schema.enum(['project', 'session']).optional().describe('project (default) or session'),
          },
          async execute(args) {
            const write = scopeWriteParams(asScope(args.scope), state.identity);
            const res = await session.memory.add(redact(args.text), {
              userId: write.userId,
              runId: write.runId,
              metadata: { source: 'opencode', capture_reason: 'manual' },
              infer,
            });
            session.flush();
            return JSON.stringify(res);
          },
        }),
      },
    };

    return hooks;
  };
}

async function safeLog(ctx: PluginInput, message: string): Promise<void> {
  try {
    await ctx.client.app.log({ body: { service: 'dmemo', level: 'info', message } });
  } catch {
    // best-effort; stdout/stderr would pollute the TUI, so just drop it
  }
}

/** Parse `DMEMO_SHUTDOWN_TIMEOUT_MS`; anything unusable falls back to
 * `installGracefulShutdown`'s own default (undefined) rather than throwing —
 * config must never break the host. */
function parseShutdownTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

const Mem0DmemoPlugin: Plugin = createDmemoPlugin();
export default Mem0DmemoPlugin;
