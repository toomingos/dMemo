#!/usr/bin/env node
// c4-streaming.mjs — validates the two supported "capture a chat completion
// stream" patterns from research/sdks.md section 3, using the installed
// openai SDK (v6.49.0) native primitives only:
//
//   (A) Stream.tee() branch-drain — for when dMemo does NOT own the call
//       site: tee the host application's own Stream<ChatCompletionChunk>
//       and manually accumulate delta.content on the side branch, without
//       interfering with the host's own consumption of the other branch.
//
//   (B) client.chat.completions.stream() + finalChatCompletion() — for when
//       dMemo DOES own the call site: use the SDK's own ChatCompletionStream
//       helper and let it accumulate the final completion for you.
//
// Both are exercised against the SAME underlying SSE byte stream and must
// assemble byte-identical final text.
//
// Router testnet check: TASKS.md's global constants list the 0G Router
// testnet at https://router-api-testnet.integratenetwork.work/v1 (only
// chat model: qwen/qwen2.5-omni-7b). spike/.env has no ZEROG_API_KEY or
// ROUTER_API_KEY, so per instructions this script runs the comparison in
// UNFUNDED MODE against a locally-synthesized mock SSE stream and does NOT
// invent a key or call any live endpoint (testnet or mainnet). The live-path
// function below is wired up and will run automatically the moment a key is
// present in .env, but is currently marked SKIPPED — this is a pending item
// for whoever owns a Router testnet key, not a design gap.

import fs from 'node:fs';
import { Stream } from 'openai/core/streaming';
import { ChatCompletionStream } from 'openai/lib/ChatCompletionStream';
import OpenAI from 'openai';

