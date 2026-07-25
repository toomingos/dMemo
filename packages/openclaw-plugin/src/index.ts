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
import nodeFs from "node:fs";
import nodePath from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DmemoSession, installGracefulShutdown } from "@dmemo/core";
import { parseConfig, type DmemoOpenClawConfig } from "./config.js";
import {
  isNonInteractiveTrigger,
  isSubagentSession,
  effectiveUserId,
} from "./isolation.js";
import { incrementSessionCount, runDreamBatch, type DreamMutation } from "./dream-gate.js";
import {
  renderMemoryBlock,
  extractTurns,
  sanitizeQuery,
  newMessagesSince,
  sanitizeTurns,
} from "./recall.js";

// ==========================================================================
// E1 capture-progress state — a tiny sibling of dream-gate.ts's own
// stateDir-backed JSON file, for the SAME reason: openclaw 2026.7.1-2's
// `agent_end` hook always hands back the full cumulative session transcript,
// never a delta (see recall.ts's `newMessagesSince` doc for the host-source
// citation), and the live e2e run showed a different `pid` per turn — so
// this cannot be an in-memory Map, it has to survive a process restart
// between turns. Kept separate from dream-gate.ts's own state file (that one
// tracks a single global consolidation clock, not per-session counts) and
// deliberately NOT added to that file, which is ported near-verbatim from
// the fork base (T3.3/D18) and out of scope here.
//
// O6 (researched, answer: NOT redundant — keep this state): checked whether
// mem0 offers any native dedup/idempotency on `add()` that would make this
// count-tracking unnecessary. It does not, for `infer: false`:
//   - Installed `mem0ai@3.1.1` OSS bundle
//     (`node_modules/.pnpm/mem0ai@3.1.1.../mem0ai/dist/oss/index.mjs`):
//     `addToVectorStore()` takes an early `if (!infer) { ...createMemory()
//     for every message... }` branch (~L16593-16610) that calls
//     `createMemory()` unconditionally per message. `createMemory()`
//     (~L17456-17475) always mints a fresh `uuidv4()` and calls
//     `vectorStore.insert()` with NO prior existence/hash check — the
//     hash-based dedup block (`existingHashes`/`seenHashes`, ~L16713-16726)
//     lives entirely inside the `infer: true` LLM-extraction branch and is
//     unreachable when `infer` is false. `AddMemoryOptions`
//     (`dist/oss/index.d.mts:592-599`) has no id/upsert/`memory_id` field —
//     there is no way to request an idempotent add.
//   - Confirmed against upstream docs via Context7 (`/mem0ai/mem0`,
//     `integrations/mem0-plugin/skills/mem0/SKILL.md`): "To avoid duplicate
//     memories, do not mix infer=True (default) and infer=False... infer=False
//     stores raw text, potentially leading to duplicates" — an explicit
//     upstream admission that infer:false has no dedup of its own.
//   - Checked the fork base this plugin descends from
//     (`mem0ai/mem0` GitHub, `integrations/openclaw/index.ts`): its
//     `agent_end` auto-capture handler (~L842-1056) never sets `infer` in
//     `buildAddOptions()` (~L283-299), so it defaults to `infer: true` and
//     leans entirely on mem0's LLM-based extraction/dedup pipeline for
//     "duplicates merged" — the exact mechanism D17/gotcha-3 rule out for
//     dMemo (no LLM call on this path, ever). `filtering.ts`'s
//     "deduplication" is pre-extraction noise-collapsing across one batch of
//     messages, not persistence-level dedup against prior stored memories.
// Conclusion: nothing native to adopt here. This hand-rolled progress count
// is the only thing preventing dMemo from re-storing the same turn on every
// `agent_end` resend (E1) — it is solving a different problem than
// content-level dedup anyway (which messages are NEW vs. already-seen, not
// "is this text a duplicate of stored text"), and no mem0-native mechanism
// covers even that. Do not re-open this without a version bump changelog
// entry showing mem0 added an infer:false-compatible dedup/upsert path.
// ==========================================================================
const CAPTURE_STATE_FILE = "capture-state.json";
/** Long-lived hosts must not grow this file forever; oldest tracked session
 * is evicted first once the cap is hit (same LRU-by-insertion-order shape as
 * `opencode-plugin/src/sessionTurns.ts`'s `MAX_TRACKED_SESSIONS`). */
const MAX_TRACKED_CAPTURE_SESSIONS = 256;

function captureStatePath(stateDir: string): string {
  return nodePath.join(stateDir, CAPTURE_STATE_FILE);
}

