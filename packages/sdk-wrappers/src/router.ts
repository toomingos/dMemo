// T2.1 — 0G Compute Router client preset.
//
// Factory that returns pre-configured `openai` and `@anthropic-ai/sdk`
// clients pointed at the 0G Router, plus a zero-auth helper to list
// TeeML ("private inference") models. Per TASKS.md Ground rule 1: no
// retry/failover/provider-pool logic here (the Router already does that),
// no `@0glabs/0g-serving-broker` (deprecated), no direct-SDK
// (`@0gfoundation/0g-compute-ts-sdk`) path — that is out of scope for v1.

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

/** Only `testnet` is safe to call from this codebase (Global constants /
 * Ground rules: "NEVER call mainnet"). `mainnet` is accepted in the type so
 * callers deploying dMemo themselves can opt in explicitly, but nothing in
 * this repo's tests or scripts may pass it. */
export type DmemoNetwork = 'testnet' | 'mainnet';

/** Router base URLs, live-verified July 2026 (TASKS.md "Global constants"). */
export const ROUTER_BASE_URLS: Record<DmemoNetwork, string> = {
  testnet: 'https://router-api-testnet.integratenetwork.work/v1',
  mainnet: 'https://router-api.0g.ai/v1',
};

/** The only chat model available on the Router testnet deployment
 * (TASKS.md "Global constants"). Claude models are mainnet-only. */
export const TESTNET_CHAT_MODEL = 'qwen/qwen2.5-omni-7b';

export interface RouterTeeTrace {
  tee_verified?: boolean;
  [key: string]: unknown;
}

export interface RouterClientOptions {
  /** Defaults to `DMEMO_NETWORK` env var, else `'testnet'`. */
  network?: DmemoNetwork;
  /** Router API key (`sk-...`). Defaults to `ZEROG_API_KEY` env var. May be
   * omitted entirely — `createRouterClients()` still returns usable clients
   * (D11: the memory leg must work with zero Router key; only the
   * inference leg needs one, and only at call time). */
  apiKey?: string;
  /** `X-0G-Provider-Trust-Mode` header value. Default `'private'`
   * (TeeML-only routing — this is what makes "private inference" true;
   * `0g-compute.md` §b). Pass `undefined`/`false` to omit the header
   * entirely. */
  trustMode?: 'private' | string | false;
  /** When true, every outgoing JSON request body gets `verify_tee: true`
   * injected (Router feature: ask the provider to return a TEE attestation
   * trace on the response). Default false. */
  verifyTee?: boolean;
  /** Called whenever a response carries an `x_0g_trace` field, most usefully
   * when `verifyTee` is set. Default: `console.log`s
   * `x_0g_trace.tee_verified`. Pass a no-op to silence. */
  onTeeTrace?: (trace: RouterTeeTrace, meta: { url: string }) => void;
  /** Underlying fetch implementation (tests can inject a mock). Defaults to
   * the ambient global `fetch`. */
  fetch?: typeof fetch;
}

export interface RouterClients {
  openai: OpenAI;
  anthropic: Anthropic;
  network: DmemoNetwork;
  baseURL: string;
}

function defaultTeeTraceLogger(trace: RouterTeeTrace, meta: { url: string }): void {
  console.log(`[dmemo/sdk-wrappers] x_0g_trace.tee_verified=${trace.tee_verified} (${meta.url})`);
}

function resolveNetwork(explicit?: DmemoNetwork): DmemoNetwork {
  const fromEnv = (explicit ?? (process.env.DMEMO_NETWORK as DmemoNetwork | undefined) ?? 'testnet');
  if (fromEnv !== 'testnet' && fromEnv !== 'mainnet') {
    throw new Error(`Invalid network "${fromEnv}" — expected "testnet" or "mainnet".`);
  }
  return fromEnv;
}

/** Wrap a `fetch` implementation so it (a) injects `verify_tee: true` into
 * JSON request bodies when configured, and (b) peeks the response for an
 * `x_0g_trace` field and reports it via `onTeeTrace`, without consuming the
 * body the caller (the SDK) still needs to read. Native mechanism only: this
 * is exactly the "custom fetch client option" extension point both SDKs
 * document — no monkey-patching, no subclassing. */
