// dMemo OpenClaw plugin (T3.3). Forks `@mem0/openclaw-mem0`'s lifecycle
// shape (isolation scoping, deterministic before_prompt_build recall,
// agent_end capture, dream gate) but replaces:
//   - its OSS Memory init + OpenAI-by-default embedder/LLM (`providers.ts:247-326`)
//   - its `~/.mem0/vector_store.db` sqlite persistence (`providers.ts:329-392`)
// with `@dmemo/core`'s `DmemoSession` (D7 journaling wrapper + 0G Storage
// flush/restore). All mem0-Platform-only surfaces (MCP `mcp.mem0.ai`,
// project/entity/event APIs, categories) are stripped, not ported — this
// plugin only ever runs `mem0ai/oss` in-process, via `@dmemo/core`.
//
// Hard requirement (T3.3): the shipped DEFAULTS must never be able to call
// OpenAI. This holds structurally, not by convention:
//   - Embedder: `DmemoSession.open()` resolves a local embedder by default
//     (T1.5, `packages/core/src/embedder.ts`) — this plugin never passes an
//     OpenAI embedder config, and has no config knob that could produce one.
//   - LLM/inference: `session.memory.add()` is called with `infer: false`
//     UNCONDITIONALLY below (see `capture()` and `dream-gate.ts`'s
//     `runDreamBatch`) — see `config.ts`'s `infer` field doc for why this is
//     hardcoded rather than wired to the 0G Router today.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DmemoSession } from "@dmemo/core";
import { parseConfig, type DmemoOpenClawConfig } from "./config.js";
import {
  isNonInteractiveTrigger,
  isSubagentSession,
  effectiveUserId,
} from "./isolation.js";
import { incrementSessionCount, runDreamBatch, type DreamMutation } from "./dream-gate.js";
import { renderMemoryBlock, extractTurns, sanitizeQuery } from "./recall.js";

export const PLUGIN_ID = "dmemo";

/** Minimal surface of `DmemoSession` this plugin depends on — kept narrow
 * and structurally typed so unit tests can mock it without booting a real
 * session (no network, no 0G wallet). */
export interface DmemoSessionLike {
  memory: {
    search(query: string, opts: { filters?: Record<string, unknown>; topK?: number }): Promise<{
      results: Array<{ memory?: string; text?: string; score?: number }>;
    }>;
    add(
      messages: Array<{ role: string; content: string }>,
      opts: { userId: string; infer: boolean; metadata?: Record<string, unknown> },
    ): Promise<unknown>;
    getAll(opts: { filters?: Record<string, unknown> }): Promise<unknown>;
  };
  flush(): void;
  waitForPendingFlush(): Promise<void>;
  close(): Promise<void>;
}

export type SessionOpener = (cfg: DmemoOpenClawConfig) => Promise<DmemoSessionLike>;

const defaultOpener: SessionOpener = (cfg) =>
  DmemoSession.open({
    privateKey: cfg.privateKey,
    scope: cfg.scope,
    network: cfg.network,
  }) as unknown as Promise<DmemoSessionLike>;

