#!/usr/bin/env node
// dMemo shim server for `mem0ai/memory-benchmarks` (T5.2).
//
// Exposes exactly the two routes the harness's `Mem0Client(mode="oss", ...)`
// talks to (verified live against the cloned harness source,
// `benchmarks/common/mem0_client.py`, July 2026 — see benchmarks/README.md
// for the exact citations, including the "limit" vs "top_k" wire-field
// correction):
//
//   POST /memories  {messages, user_id, timestamp?, metadata?, custom_instructions?}
//                    -> {results: [...]}
//                    (`timestamp` is accepted on the wire per the harness
//                    contract but NOT forwarded to mem0ai's OSS `add()` —
//                    the OSS SDK hard-throws on any defined `timestamp`,
//                    cloud-only feature gate; see inline note below. Stored
//                    instead as plain `metadata.locomoSessionTimestamp`.)
//   POST /search     {query, user_id, limit, rerank?}
//                    -> {results: [{memory, score, id, created_at?, updated_at?}]}
//                    (the harness client accepts either a bare array or a
//                    {results:[...]} envelope — see mem0_client.py's
//                    `data.get("results", data) if isinstance(data, dict) else data`)
//
// Backed by a single `DmemoSession` (one wallet = one flush chain, gotcha 18)
// shared across every LoCoMo `user_id` — mem0's own `user_id` filter
// partitions search results per conversation, so one dMemo session can hold
// all 10 LoCoMo conversations and one `flush()`/restore cycle covers all of
// them at once.
//
// This file is both an importable module (the T5.2 orchestrator swaps
// `state.session` in place after a flush/wipe/restore cycle, so the harness
// never needs to reconnect) and a standalone CLI shim
// (`node benchmarks/shim/server.mjs`) for ad-hoc/manual use.

import http from 'node:http';

/**
 * @param {{session: import('@dmemo/core').DmemoSession}} state mutable
 *   holder — swap `state.session` after restore; the handler always reads
 *   the current value per-request.
 */
export function createRequestListener(state) {
  return async function requestListener(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e) }));
      return;
    }

    try {
      if (req.url === '/memories') {
        const { messages, user_id, timestamp, metadata } = body;
        // NOTE (T5.2 live finding): mem0ai@3.1.1's OSS `Memory.add()` throws
        // "The timestamp parameter is not supported by the OSS Memory SDK."
        // for ANY defined value, including `null` (it checks `!== undefined`,
        // not truthiness — see mem0ai/dist/oss/index.js ~L16590). This is a
        // hard SDK-side feature gate (cloud-only), not something we can work
        // around without monkey-patching (ground rule 1 forbids that). The
        // harness always sends an epoch `timestamp` per LoCoMo session, so
        // forwarding it verbatim made every single /memories call fail.
        // We therefore never forward `timestamp` to add() — it is preserved
        // as plain metadata instead (harmless, no special SDK handling) so
        // it's still visible for debugging. This means retrieval is scored
        // against real wall-clock ingestion order, not the original LoCoMo
        // session dates — documented as a deviation in docs/benchmarks.md
        // (affects only the skipped --evaluate-only/temporal-reasoning path,
        // not the predict-only invariance test, which never uses timestamps).
        const r = await state.session.memory.add(messages, {
          userId: user_id,
          infer: false, // D17 — verbatim capture, never a silent second LLM call
          metadata: { ...(metadata ?? undefined), ...(timestamp != null ? { locomoSessionTimestamp: timestamp } : {}) },
        });
        respondJson(res, 200, { results: (r.results ?? []).map(normalizeItem) });
        return;
      }

      if (req.url === '/search') {
        const { query, user_id, limit, top_k, rerank } = body;
        const topK = limit ?? top_k ?? 200; // harness wire field is "limit" (verified from source), not "top_k"
        const r = await state.session.memory.search(query, {
          filters: { user_id },
          topK,
          rerank: !!rerank,
        });
        respondJson(res, 200, { results: (r.results ?? []).map(normalizeItem) });
        return;
      }

      // --- non-contract admin routes used only by the T5.2 orchestrator ---
      if (req.url === '/_dmemo/flush') {
        state.session.flush();
        await state.session.waitForPendingFlush();
        respondJson(res, 200, { flushLog: state.session.flushLog.at(-1) ?? null });
        return;
      }
      if (req.url === '/_dmemo/stats') {
        respondJson(res, 200, {
          restoreStats: state.session.restoreStats,
          flushLog: state.session.flushLog,
        });
        return;
      }

      res.writeHead(404).end();
    } catch (e) {
      console.error(`[shim] ${req.url} failed:`, e);
      respondJson(res, 500, { error: String((e && e.message) || e) });
    }
  };
}

function normalizeItem(item) {
  const out = { memory: item.memory, score: item.score ?? 0, id: item.id };
  if (item.createdAt) out.created_at = item.createdAt;
  if (item.updatedAt) out.updated_at = item.updatedAt;
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

export function startServer(state, port) {
  const server = http.createServer(createRequestListener(state));
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Standalone CLI entry: `node benchmarks/shim/server.mjs` — reads
// DMEMO_PRIVATE_KEY (+ optional DMEMO_NETWORK/DMEMO_RPC_URL/DMEMO_INDEXER_URL,
// PORT) from the environment and opens one long-lived session.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { DmemoSession } = await import('../../packages/core/dist/index.js');

  const privateKey = process.env.DMEMO_PRIVATE_KEY;
  if (!privateKey) {
    console.error('[shim] missing DMEMO_PRIVATE_KEY — refusing to start (never hardcode a key here)');
    process.exitCode = 1;
  } else {
    const port = Number(process.env.PORT ?? 8899);
    const session = await DmemoSession.open({
      privateKey,
      scope: process.env.DMEMO_SCOPE ?? 'locomo-benchmark',
      network: process.env.DMEMO_NETWORK ?? 'testnet',
      networkOverrides: {
        rpcUrl: process.env.DMEMO_RPC_URL,
        indexerUrl: process.env.DMEMO_INDEXER_URL,
      },
      embedder: { provider: 'fastembed', model: 'fast-bge-small-en-v1.5' },
      pointerCachePath: process.env.DMEMO_POINTER_CACHE_PATH,
    });
    const state = { session };
    await startServer(state, port);
    console.log(`[shim] listening on http://127.0.0.1:${port} (restored=${session.restoreStats.restored})`);
  }
}