let failures = 0;
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function fail(msg) {
  failures++;
  console.error(`FAIL: ${msg}`);
}
function assert(cond, msg) {
  if (!cond) fail(`assertion failed: ${msg}`);
  else pass(msg);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// .env check (same manual parser as c2-blob.mjs / c3-mem0-loop.mjs)
// ---------------------------------------------------------------------------
function loadEnv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnv(new URL('./.env', import.meta.url));
const ROUTER_API_KEY = env.ZEROG_API_KEY || env.ROUTER_API_KEY || null;
const ROUTER_BASE_URL = 'https://router-api-testnet.integratenetwork.work/v1';
const ROUTER_MODEL = 'qwen/qwen2.5-omni-7b';

console.log(
  ROUTER_API_KEY
    ? `[env] found a Router API key in .env — live path will run against ${ROUTER_BASE_URL}`
    : `[env] no ZEROG_API_KEY / ROUTER_API_KEY in .env — running UNFUNDED MODE (synthetic mock SSE stream only). Live-endpoint run against ${ROUTER_BASE_URL} (${ROUTER_MODEL}) is PENDING a key. Not inventing one, not calling mainnet.`
);

// ---------------------------------------------------------------------------
// Build a synthetic ChatCompletionChunk sequence + its SSE byte encoding.
// ---------------------------------------------------------------------------
const EXPECTED_TEXT =
  "To capture a streamed response without owning the call site, tee the SDK's " +
  'Stream before the host consumes it: one branch goes to the host untouched, ' +
  'the other branch is drained by dMemo to reconstruct the final message. ' +
  "When dMemo does own the call site, client.chat.completions.stream() plus " +
  'finalChatCompletion() does the same accumulation natively, with no manual ' +
  'delta bookkeeping required.';

// Split into small "token" pieces to simulate real delta streaming.
function splitIntoDeltas(text) {
  const words = text.split(' ');
  const pieces = [];
  for (let i = 0; i < words.length; i += 3) {
    const chunkWords = words.slice(i, i + 3);
    pieces.push((i === 0 ? '' : ' ') + chunkWords.join(' '));
  }
  return pieces;
}

const deltas = splitIntoDeltas(EXPECTED_TEXT);
const chatId = 'mock-chatcmpl-c4spike-001';
const createdTs = Math.floor(Date.now() / 1000);

function buildChunk(delta, finishReason) {
  return {
    id: chatId,
    object: 'chat.completion.chunk',
    created: createdTs,
    model: ROUTER_MODEL,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  };
}

const chunks = [
  buildChunk({ role: 'assistant', content: '' }, null),
  ...deltas.map((piece) => buildChunk({ content: piece }, null)),
  buildChunk({}, 'stop'),
];

console.log(`[build] synthesized ${chunks.length} ChatCompletionChunk objects (chatId ${chatId})`);

// Encode as a real SSE byte stream: "data: {json}\n\n" per chunk, terminated
// by "data: [DONE]\n\n" — the exact wire format Stream.fromSSEResponse parses
// (see node_modules/openai/core/streaming.mjs: _iterSSEMessages / SSEDecoder).
function encodeSSE(chunkObjs) {
  const encoder = new TextEncoder();
  const parts = chunkObjs.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  parts.push('data: [DONE]\n\n');
  return parts.map((p) => encoder.encode(p));
}

function makeMockSSEResponse(chunkObjs) {
  const byteParts = encodeSSE(chunkObjs);
  const body = new ReadableStream({
    start(controller) {
      // Split each SSE frame into two raw writes to exercise the SDK's
      // double-newline / partial-line reassembly logic, not just the
      // happy path of "one enqueue == one message".
      for (const bytes of byteParts) {
        const mid = Math.floor(bytes.length / 2) || 1;
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ===========================================================================
// UNFUNDED MODE: tee() branch-drain vs ChatCompletionStream.finalContent()
// ===========================================================================
section('UNFUNDED MODE: synthetic SSE stream comparison');

const mockResponse = makeMockSSEResponse(chunks);
const controller = new AbortController();

// Stream.fromSSEResponse is the exact primitive a raw fetch()-based SSE
// consumer (or a host app not using the openai SDK's own .stream() helper)
// would get back — this is the "dMemo doesn't own the call site" scenario.
const sseStream = Stream.fromSSEResponse(mockResponse, controller);
pass('Stream.fromSSEResponse() parsed the mock response into a Stream<ChatCompletionChunk>');

const [branchA, branchB] = sseStream.tee();
pass('Stream.tee() split into two independently-drainable branches');

// --- Branch A: manual delta-accumulation branch-drain (non-invasive observer) ---
async function drainBranchManually(stream) {
  let content = '';
  let sawRole = false;
  let finishReason = null;
  let chunkCount = 0;
  for await (const chunk of stream) {
    chunkCount++;
    for (const choice of chunk.choices) {
      if (choice.delta?.role === 'assistant') sawRole = true;
      if (choice.delta?.content) content += choice.delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { content, sawRole, finishReason, chunkCount };
}

const tBranchAStart = performance.now();
const branchAResult = await drainBranchManually(branchA);
const branchAMs = performance.now() - tBranchAStart;
console.log(`[branchA] drained ${branchAResult.chunkCount} chunks in ${branchAMs.toFixed(2)}ms, finish_reason=${branchAResult.finishReason}`);
assert(branchAResult.chunkCount === chunks.length, `branch A observed all ${chunks.length} chunks (got ${branchAResult.chunkCount})`);
assert(branchAResult.sawRole, 'branch A observed the assistant role delta');
assert(branchAResult.finishReason === 'stop', 'branch A observed finish_reason=stop');

// --- Branch B: ChatCompletionStream.fromReadableStream + finalChatCompletion ---
// Bridge Stream<ChatCompletionChunk> -> newline-delimited-JSON ReadableStream
// (via .toReadableStream(), the SDK's own documented round-trip format) ->
// ChatCompletionStream, exactly mirroring what client.chat.completions.stream()
// would hand back if this were a live call this process owned.
const tBranchBStart = performance.now();
const ccStream = ChatCompletionStream.fromReadableStream(branchB.toReadableStream());
const finalContent = await ccStream.finalContent();
const finalCompletion = await ccStream.finalChatCompletion();
const branchBMs = performance.now() - tBranchBStart;
console.log(`[branchB] ChatCompletionStream assembled final completion in ${branchBMs.toFixed(2)}ms, finish_reason=${finalCompletion.choices[0]?.finish_reason}`);

assert(finalCompletion.choices[0]?.finish_reason === 'stop', 'branch B finalChatCompletion() has finish_reason=stop');
assert(finalCompletion.id === chatId, 'branch B finalChatCompletion() preserved the chat id');
assert(finalContent === EXPECTED_TEXT, 'branch B finalContent() matches the known-good source text');

assert(branchAResult.content === EXPECTED_TEXT, 'branch A manual accumulation matches the known-good source text');
assert(
  branchAResult.content === finalContent,
  'IDENTICAL final text: Stream.tee() branch-drain === ChatCompletionStream.finalContent()'
);

console.log('\n--- assembled text (both branches) ---');
console.log(finalContent);
console.log('--- end assembled text ---');

// ===========================================================================
// LIVE MODE (Router testnet) — only runs if a key is present in .env.
// ===========================================================================
section('LIVE MODE: 0G Router testnet');

if (!ROUTER_API_KEY) {
  console.log(`SKIPPED — no ZEROG_API_KEY/ROUTER_API_KEY in .env. Nothing was invented or called.`);
  console.log(`When a key is available, set ZEROG_API_KEY (or ROUTER_API_KEY) in spike/.env and re-run;`);
  console.log(`this branch will exercise the identical tee()-vs-stream() comparison against a real`);
  console.log(`${ROUTER_BASE_URL} completion using model "${ROUTER_MODEL}".`);
} else {
  const client = new OpenAI({ apiKey: ROUTER_API_KEY, baseURL: ROUTER_BASE_URL });

  // (A) tee() branch-drain off a real fetch-backed SSE stream.
  const rawStreamPromise = client.chat.completions.create({
    model: ROUTER_MODEL,
    messages: [{ role: 'user', content: 'In one sentence, what is streaming SSE?' }],
    stream: true,
  });
  const rawStream = await rawStreamPromise; // Stream<ChatCompletionChunk>
  const [liveA, liveB] = rawStream.tee();
  const liveBranchAResult = await drainBranchManually(liveA);

  // (B) client.chat.completions.stream() + finalChatCompletion().
  // Re-issue the same prompt via the SDK's own helper for a clean, directly
  // comparable second run (tee()'ing `rawStream` a second time already
  // consumed it for comparison purposes above).
  const ccLiveStream = client.chat.completions.stream({
    model: ROUTER_MODEL,
    messages: [{ role: 'user', content: 'In one sentence, what is streaming SSE?' }],
  });
  const liveFinalContent = await ccLiveStream.finalContent();

  console.log(`[live/branchA] ${JSON.stringify(liveBranchAResult.content)}`);
  console.log(`[live/branchB] ${JSON.stringify(liveFinalContent)}`);
  console.log(
    'NOTE: live mode reissues the prompt for branch B rather than tee-ing the exact same response ' +
      'twice, so exact byte-identity is not guaranteed against a live nondeterministic model the way ' +
      'it is in unfunded mode (which tees ONE response). This live path validates plumbing/connectivity, ' +
      'not determinism — determinism is already proven above against the synthetic stream.'
  );
  pass('live Router testnet call completed (see NOTE above on what this does/does not prove)');
}

// ===========================================================================
section('SUMMARY');
const allPassed = failures === 0;
console.log(allPassed ? '\n=== ALL CHECKS PASSED ===' : '\n=== SOME CHECKS FAILED ===');
process.exitCode = allPassed ? 0 : 1;
