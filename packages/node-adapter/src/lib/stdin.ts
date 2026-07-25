// Small stdin/stdout helpers shared by every hook script. Ported pattern
// from claude-supermemory's src/lib/stdin.js (read full stdin, JSON.parse,
// write a single JSON line to stdout). Never throws on read: callers decide
// fail-open behavior.

export async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  // Claude Code / Codex both pipe a single JSON object on stdin and close
  // it immediately; if stdin is a TTY (manual invocation) resolve to {}.
  if (process.stdin.isTTY) return {};
  try {
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Garbage stdin must never crash a hook (fail-open contract).
    return {};
  }
}

/** Write one JSON object to stdout (Claude Code/Codex hook output contract). */
export function writeOutput(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