function buildRouterFetch(opts: {
  baseFetch: typeof fetch;
  verifyTee: boolean;
  onTeeTrace: (trace: RouterTeeTrace, meta: { url: string }) => void;
}): typeof fetch {
  const { baseFetch, verifyTee, onTeeTrace } = opts;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let finalInit = init;
    if (verifyTee && init?.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          finalInit = { ...init, body: JSON.stringify({ ...parsed, verify_tee: true }) };
        }
      } catch {
        // Non-JSON body (unlikely for these SDKs) — pass through untouched.
      }
    }

    const response = await baseFetch(input, finalInit);

    // Peek for the TEE trace without disturbing the body the SDK will read.
    if (response.ok) {
      response
        .clone()
        .json()
        .then((json: unknown) => {
          if (json && typeof json === 'object' && 'x_0g_trace' in json) {
            const trace = (json as { x_0g_trace: RouterTeeTrace }).x_0g_trace;
            const url = typeof input === 'string' ? input : input.toString();
            onTeeTrace(trace, { url });
          }
        })
        .catch(() => {
          // Not JSON (e.g. an SSE stream) or already consumed — nothing to
          // report; the real response is untouched either way.
        });
    }

    return response;
  }) as typeof fetch;
}

/** Build configured `openai` and `@anthropic-ai/sdk` clients pointed at the
 * 0G Compute Router for the given network. Safe to call with no `apiKey` —
 * the clients are still constructed (D11); calls made through them will
 * simply fail with the SDK's normal auth error until a key is supplied. */
export function createRouterClients(opts: RouterClientOptions = {}): RouterClients {
  const network = resolveNetwork(opts.network);
  const baseURL = ROUTER_BASE_URLS[network];
  const apiKey = opts.apiKey ?? process.env.ZEROG_API_KEY;
  const trustMode = opts.trustMode === undefined ? 'private' : opts.trustMode;
  const baseFetch = opts.fetch ?? fetch;
  const routerFetch = buildRouterFetch({
    baseFetch,
    verifyTee: opts.verifyTee ?? false,
    onTeeTrace: opts.onTeeTrace ?? defaultTeeTraceLogger,
  });

  const defaultHeaders: Record<string, string> = {};
  if (trustMode) defaultHeaders['X-0G-Provider-Trust-Mode'] = trustMode;

  const openai = new OpenAI({
    baseURL,
    apiKey: apiKey ?? 'dmemo-no-router-key-set',
    defaultHeaders,
    fetch: routerFetch,
  });

  const anthropic = new Anthropic({
    baseURL,
    // The Router documents "OpenAI convention" Bearer auth
    // (`Authorization: Bearer sk-...`, TASKS.md T2.1) rather than
    // Anthropic's usual `x-api-key` header. The Anthropic SDK's `authToken`
    // option (as opposed to `apiKey`) is what produces a Bearer
    // `Authorization` header — see client.d.ts: "Bearer token auth on every
    // request."
    authToken: apiKey ?? 'dmemo-no-router-key-set',
    defaultHeaders,
    fetch: routerFetch,
  });

  return { openai, anthropic, network, baseURL };
}

export interface RouterModel {
  id: string;
  verifiability?: string;
  supported_formats?: string[];
  [key: string]: unknown;
}

export interface ListPrivateModelsOptions {
  network?: DmemoNetwork;
  fetch?: typeof fetch;
}

/** `GET {router}/v1/models` (no auth) filtered to `verifiability ===
 * "TeeML"` — the "private inference" model list (TASKS.md T2.1). */
export async function listPrivateModels(opts: ListPrivateModelsOptions = {}): Promise<RouterModel[]> {
  const network = resolveNetwork(opts.network);
  const baseURL = ROUTER_BASE_URLS[network];
  const doFetch = opts.fetch ?? fetch;

  const res = await doFetch(`${baseURL}/models`);
  if (!res.ok) {
    throw new Error(`GET ${baseURL}/models -> HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: RouterModel[]; models?: RouterModel[] };
  const all = json.data ?? json.models ?? [];
  return all.filter((m) => m.verifiability === 'TeeML');
}