function toolResult(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * Register the dMemo memory plugin against an OpenClaw plugin API instance.
 * `openSession` is overridable for tests (structural mock, no network).
 */
export function register(api: OpenClawPluginApi, openSession: SessionOpener = defaultOpener): void {
  const cfg = parseConfig(api.pluginConfig as Record<string, unknown>);
  const stateDir = cfg.dream.stateDir ?? api.resolvePath(".dmemo/dream");

  if (!cfg.privateKey) {
    api.logger.warn(
      "dmemo: no plugins.entries.dmemo.config.privateKey set — memory disabled (fail-open, no-op tools registered)",
    );
    registerFailOpenTools(api);
    return;
  }

  let sessionPromise: Promise<DmemoSessionLike> | null = null;
  const getSession = (): Promise<DmemoSessionLike> => {
    if (!sessionPromise) {
      sessionPromise = openSession(cfg).catch((err) => {
        sessionPromise = null; // allow a retry on the next call
        throw err;
      });
    }
    return sessionPromise;
  };

  const userIdFor = (sessionKey: string | undefined) => effectiveUserId(cfg.scope, sessionKey);

  async function recall(prompt: string | undefined, sessionKey: string | undefined): Promise<string | undefined> {
    const query = sanitizeQuery(prompt);
    if (!query) return undefined;
    const session = await getSession();
    const result = await session.memory.search(query, {
      filters: { user_id: userIdFor(sessionKey) },
      topK: cfg.recall.topK,
    });
    const block = renderMemoryBlock(result.results);
    return block.length > 0 ? block : undefined;
  }

  async function capture(
    messages: unknown[] | undefined,
    sessionKey: string | undefined,
  ): Promise<void> {
    const turns = extractTurns(messages);
    if (turns.length === 0) return;
    const session = await getSession();
    // infer is hardcoded false — see config.ts's `infer` field doc.
    await session.memory.add(turns, {
      userId: userIdFor(sessionKey),
      infer: false,
      metadata: { source: "capture" },
    });
    session.flush();
  }

  // ==========================================================================
  // before_prompt_build — deterministic recall (default "smart": long-term
  // search only, no session search — matches the fork's default strategy).
  // ==========================================================================
  api.on(
    "before_prompt_build",
    async (event, ctx) => {
      try {
        if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return;
        if (cfg.recall.strategy === "manual") return; // agent drives recall via memory_search only

        const e = event as { prompt?: string };
        const prependContext = await recall(e.prompt, ctx.sessionKey);
        if (!prependContext) return;
        return { prependContext };
      } catch (err) {
        api.logger.warn(`dmemo: before_prompt_build recall failed (fail-open): ${String(err)}`);
        return; // fail-open: never block the agent turn on a memory error
      }
    },
    { timeoutMs: cfg.recall.timeoutMs },
  );

  // ==========================================================================
  // agent_end — capture the finished turn. Subagents read the parent scope
  // (via effectiveUserId) on recall, but never write into it here.
  // ==========================================================================
  api.on("agent_end", async (event, ctx) => {
    try {
      if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return;
      if (isSubagentSession(ctx.sessionKey)) return; // subagents: skip capture

      const e = event as { messages?: unknown[]; success?: boolean };
      if (e.success === false) return;

      if (ctx.sessionKey) incrementSessionCount(stateDir, ctx.sessionKey);
      await capture(e.messages, ctx.sessionKey);
    } catch (err) {
      api.logger.warn(`dmemo: agent_end capture failed (fail-open): ${String(err)}`);
    }
  });

  // ==========================================================================
  // Own the memory slot (manifest declares `kind: "memory"`; the user opts
  // in via `plugins.slots.memory: "dmemo"`).
  // ==========================================================================
  if (typeof api.registerMemoryCapability === "function") {
    api.registerMemoryCapability({
      runtime: {
        search: (query: string, opts?: { sessionKey?: string; topK?: number }) =>
          getSession().then((session) =>
            session.memory.search(query, {
              filters: { user_id: userIdFor(opts?.sessionKey) },
              topK: opts?.topK ?? cfg.recall.topK,
            }),
          ),
      },
    });
  }

  registerTools(api, getSession, userIdFor, cfg);

  api.logger.info(
    `dmemo: registered (network: ${cfg.network}, scope: ${cfg.scope}, recall: ${cfg.recall.strategy}, infer: false [hardcoded])`,
  );

  // ==========================================================================
  // Dream consolidation — exposed as a tool the agent calls when it decides
  // (via its own skill/heuristics) that a consolidation pass is worthwhile.
  // Gated by checkCheapGates/checkMemoryGate/acquireDreamLock internally.
  // ==========================================================================
  if (cfg.dream.enabled) {
    api.registerTool(
      {
        name: "memory_dream",
        description:
          "Consolidate long-term memory: merge/rewrite/summarize prior memories into fewer, denser ones. Gated by time-since-last-run, session count, and memory count; skipped (fail-open) if a consolidation is already in progress or gates are not met. Every mutation is tagged source:\"dream\" and flushed as a single batch.",
        parameters: {
          type: "object",
          properties: {
            mutations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  metadata: { type: "object" },
                },
                required: ["content"],
              },
            },
          },
          required: ["mutations"],
        },
        execute: async (_toolCallId, params) => {
          try {
            const session = await getSession();
            const mutations = (params.mutations as DreamMutation[]) ?? [];
            const result = await runDreamBatch(
              session as unknown as DmemoSession,
              userIdFor(undefined),
              stateDir,
              mutations,
              cfg.dream,
            );
            return toolResult(JSON.stringify(result));
          } catch (err) {
            return toolResult(`dream consolidation failed (fail-open): ${String(err)}`);
          }
        },
      },
      { optional: true },
    );
  }
}

/** Two-tool convention (`research/openclaw.md` §5) every OpenClaw memory
 * backend registers so the agent can drive recall/reads explicitly
 * (needed outright for `recall.strategy === "manual"`, and useful alongside
 * deterministic auto-recall in "smart"/"always" modes too). */
function registerTools(
  api: OpenClawPluginApi,
  getSession: () => Promise<DmemoSessionLike>,
  userIdFor: (sessionKey: string | undefined) => string,
  cfg: DmemoOpenClawConfig,
): void {
  api.registerTool({
    name: "memory_search",
    description: "Search dMemo's long-term memory for relevant prior context.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        topK: { type: "number" },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, params) => {
      try {
        const session = await getSession();
        const query = String(params.query ?? "");
        const topK = typeof params.topK === "number" ? params.topK : cfg.recall.topK;
        const result = await session.memory.search(query, {
          filters: { user_id: userIdFor(undefined) },
          topK,
        });
        return toolResult(renderMemoryBlock(result.results) || "No relevant memories found.");
      } catch (err) {
        return toolResult(`memory_search failed (fail-open): ${String(err)}`);
      }
    },
  });

  api.registerTool({
    name: "memory_get",
    description: "Fetch all of dMemo's stored memories for the current scope.",
    parameters: { type: "object", properties: {} },
    execute: async (_toolCallId, _params) => {
      try {
        const session = await getSession();
        const all = await session.memory.getAll({ filters: { user_id: userIdFor(undefined) } });
        return toolResult(JSON.stringify(all));
      } catch (err) {
        return toolResult(`memory_get failed (fail-open): ${String(err)}`);
      }
    },
  });
}

/** No `privateKey` configured: still register the two tools (host expects
 * them since the manifest declares `kind: "memory"`), but every call
 * fails open with a clear message instead of throwing. */
function registerFailOpenTools(api: OpenClawPluginApi): void {
  const disabled = async () => toolResult("dMemo is not configured (missing privateKey) — memory disabled.");
  api.registerTool({
    name: "memory_search",
    description: "dMemo memory search (disabled: not configured).",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: disabled,
  });
  api.registerTool({
    name: "memory_get",
    description: "dMemo memory fetch (disabled: not configured).",
    parameters: { type: "object", properties: {} },
    execute: disabled,
  });
}

export default { id: PLUGIN_ID, name: "dMemo", register };
