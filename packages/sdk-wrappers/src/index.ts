// @dmemo/sdk-wrappers public API surface (Phase 2, T2.1-T2.2).

// T2.1 — 0G Compute Router client preset.
export {
  createRouterClients,
  listPrivateModels,
  ROUTER_BASE_URLS,
  TESTNET_CHAT_MODEL,
} from './router.js';
export type {
  DmemoNetwork,
  RouterClientOptions,
  RouterClients,
  RouterModel,
  RouterTeeTrace,
  ListPrivateModelsOptions,
} from './router.js';

// T2.2 — SDK memory wrappers.
export { createOpenAIMemoryFetch, createAnthropicMemoryFetch } from './fetchWrap.js';
export type { FetchLike } from './fetchWrap.js';
export { createAnthropicMemoryMiddleware } from './anthropicMiddleware.js';
export type { DmemoMemorySession, MemorySearchResult, MemoryAddResult, MemoryWrapOptions } from './memorySession.js';

// Shared request/response shape helpers (useful for callers building custom
// injection/rendering logic).
export {
  renderMemoryBlock,
  extractOpenAIQuery,
  injectOpenAIMemory,
  extractOpenAICompletionText,
  extractAnthropicQuery,
  injectAnthropicMemory,
  extractAnthropicCompletionText,
  DEFAULT_TOP_K,
} from './inject.js';
export type { OpenAIChatBody, OpenAIChatMessage, AnthropicBody, AnthropicMessage } from './inject.js';

export {
  parseSSEJson,
  accumulateOpenAIStream,
  accumulateAnthropicStream,
  accumulateOpenAIEvents,
  accumulateAnthropicEvents,
} from './sse.js';
