// Shared loopback-server plumbing for the browser-backed subcommands
// (`dmemo connect`, `dmemo fund`).
//
// Extracted from `connect/server.ts` when `fund` needed the same scaffolding.
// This is security-critical code and duplicating it per subcommand is how one
// copy quietly drifts, so there is exactly one of it.
//
// THREAT MODEL (unchanged from the original): this listens on the user's own
// machine while a browser is open, so "it's only localhost" is not a security
// argument — any page the user has open can issue requests to 127.0.0.1. The
// mitigations match the shape `wrangler login` / `gh auth login` use for their
// OAuth callback:
//   - bind 127.0.0.1 explicitly (never 0.0.0.0 — that would expose the flow
//     to the local network),
//   - mint a 32-byte single-use token, hand it to the page in the URL, and
//     require it on every API call (timing-safe compare),
//   - require Origin (when present) and Host to be our own loopback origin,
//     which blocks both cross-site POSTs and DNS-rebinding,
//   - hard timeout, and shut down the moment the flow finishes.

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dim, lime, symbols, wrap } from './theme.js';

/** Default CSP: the page talks only to its own origin and loads no
 * third-party anything. `fund` widens this deliberately (see FUND_CSP).
 *
 * `font-src data:` is what lets the pages embed the site's typeface as a
 * data: URI (see `web/theme.ts`). It permits no network origin — the whole
 * point is that the pages look like dmemo.ai WITHOUT fetching anything from
 * it. */
export const STRICT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; connect-src 'self'";

export type Send = (status: number, body: unknown, contentType?: string) => void;

export interface LoopbackHandlerContext<T> {
  pathname: string;
  body: Record<string, unknown>;
  /** Settle the server's promise with this value and shut down. Call it AFTER
   * returning the response body — the handler's return value is still sent. */
  finish: (result: T) => void;
}

export interface LoopbackServerOptions<T> {
  /** Full HTML for `GET /?t=<token>`. Receives the minted token so the page
   * can echo it back on API calls. */
  renderPage: (token: string) => string;
  /** Content-Security-Policy for every response. Defaults to STRICT_CSP. */
  csp?: string;
  /** Plain-text body for `GET /` without a valid token. Name the command that
   * opened the page so the user knows what to re-run. */
  invalidTokenMessage?: string;
  timeoutMs?: number;
  /** Bind port. 0 (default) = let the OS pick a free ephemeral port. */
  port?: number;
  openBrowser?: boolean;
  log?: (line: string) => void;
  /** Lines printed once the server is listening, after the URL. */
  waitingMessage?: string;
  /** The reassurance under `waitingMessage`. Callers MUST state what is
   * actually true of their own flow at this moment — `fund` runs after the
   * config is on disk, `connect` runs as step 1 of setup, before it. */
  waitingHint?: string;
  /** Handles `POST /api/<name>`. Whatever it returns is sent as a 200 JSON
   * body; throwing sends a 400 with the error message. */
  handle: (ctx: LoopbackHandlerContext<T>) => Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so gate on length first. The
  // length itself is not a secret (it is a fixed 64 hex chars).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readJson(
  req: http.IncomingMessage,
  limitBytes = 64 * 1024
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Best-effort. A failure here is cosmetic — the URL is always printed too. */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore — user can click the printed URL */
  }
}