function readCaptureState(stateDir: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(nodeFs.readFileSync(captureStatePath(stateDir), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {}; // no file yet, or corrupt — treat as "nothing captured so far"
  }
}

function writeCaptureState(stateDir: string, state: Record<string, number>): void {
  try {
    nodeFs.mkdirSync(stateDir, { recursive: true });
    nodeFs.writeFileSync(captureStatePath(stateDir), JSON.stringify(state));
  } catch {
    // Fail-open: losing this write only means the next agent_end call
    // re-slices from a stale (or zero) count for this session — a
    // duplicate re-capture, never a thrown error and never lost content.
  }
}

/** Mutate `state` in place to record `sessionKey`'s new cumulative count and
 * persist it, evicting the oldest tracked session first past the cap. */
function updateCaptureState(
  stateDir: string,
  state: Record<string, number>,
  sessionKey: string,
  newCount: number,
): void {
  delete state[sessionKey]; // re-insert below so it becomes MRU by key order
  const keys = Object.keys(state);
  if (keys.length >= MAX_TRACKED_CAPTURE_SESSIONS) delete state[keys[0]!];
  state[sessionKey] = newCount;
  writeCaptureState(stateDir, state);
}

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

/** Parse `DMEMO_SHUTDOWN_TIMEOUT_MS`; anything unusable falls back to
 * `installGracefulShutdown`'s own default (undefined) rather than throwing —
 * config must never break the host. */
function parseShutdownTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** Returned by `register()` — see its doc comment. */
export interface RegisterHandle {
  /** Removes the SIGTERM/SIGINT/SIGHUP listeners this call installed (a
   * no-op if memory was never enabled). The real host's `PluginEntry.register`
   * is declared `void` and simply ignores this; it exists so tests (and any
   * future embedder that reloads the plugin without a process restart) can
   * remove the listeners `register()` installs on the real `process`. */
  uninstall: () => void;
  /** The exact flush/close path SIGTERM/SIGINT/SIGHUP run (fail-open; a
   * no-op if no session was ever opened). This host has no dispose/teardown
   * hook of its own (unlike the OpenCode plugin's `hooks.dispose`), so
   * signal delivery is otherwise the only path to this — exposed so tests
   * can exercise it directly instead of raising a real signal against the
   * test process. */
  dispose: () => Promise<void>;
}

/**
 * Register the dMemo memory plugin against an OpenClaw plugin API instance.
 * `openSession` is overridable for tests (structural mock, no network).
 */
export function register(api: OpenClawPluginApi, openSession: SessionOpener = defaultOpener): RegisterHandle {
  const cfg = parseConfig(api.pluginConfig as Record<string, unknown>);
  const stateDir = cfg.dream.stateDir ?? api.resolvePath(".dmemo/dream");

  if (!cfg.privateKey) {
    api.logger.warn(
      "dmemo: no plugins.entries.dmemo.config.privateKey set — memory disabled (fail-open, no-op tools registered)",
    );
    registerFailOpenTools(api);
    return { uninstall: () => {}, dispose: async () => {} }; // nothing was installed
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

  // F7: unlike the OpenCode plugin, this host's plugin-sdk shim has no
  // dispose/shutdown hook at all (checked field-by-field against the real
  // host source — see openclaw-plugin-sdk.d.ts's header), so SIGTERM/SIGINT
  // otherwise fall straight through to the OS default (terminate) and any
  // buffered-but-unflushed capture is lost. This is the only flush path this
  // host gets. Deliberately reads `sessionPromise` directly rather than
  // calling `getSession()` — a shutdown must never be what *opens* the
  // first session (nothing to flush yet in that case).
  let disposePromise: Promise<void> | undefined;
  function disposeSession(): Promise<void> {
    if (!disposePromise) {
      disposePromise = (async () => {
        if (!sessionPromise) return; // no session was ever opened — nothing to flush
        try {
          const session = await sessionPromise;
          await session.waitForPendingFlush();
          await session.close();
        } catch {
          // fail-open on teardown too, matching every other host's dispose contract
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
      api.logger.info(
        `dmemo: ${report.signal} received — flush ${report.timedOut ? "timed out, forcing exit" : "completed"}`,
      );
    },
  });

  const userIdFor = (sessionKey: string | undefined) => effectiveUserId(cfg.scope, sessionKey);

  // E2: the exact recall block `before_prompt_build` injected into a
  // session's NEXT prompt, remembered here for `capture()` to strip back off
  // before storage (host bakes it into the prompt text — see recall.ts's
  // `sanitizeCapturedText` doc for the citation). Same-turn/same-process
  // correlation only, so an in-memory Map is fine (unlike the E1 counter
  // above, this never needs to survive a process restart: recall and the
  // capture of that same turn happen in one before_prompt_build/agent_end
  // pair). `take*` drains+clears on read, mirroring `opencode-plugin/src/
  // sessionTurns.ts`'s `takePendingContext` — a stale block must never leak
  // into a LATER, unrelated turn's capture.
  //
  // O4 (closed as a non-issue, not a latent bug): it is STRUCTURALLY
  // impossible for one turn's before_prompt_build and agent_end to land in
  // different processes, verified against the installed host
  // (openclaw@2026.7.1-2, `~/.npm-global/lib/node_modules/openclaw/`), not
  // just the ambient .d.ts:
  //   1. Hook dispatch is always a same-process, direct JS function call —
  //      `runVoidHook`/`runModifyingHook` invoke `hook.handler(event, ctx)`
  //      straight from the registered closure; no IPC/serialization/worker
  //      boundary exists anywhere in that path
  //      (`dist/hook-runner-global-BmIrGlLG.js:458-514`).
  //   2. `docs/plugins/architecture.md:446`: "Native OpenClaw plugins run
  //      **in-process** with the Gateway... same process-level trust
  //      boundary as core code" — plugin closures (this Map included) live
  //      for the process's whole lifetime, not per-hook.
  //   3. Traced both agent-execution backends end-to-end: the embedded
  //      harness's `runEmbeddedAttempt` (`dist/selection-JInn13lc.js:11343`)
  //      calls `resolvePromptBuildHookResult` (before_prompt_build, :13660)
  //      then, via a plain sequential `await` later in that SAME enclosing
  //      function, `runAgentEndSideEffects` (agent_end, :14591). The
  //      CLI-backed harness's `runCliAgentInternal`
  //      (`dist/cli-runner-DE2P2Dy_.js:261`) shows the identical shape:
  //      `await prepareCliRunContext(params)` (:315, before_prompt_build)
  //      then `await runPreparedCliAgent(context)` (:341), which fires
  //      agent_end via `runCliAgentEndHook` (:743+) — one continuous async
  //      call stack, one process, for both hooks of a single turn.
  //   4. `docs/plugins/hooks.md:406-409` closes the remaining question (does
  //      a short-lived one-shot CLI process exit before agent_end runs?):
  //      "short-lived one-shot CLI paths wait for the hook promise before
  //      process cleanup" — the process that ran before_prompt_build is kept
  //      alive through agent_end before it's allowed to exit.
  // The E1 gotcha's "different pid per turn" observation is real but is an
  // ACROSS-turn phenomenon (one-shot CLI invocations, or Gateway worker
  // recycling, between turns) — it does not contradict same-process WITHIN
  // a turn, which is what this Map relies on. A content-based defence
  // (stripping `renderMemoryBlock()`'s shape from captured text without any
  // cross-hook memory) was considered and rejected: it would trade this
  // exact-match strip's zero false-positive rate for a heuristic one (a user
  // legitimately pasting text shaped like a memory block would get silently
  // eaten), for no correctness gain, since the gap it would close does not
  // exist. Do not re-add a state file for this without new evidence that
  // contradicts the citations above.
  const MAX_TRACKED_RECALL_SESSIONS = 64;
  const lastInjectedContext = new Map<string, string>();
  function rememberInjectedContext(sessionKey: string, block: string): void {
    lastInjectedContext.delete(sessionKey);
    lastInjectedContext.set(sessionKey, block);
    if (lastInjectedContext.size > MAX_TRACKED_RECALL_SESSIONS) {
      const oldest = lastInjectedContext.keys().next();
      if (!oldest.done) lastInjectedContext.delete(oldest.value);
    }
  }
  function takeInjectedContext(sessionKey: string): string | undefined {
    const block = lastInjectedContext.get(sessionKey);
    lastInjectedContext.delete(sessionKey);
    return block;
  }

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
    // E1: slice the host's full cumulative snapshot down to just the
    // messages appended since this session's last successful capture (see
    // recall.ts's `newMessagesSince` doc for why the host gives no delta).
    const state = sessionKey ? readCaptureState(stateDir) : {};
    const previousCount = sessionKey ? state[sessionKey] : undefined;
    const newRaw = newMessagesSince(messages, previousCount);
    const rawTurns = extractTurns(newRaw);

    // E2/E5: strip dMemo's own injected recall block and the host's
    // timestamp envelope back off before this is ever stored.
    const injected = sessionKey ? takeInjectedContext(sessionKey) : undefined;
    const turns = sanitizeTurns(rawTurns, injected);

    const totalCount = Array.isArray(messages) ? messages.length : undefined;
    const persistProgress = () => {
      // Only advance the persisted count once we've *seen* the full
      // snapshot; skip if it wasn't the array we expect (defensive, matches
      // extractTurns'/newMessagesSince's own Array.isArray guards).
      if (sessionKey && totalCount !== undefined) {
        updateCaptureState(stateDir, state, sessionKey, totalCount);
      }
    };

    if (turns.length === 0) {
      // Nothing capturable in the new slice (e.g. a tool-only exchange, or
      // a user turn that was purely the recall block re-issued). Still
      // advance progress — there is nothing to lose by not retrying a
      // segment that already yielded nothing.
      persistProgress();
      return;
    }

    const session = await getSession();
    // infer is hardcoded false — see config.ts's `infer` field doc.
    await session.memory.add(turns, {
      userId: userIdFor(sessionKey),
      infer: false,
      metadata: { source: "capture" },
    });
    // Persist progress only AFTER add() succeeds — if it throws, the catch
    // in the agent_end handler below fails open and this same slice is
    // retried next turn rather than silently dropped.
    persistProgress();
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
        // E2: remember exactly what we're about to inject so capture() can
        // strip it back off once the host bakes it into this session's next
        // prompt text.
        if (ctx.sessionKey) rememberInjectedContext(ctx.sessionKey, prependContext);
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

  return { uninstall: uninstallShutdown, dispose: disposeSession };
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
