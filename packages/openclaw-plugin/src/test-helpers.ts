// Shared test-only mocks — structural, no network, no real OpenClaw or
// @dmemo/core module loaded.
import type { DmemoSessionLike } from "./index.js";

// `parseConfig` falls back to the ambient `DMEMO_PRIVATE_KEY` env var and
// `~/.dmemo/config.json` so OpenClaw isn't the only host needing the key
// pasted into its own config. That fallback would otherwise make these
// tests machine-dependent: on a developer box that has actually run
// `dmemo setup`, the "no privateKey configured" fail-open case silently
// becomes a *configured* case and the assertion flips. Point DMEMO_HOME at
// a path that cannot exist and clear the env var, before any test body runs.
process.env.DMEMO_HOME = "/nonexistent/dmemo-home-for-tests";
delete process.env.DMEMO_PRIVATE_KEY;

export function makeMockSession(
  searchResults: Array<{ memory?: string; score?: number }> = [],
) {
  const addCalls: Array<{
    messages: Array<{ role: string; content: string }>;
    opts: { userId: string; infer: boolean; metadata?: Record<string, unknown> };
  }> = [];
  const searchCalls: Array<{ query: string; opts: unknown }> = [];
  let flushCalls = 0;

  const session: DmemoSessionLike = {
    memory: {
      async search(query, opts) {
        searchCalls.push({ query, opts });
        return { results: searchResults };
      },
      async add(messages, opts) {
        addCalls.push({ messages, opts });
        return { results: [] };
      },
      async getAll(_opts) {
        return { results: [] };
      },
    },
    flush() {
      flushCalls++;
    },
    async waitForPendingFlush() {},
    async close() {},
  };

  return {
    session,
    addCalls,
    searchCalls,
    get flushCalls() {
      return flushCalls;
    },
  };
}

interface RegisteredHook {
  event: string;
  handler: (event: unknown, ctx: unknown) => unknown;
  opts?: { timeoutMs?: number };
}
interface RegisteredTool {
  name: string;
  description: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

export function makeMockApi(pluginConfig: Record<string, unknown>) {
  const hooks: RegisteredHook[] = [];
  const tools: RegisteredTool[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  let memoryCapability: unknown;

  const api = {
    pluginConfig,
    logger: {
      info: (msg: string) => logs.push({ level: "info", msg }),
      warn: (msg: string) => logs.push({ level: "warn", msg }),
      error: (msg: string) => logs.push({ level: "error", msg }),
      debug: (msg: string) => logs.push({ level: "debug", msg }),
    },
    resolvePath: (p: string) => `/tmp/dmemo-test/${p}`,
    registerTool: (def: RegisteredTool) => {
      tools.push(def);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown, opts?: { timeoutMs?: number }) => {
      hooks.push({ event, handler, opts });
    },
    registerMemoryCapability: (capability: unknown) => {
      memoryCapability = capability;
    },
  };

  return {
    api: api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi,
    hooks,
    tools,
    logs,
    get memoryCapability() {
      return memoryCapability;
    },
    hookFor(event: string) {
      const h = hooks.find((h) => h.event === event);
      if (!h) throw new Error(`no hook registered for ${event}`);
      return h;
    },
    toolNamed(name: string) {
      const t = tools.find((t) => t.name === name);
      if (!t) throw new Error(`no tool registered named ${name}`);
      return t;
    },
  };
}
