#!/usr/bin/env node
// Backing script for the `dmemo-search` skill (model-invoked, explicit
// recall mid-turn — complements the deterministic UserPromptSubmit
// prefetch). Usage: node search-memory.cjs "QUERY". Prints formatted
// results to stdout; prints a one-line status message and exits 0 even
// when unconfigured/empty (a skill script failing loudly would just
// confuse the model mid-turn).

import { withSession } from '../lib/dmemo.js';

const TOP_K = 5;

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.log('Usage: search-memory.cjs "<query>"');
    return;
  }

  const output = await withSession(async ({ session, scope }) => {
    const result = await session.memory.search(query, { filters: { user_id: scope }, topK: TOP_K });
    if (!result.results.length) return 'No matching memories found.';
    return result.results
      .map(
        (m: { memory: string; score?: number }, i: number) =>
          `${i + 1}. ${m.memory}${m.score !== undefined ? ` (score: ${m.score.toFixed(3)})` : ''}`
      )
      .join('\n');
  });

  console.log(output ?? 'dMemo is not configured (no DMEMO_PRIVATE_KEY) — memory search unavailable.');
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch(() => {
    process.exitCode = 0;
  });