export async function runLoopbackServer<T>(opts: LoopbackServerOptions<T>): Promise<T> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const token = randomBytes(32).toString('hex');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const csp = opts.csp ?? STRICT_CSP;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Let the final response flush before tearing the socket down.
      setTimeout(() => server.close(), 50).unref();
      fn();
    };

    const server = http.createServer((req, res) => {
      const send: Send = (status, body, contentType = 'application/json') => {
        const payload = contentType === 'application/json' ? JSON.stringify(body) : String(body);
        res.writeHead(status, {
          'content-type': `${contentType}; charset=utf-8`,
          'cache-control': 'no-store',
          'content-security-policy': csp,
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        });
        res.end(payload);
      };

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const selfHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const selfOrigins = selfHosts.map((h) => `http://${h}`);

      // Reject anything addressed to a hostname that is not our own loopback
      // origin — this is what stops a DNS-rebinding page from reaching us.
      if (!selfHosts.includes(req.headers.host ?? '')) {
        send(403, { error: 'bad host' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        if (!tokensMatch(url.searchParams.get('t') ?? undefined, token)) {
          send(
            403,
            opts.invalidTokenMessage ??
              'Invalid or missing token. Re-run the dmemo command that opened this page.',
            'text/plain'
          );
          return;
        }
        send(200, opts.renderPage(token), 'text/html');
        return;
      }

      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
        send(404, { error: 'not found' });
        return;
      }

      const origin = req.headers.origin;
      if (typeof origin === 'string' && !selfOrigins.includes(origin)) {
        send(403, { error: 'bad origin' });
        return;
      }
      if (!tokensMatch(req.headers['x-dmemo-token'] as string | undefined, token)) {
        send(403, { error: 'bad token' });
        return;
      }

      readJson(req)
        .then(async (body) => {
          let pendingResult: { value: T } | null = null;
          const responseBody = await opts.handle({
            pathname: url.pathname,
            body,
            // Deferred: the handler declares the flow finished, but the
            // response must reach the browser before the socket dies.
            finish: (value: T) => {
              pendingResult = { value };
            },
          });
          send(200, responseBody ?? { ok: true });
          if (pendingResult) {
            const settledValue = (pendingResult as { value: T }).value;
            finish(() => resolve(settledValue));
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // A handler that doesn't recognize the path is a routing miss (404),
          // not a bad request (400) — same distinction the hand-rolled
          // switch/default in connect made before this was shared.
          send(err instanceof NotFoundError ? 404 : 400, { error: message });
        });
    });

    let port = 0;
    // Bind failures are only reachable when a caller pinned `--port`; the
    // default (0) always gets a free ephemeral port. Node's raw
    // `listen EADDRINUSE: address already in use 127.0.0.1:8899` names no
    // remedy, and the remedy here is simply to drop the flag.
    server.on('error', (err) => finish(() => reject(bindError(err, opts.port))));
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        finish(() => reject(new Error('failed to bind loopback port')));
        return;
      }
      port = addr.port;
      const target = `http://127.0.0.1:${port}/?t=${token}`;

      timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(`timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for the browser`)
          )
        );
      }, timeoutMs);
      timer.unref?.();

      if (opts.openBrowser !== false) openInBrowser(target);
      // Indented and dimmed to sit under the step that opened it, rather than
      // reading as a fresh top-level event. The URL itself stays undimmed:
      // it is the one string on screen the user may have to select and paste.
      // padEnd(7) matches the key column `fund` prints its account/balance
      // rows in, so the URL lines up with the values above it.
      log(`  ${dim('opening'.padEnd(7))}  ${target}`);
      log(dim(wrap('If your browser did not open, paste that URL into it.', 4)));
      log('');
      if (opts.waitingMessage) {
        log(`  ${lime(symbols().bullet)} ${opts.waitingMessage}`);
        if (opts.waitingHint) log(dim(wrap(opts.waitingHint, 4)));
        log('');
      }
    });
  });
}

/** Escapes text interpolated into page HTML. Lives here because both the
 * connect and fund pages need it and it must not drift between them. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** JSON-embeds a value into a `<script>` block without letting a `</script>`
 * inside the data terminate the block early. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Rewrites a listen failure into something actionable. Anything we don't
 * recognize passes through untouched — a wrong guess is worse than the raw
 * errno. */
function bindError(err: unknown, requestedPort: number | undefined): unknown {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (!requestedPort) return err;
  if (code === 'EADDRINUSE') {
    return new Error(
      `port ${requestedPort} is already in use. Drop \`--port\` to let dMemo pick a free one, or free the port first (\`lsof -nP -iTCP:${requestedPort} -sTCP:LISTEN\`).`
    );
  }
  if (code === 'EACCES') {
    return new Error(
      `not allowed to bind port ${requestedPort}. Ports below 1024 need elevated privileges — drop \`--port\` or pick one above 1024.`
    );
  }
  return err;
}

/** Thrown by a handler to signal "not found" without the generic 400 path. */
export class NotFoundError extends Error {
  constructor(pathname: string) {
    super(`not found: ${pathname}`);
    this.name = 'NotFoundError';
  }
}
