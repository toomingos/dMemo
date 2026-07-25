// @dmemo/core public API surface (Phase 1, T1.1-T1.7).

export { DmemoSession } from './session.js';
export type { OpenSessionOptions, FlushLogEntry, RestoreStats } from './session.js';

export { StorageClient, UploadTimeoutError, MerkleVerifyError } from './storage/client.js';
export type { StorageClientOptions, UploadResult, ResolvedPointer } from './storage/client.js';

export { resolveNetworkConfig, BLOCK_RANGE_CAP } from './storage/network.js';
export type { NetworkName, NetworkConfig, NetworkOverrides } from './storage/network.js';

export {
  defaultPointerCachePath,
  getPointerCacheEntry,
  savePointerCacheEntry,
} from './storage/pointerCache.js';
export type { PointerCacheEntry } from './storage/pointerCache.js';

export { JournalingVectorStore } from './store/journal.js';

export {
  resolveEmbedderConfig,
  getEmbedderIdentity,
  embedderIdentityEquals,
} from './embedder.js';
export type { ExplicitEmbedderConfig, ResolvedEmbedderConfig, EmbedderProvider } from './embedder.js';

export {
  loadConfigFromEnv,
  loadDmemoConfig,
  MissingConfigError,
  ConfigNotFoundError,
  dmemoHome,
  dmemoConfigPath,
  readDmemoConfigFile,
} from './config.js';
export type { DmemoConfig, EnvSource } from './config.js';

export { deriveEpochKey, forget } from './forget.js';
export type { ForgetOptions, ForgetResult } from './forget.js';

export { ensureBetterSqlite3Compat } from './runtime/bunSqliteCompat.js';
export type { BunSqliteCompatResult } from './runtime/bunSqliteCompat.js';

export { internals } from './mem0Internal.js';
export type { MemoryInternals, HistoryBackedManager } from './mem0Internal.js';

// Re-export the blob spec so consumers don't need a separate dependency
// just to decode/inspect a blob they downloaded themselves.
export * from '@dmemo/blob-spec';
