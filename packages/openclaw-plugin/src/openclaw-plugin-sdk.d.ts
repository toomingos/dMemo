// Local ambient shim for the OpenClaw plugin SDK surface this package
// consumes. There is no publishable `openclaw` npm package to depend on
// (OpenClaw is not on the npm registry as of this writing — same situation
// the `@mem0/openclaw-mem0` fork base was in, see its own
// `openclaw-plugin-sdk.d.ts`). Shapes below were cross-checked field-by-field
// against the real host source, cloned at
// `.../scratchpad/repos/openclaw` (openclaw 2026.7.2, commit
// ca8610151af280492c23af992956968bc9427d03):
//   - `PluginHookBeforePromptBuildEvent`/`Result`: src/plugins/hook-before-agent-start.types.ts:22-42
//   - `PluginHookAgentEndEvent`: src/plugins/hook-types.ts:391-397
//   - `PluginHookAgentContext` (sessionKey/trigger/agentId): src/plugins/hook-types.ts:254-283
//   - `registerMemoryCapability` signature: src/plugins/plugin-api.types.ts:436-439
//   - `plugins.slots.memory` config: src/plugins/gateway-startup-plugin-config.ts:188
//   - hook `timeoutMs` semantics/defaults: docs/plugins/hooks.md:55-90 (per-hook
//     default timeout is the runner's generic default; `api.on(name, handler,
//     {timeoutMs})` sets a plugin-authored floor, overridable by host config
//     `plugins.entries.<id>.hooks.timeouts.<hookName>`).
declare module "openclaw/plugin-sdk" {
  export interface PluginHookAgentContext {
    runId?: string;
    jobId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    trigger?: string;
    [key: string]: unknown;
  }

  export interface PluginHookBeforePromptBuildEvent {
    prompt: string;
    messages: unknown[];
  }

  export interface PluginHookBeforePromptBuildResult {
    systemPrompt?: string;
    /** Dynamic, per-turn content — NOT cached. This is what recall uses. */
    prependContext?: string;
    appendContext?: string;
    /** Static content only — providers may cache this across turns. */
    prependSystemContext?: string;
    appendSystemContext?: string;
  }

  export interface PluginHookAgentEndEvent {
    runId?: string;
    messages: unknown[];
    success: boolean;
    error?: string;
    durationMs?: number;
  }

  export interface MemoryPluginCapability {
    runtime?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface PluginToolResult {
    content: Array<{ type: string; text: string }>;
    [key: string]: unknown;
  }

  export interface PluginToolDefinition {
    name: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<PluginToolResult>;
    [key: string]: unknown;
  }

  export interface OpenClawPluginApi {
    pluginConfig: Record<string, unknown>;
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
      debug(msg: string): void;
    };
    resolvePath(p: string): string;
    registerTool(
      definition: PluginToolDefinition,
      metadata?: { optional?: boolean; [key: string]: unknown },
    ): void;
    on<E = unknown, R = unknown>(
      event: string,
      handler: (event: E, ctx: PluginHookAgentContext) => Promise<R | void> | R | void,
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
    registerMemoryCapability?(capability: MemoryPluginCapability): void;
    [key: string]: unknown;
  }
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

  export interface PluginEntry {
    id: string;
    name: string;
    description?: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry<T extends PluginEntry>(entry: T): T;
}
