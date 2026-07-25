import type { EmbedderIdentity } from '@dmemo/blob-spec';
import { internals } from './mem0Internal.js';

// T1.5 — local embedder auto-detection (D6). Order: explicit config ->
// Ollama (if reachable at localhost:11434) -> bundled fastembed ONNX.
// Remote embeddings (OpenAI, etc.) are never selected here — only ever used
// if the caller passes an explicit config, which is a conscious opt-in, not
// a silent default (privacy claim, T1.5).

export type EmbedderProvider = 'ollama' | 'fastembed' | (string & {});

export interface ExplicitEmbedderConfig {
  provider: EmbedderProvider;
  model?: string;
  /** Passed through verbatim to mem0's EmbeddingConfig for the chosen provider. */
  config?: Record<string, unknown>;
}

export interface ResolvedEmbedderConfig {
  provider: EmbedderProvider;
  model: string;
  /** The `{provider, config}` shape mem0's `MemoryConfig.embedder` slot expects. */
  mem0Config: { provider: string; config: Record<string, unknown> };
  /** How this config was chosen — surfaced for logging, never load-bearing. */
  source: 'explicit' | 'ollama-autodetect' | 'fastembed-fallback';
}

const OLLAMA_HOST = 'http://localhost:11434';
const OLLAMA_MODEL = 'nomic-embed-text';
const FASTEMBED_MODEL = 'fast-bge-small-en-v1.5';
const OLLAMA_PROBE_TIMEOUT_MS = 800;

async function isOllamaReachable(host: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve which embedder to use, following T1.5's auto-detect order.
 * Never throws on a missing Ollama server — that's the expected common
 * case, not an error; it just falls through to fastembed.
 */
export async function resolveEmbedderConfig(explicit?: ExplicitEmbedderConfig): Promise<ResolvedEmbedderConfig> {
  if (explicit) {
    return {
      provider: explicit.provider,
      model: explicit.model ?? '(provider default)',
      mem0Config: { provider: explicit.provider, config: { model: explicit.model, ...explicit.config } },
      source: 'explicit',
    };
  }

  const ollamaUp = await isOllamaReachable(OLLAMA_HOST, OLLAMA_PROBE_TIMEOUT_MS);
  if (ollamaUp) {
    return {
      provider: 'ollama',
      model: OLLAMA_MODEL,
      mem0Config: { provider: 'ollama', config: { model: OLLAMA_MODEL, url: OLLAMA_HOST } },
      source: 'ollama-autodetect',
    };
  }

  return {
    provider: 'fastembed',
    model: FASTEMBED_MODEL,
    mem0Config: { provider: 'fastembed', config: { model: FASTEMBED_MODEL } },
    source: 'fastembed-fallback',
  };
}

/** Probe-embed one short string through the live `Memory` instance to
 * determine the actual output dimension (mem0 already does this internally
 * at auto-init; we just need to read it back for the blob envelope). */
export async function getEmbedderIdentity(
  memory: object,
  provider: string,
  model: string
): Promise<EmbedderIdentity> {
  const vector = await internals(memory).embedder.embed('dmemo dimension probe');
  return { provider, model, dim: vector.length };
}

export function embedderIdentityEquals(a: EmbedderIdentity, b: EmbedderIdentity): boolean {
  return a.provider === b.provider && a.model === b.model && a.dim === b.dim;
}
