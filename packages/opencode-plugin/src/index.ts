import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { loadConfigFromEnv, MissingConfigError, type DmemoConfig } from '@dmemo/core';
import { realOpenSession, type DmemoSessionLike, type OpenSessionFn } from './types.js';
import { resolveUserId, resolveScope, generateSessionRunId } from './identity.js';
import { asScope, scopeSearchFilters, scopeWriteParams, SCOPE_GUIDANCE, type Identity } from './scope.js';
import { extractText, lastMessageOfRole, buildTurnText, redact, type MessagePartsLike } from './capture.js';
import { shouldTriggerCapture, totalTokens, type TokenUsage } from './compaction.js';

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
  assistantTurnCount: number;
  memoryCount: number;
  lastCaptureAtMs: number;
  capturedMessageIds: Set<string>;
  pendingContext: string[];
  modelLimitCache: Map<string, number>;
  lastUserText: Map<string, string>;
}

export interface DmemoPluginDeps {
  openSession?: OpenSessionFn;
  /** Injected for tests; defaults to real env-based config loading. */
  loadConfig?: (env?: NodeJS.ProcessEnv) => DmemoConfig;
}

/**
 * Build the plugin. Exported (not just default-exported) so tests can pass
 * a structural `DmemoSessionLike` mock and never touch the network, 0G
 * Storage, or the local embedder.
 */
export function createDmemoPlugin(deps: DmemoPluginDeps = {}): Plugin {
  const openSession = deps.openSession ?? realOpenSession;
  const loadConfig = deps.loadConfig ?? loadConfigFromEnv;

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

    const state: SessionState = {
      session,
      identity: { userId, sessionId: generateSessionRunId() },
      msgCount: 0,
      assistantTurnCount: 0,
      memoryCount: 0,
      lastCaptureAtMs: 0,
      capturedMessageIds: new Set(),
      pendingContext: [],
      modelLimitCache: new Map(),
      lastUserText: new Map(),
    };

    const infer = config.infer;

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

    /** Verbatim capture of one turn (dMemo default: `infer:false`, D17 —
     * no second LLM call). Deduped per assistant messageID so the cadence
     * path and the compaction-proactive path can't double-add the same turn. */
    async function captureTurn(sessionID: string, assistantMessageId: string | undefined, reason: string): Promise<void> {
      if (assistantMessageId) {
        if (state.capturedMessageIds.has(assistantMessageId)) return;
        state.capturedMessageIds.add(assistantMessageId);
      }
      const userText = state.lastUserText.get(sessionID) ?? '';
      let assistantText = '';
      try {
        const res: any = await ctx.client.session.messages({ path: { id: sessionID } });
        const messages: MessagePartsLike[] = (res?.data ?? res ?? []) as MessagePartsLike[];
        const last = lastMessageOfRole(messages, 'assistant');
        assistantText = extractText(last?.parts as any);
      } catch {
        // fail-open: capture whatever text we already have (user turn only)
      }
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

    async function maybeCaptureForCompaction(sessionID: string, tokens: TokenUsage | undefined, providerID: string | undefined, modelID: string | undefined, assistantMessageId: string | undefined): Promise<void> {
      if (!tokens) return;
      const limit = await resolveContextLimit(providerID, modelID);
      const trigger = shouldTriggerCapture({
        totalTokens: totalTokens(tokens),
        contextLimit: limit,
        lastCaptureAtMs: state.lastCaptureAtMs,
      });
      if (!trigger) return;
      state.lastCaptureAtMs = Date.now();
      await captureTurn(sessionID, assistantMessageId, 'compaction-proactive');
    }

    const hooks: Hooks = {
      dispose: async () => {
        try {
          await session.waitForPendingFlush();
          await session.close();
        } catch {
          // fail-open on teardown too
        }
      },

      'chat.message': async (input, output) => {
        const userText = extractText(output?.parts as any);
        if (!userText) return;
        state.msgCount++;
        state.lastUserText.set(input.sessionID, redact(userText));
        state.pendingContext = [];

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
            state.pendingContext.push(`## dMemo Memory Context\n\n${SCOPE_GUIDANCE}\n\n${lines}`);
          }
        } catch {
          // fail-open: no injected context this turn, conversation proceeds normally
        }
      },

      'experimental.chat.messages.transform': async (_input, output) => {
        if (state.pendingContext.length === 0 || !output?.messages?.length) return;
        const target = output.messages[output.messages.length - 1];
        if (!target || target.info.role !== 'user' || !target.parts) return;
        const block = state.pendingContext.join('\n\n');
        state.pendingContext = [];
        const ref: any = target.parts[0];
        target.parts.unshift({ ...ref, type: 'text', text: block });
      },

      event: async ({ event }) => {
        if (event.type === 'message.updated') {
          const info: any = event.properties.info;
          if (info.role !== 'assistant' || !info.finish) return;
          state.assistantTurnCount++;
          if (state.assistantTurnCount % 3 === 0) {
            await captureTurn(info.sessionID, info.id, 'cadence');
          }
          const tokens: TokenUsage | undefined = info.tokens
            ? {
                input: info.tokens.input ?? 0,
                output: info.tokens.output ?? 0,
                reasoning: info.tokens.reasoning ?? 0,
                cacheRead: info.tokens.cache?.read ?? 0,
                cacheWrite: info.tokens.cache?.write ?? 0,
              }
            : undefined;
          await maybeCaptureForCompaction(info.sessionID, tokens, info.providerID, info.modelID, info.id);
          return;
        }
        if (event.type === 'session.idle') {
          const sessionID = (event.properties as any)?.sessionID;
          if (!sessionID) return;
          try {
            const res: any = await ctx.client.session.messages({ path: { id: sessionID } });
            const messages: MessagePartsLike[] = (res?.data ?? res ?? []) as MessagePartsLike[];
            const lastAssistant: any = [...messages].reverse().find((m) => m.info.role === 'assistant');
            if (!lastAssistant) return;
            const info = lastAssistant.info;
            const tokens: TokenUsage | undefined = info.tokens
              ? {
                  input: info.tokens.input ?? 0,
                  output: info.tokens.output ?? 0,
                  reasoning: info.tokens.reasoning ?? 0,
                  cacheRead: info.tokens.cache?.read ?? 0,
                  cacheWrite: info.tokens.cache?.write ?? 0,
                }
              : undefined;
            await maybeCaptureForCompaction(sessionID, tokens, info.providerID, info.modelID, info.id);
          } catch {
            // fail-open: idle catch-up is best-effort
          }
        }
      },

      'experimental.session.compacting': async (input, output) => {
        // Preserve memory across compaction: capture whatever the cadence/
        // compaction-proactive paths haven't already captured for this
        // session, right before OpenCode compacts the transcript away.
        try {
          const res: any = await ctx.client.session.messages({ path: { id: input.sessionID } });
          const messages: MessagePartsLike[] = (res?.data ?? res ?? []) as MessagePartsLike[];
          const last: any = lastMessageOfRole(messages, 'assistant');
          if (last) await captureTurn(input.sessionID, last.info.id, 'pre-compaction');
        } catch {
          // fail-open
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

const Mem0DmemoPlugin: Plugin = createDmemoPlugin();
export default Mem0DmemoPlugin;
