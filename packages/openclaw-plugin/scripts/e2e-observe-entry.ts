// E2E observation harness entry point (NOT shipped — local testing only).
//
// Wraps the real plugin without modifying it, using the two seams the
// plugin already exposes:
//   1. `register(api, openSession)` — the documented test seam; we pass a
//      real `DmemoSession` opener with every memory call instrumented.
//   2. The `api` object — delegated via `Object.create(api)` with `on()`
//      wrapped, so we can record what each hook was given and, crucially,
//      what `before_prompt_build` returned as `prependContext` (i.e. the
//      exact memory text injected into the model's prompt).
//
// Emits newline-delimited JSON to $DMEMO_OBSERVE_LOG. No key material is
// ever logged.
import * as fs from "node:fs";
import { DmemoSession } from "@dmemo/core";
import { register, PLUGIN_ID, type DmemoSessionLike } from "../src/index.js";
import type { DmemoOpenClawConfig } from "../src/config.js";

const LOG = process.env.DMEMO_OBSERVE_LOG ?? "";

function obs(event: string, data: Record<string, unknown> = {}): void {
  if (!LOG) return;
  try {
    fs.appendFileSync(
      LOG,
      JSON.stringify(
        { ts: new Date().toISOString(), pid: process.pid, event, ...data },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      ) + "\n",
    );
  } catch {
    /* observation must never break the host */
  }
}

function flushEntries(session: DmemoSession) {
  return session.flushLog.map((e) => ({
    kind: e.kind,
    seq: e.seq,
    rootHash: e.rootHash,
    bytes: e.bytes,
    uploadMs: Math.round(e.uploadMs),
    costWei: e.costWei.toString(),
  }));
}

const observedOpener = async (cfg: DmemoOpenClawConfig): Promise<DmemoSessionLike> => {
  obs("session.open.start", { scope: cfg.scope, network: cfg.network });
  const t0 = Date.now();
  let session: DmemoSession;
  try {
    session = await DmemoSession.open({
      privateKey: cfg.privateKey,
      scope: cfg.scope,
      network: cfg.network,
    });
  } catch (err) {
    obs("session.open.fail", { ms: Date.now() - t0, error: String(err) });
    throw err;
  }
  obs("session.open.ok", {
    ms: Date.now() - t0,
    scope: cfg.scope,
    restoreStats: session.restoreStats,
  });

  const mem = session.memory as DmemoSessionLike["memory"];
  let flushSeq = 0;

  return {
    memory: {
      async search(query, opts) {
        const t = Date.now();
        const r = await mem.search(query, opts);
        obs("memory.search", {
          ms: Date.now() - t,
          query,
          topK: opts?.topK,
          filters: opts?.filters,
          hitCount: r.results.length,
          hits: r.results.map((x) => ({ memory: x.memory ?? x.text, score: x.score })),
        });
        return r;
      },
      async add(messages, opts) {
        const t = Date.now();
        const r = await mem.add(messages, opts);
        obs("memory.add", {
          ms: Date.now() - t,
          userId: opts.userId,
          infer: opts.infer,
          turns: messages.map((m) => ({
            role: m.role,
            chars: m.content.length,
            preview: m.content.slice(0, 400),
          })),
          result: r,
        });
        return r;
      },
      getAll: (opts) => mem.getAll(opts),
    },
    flush() {
      const id = ++flushSeq;
      obs("flush.requested", { id, flushLogLen: session.flushLog.length });
      session.flush();
      void session
        .waitForPendingFlush()
        .then(() =>
          obs("flush.settled", {
            id,
            entries: flushEntries(session),
            droppedFlushCount: session.droppedFlushCount,
          }),
        )
        .catch((err) => obs("flush.error", { id, error: String(err) }));
    },
    async waitForPendingFlush() {
      await session.waitForPendingFlush();
      obs("flush.drained", { entries: flushEntries(session) });
    },
    async close() {
      obs("session.close.start", { entries: flushEntries(session) });
      await session.close();
      obs("session.close.ok", {});
    },
  };
};

/** Delegating wrapper: everything falls through to the real api except
 * `on`, whose handlers we instrument (input + returned prependContext). */
function observedApi<T extends object>(api: T): T {
  const proxied: any = Object.create(api);
  const realOn = (api as any).on.bind(api);
  proxied.on = (name: string, handler: any, opts?: unknown) =>
    realOn(
      name,
      async (event: any, ctx: any) => {
        const t0 = Date.now();
        obs(`hook.${name}.start`, {
          sessionKey: ctx?.sessionKey,
          trigger: ctx?.trigger,
          prompt: typeof event?.prompt === "string" ? event.prompt : undefined,
          messageCount: Array.isArray(event?.messages) ? event.messages.length : undefined,
          success: event?.success,
        });
        try {
          const res = await handler(event, ctx);
          obs(`hook.${name}.end`, {
            ms: Date.now() - t0,
            injectedPrependContext: res?.prependContext ?? null,
          });
          return res;
        } catch (err) {
          obs(`hook.${name}.error`, { ms: Date.now() - t0, error: String(err) });
          throw err;
        }
      },
      opts,
    );
  return proxied as T;
}

export default {
  id: PLUGIN_ID,
  name: "dMemo",
  register: (api: any) => {
    obs("plugin.register", {
      cwd: process.cwd(),
      hasEnvKey: Boolean(process.env.DMEMO_PRIVATE_KEY),
    });
    return register(observedApi(api), observedOpener);
  },
};
