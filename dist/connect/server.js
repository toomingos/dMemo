// Ephemeral loopback server behind `dmemo connect`.
//
// THREAT MODEL: this listens on the user's own machine while a browser is
// open, so "it's only localhost" is not a security argument — any page the
// user has open can issue requests to 127.0.0.1. The mitigations, matching
// the shape `wrangler login` / `gh auth login` use for their OAuth callback:
//   - bind 127.0.0.1 explicitly (never 0.0.0.0 — that would expose the flow
//     to the local network),
//   - mint a 32-byte single-use token, hand it to the page in the URL, and
//     require it on every API call (timing-safe compare),
//   - require Origin (when present) and Host to be our own loopback origin,
//     which blocks both cross-site POSTs and DNS-rebinding,
//   - hard timeout, and shut down the moment the flow finishes.
// The derived private key never crosses this boundary in either direction:
// the browser sends a signature, Node derives the key from it, and only the
// resulting address is sent back for display and funding.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { renderConnectPage } from './page.js';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
function tokensMatch(provided, expected) {
    if (typeof provided !== 'string')
        return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on length mismatch, so gate on length first. The
    // length itself is not a secret (it is a fixed 64 hex chars).
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
function readJson(req, limitBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0)
                return resolve({});
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                resolve(parsed && typeof parsed === 'object' ? parsed : {});
            }
            catch {
                reject(new Error('malformed JSON body'));
            }
        });
        req.on('error', reject);
    });
}
function str(v) {
    return typeof v === 'string' ? v : '';
}
/** Best-effort. A failure here is cosmetic — the URL is always printed too. */
function openInBrowser(url) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.on('error', () => { });
        child.unref();
    }
    catch {
        /* ignore — user can click the printed URL */
    }
}
export async function runConnectServer(opts) {
    const log = opts.log ?? ((line) => console.log(line));
    const token = randomBytes(32).toString('hex');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            // Let the final response flush before tearing the socket down.
            setTimeout(() => server.close(), 50).unref();
            fn();
        };
        const server = http.createServer((req, res) => {
            const send = (status, body, contentType = 'application/json') => {
                const payload = contentType === 'application/json' ? JSON.stringify(body) : String(body);
                res.writeHead(status, {
                    'content-type': `${contentType}; charset=utf-8`,
                    'cache-control': 'no-store',
                    // This page talks only to its own origin and loads no third-party
                    // anything; wallet icons arrive as data: URIs over EIP-6963.
                    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
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
                    send(403, 'Invalid or missing token. Re-run `npx dmemo connect`.', 'text/plain');
                    return;
                }
                send(200, renderConnectPage({
                    token,
                    scope: opts.scope,
                    network: opts.network,
                    chainIdHex: opts.chainIdHex,
                    chainName: opts.chainName,
                    rpcUrl: opts.rpcUrl,
                    currencySymbol: opts.currencySymbol,
                    fundAmountLabel: opts.fundAmountLabel,
                    fundAmountWeiHex: opts.fundAmountWeiHex,
                    faucetUrl: opts.faucetUrl,
                }), 'text/html');
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
            if (!tokensMatch(req.headers['x-dmemo-token'], token)) {
                send(403, { error: 'bad token' });
                return;
            }
            readJson(req)
                .then(async (body) => {
                switch (url.pathname) {
                    case '/api/begin': {
                        const address = str(body.address);
                        if (!address)
                            return send(400, { error: 'address required' });
                        return send(200, { message: opts.buildMessage(address) });
                    }
                    case '/api/signature': {
                        const payload = {
                            address: str(body.address),
                            signature: str(body.signature),
                            signatureRepeat: str(body.signatureRepeat),
                        };
                        const result = await opts.onSignature(payload);
                        return send(200, result);
                    }
                    case '/api/complete': {
                        const txHash = typeof body.txHash === 'string' ? body.txHash : null;
                        const skipped = body.skipped === true;
                        await opts.onComplete({ txHash, skipped });
                        send(200, { ok: true });
                        finish(() => resolve({ completed: true, txHash, skipped }));
                        return;
                    }
                    case '/api/error': {
                        // The page reports recoverable wallet errors (user rejected,
                        // wrong network) so the terminal isn't silent while the user
                        // stares at a red message in the browser. Never fatal: they can
                        // retry in the same page.
                        const message = str(body.message);
                        if (message)
                            log(`  browser: ${message}`);
                        return send(200, { ok: true });
                    }
                    default:
                        return send(404, { error: 'not found' });
                }
            })
                .catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                send(400, { error: message });
            });
        });
        let port = 0;
        server.on('error', (err) => finish(() => reject(err)));
        server.listen(opts.port ?? 0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                finish(() => reject(new Error('failed to bind loopback port')));
                return;
            }
            port = addr.port;
            const target = `http://127.0.0.1:${port}/?t=${token}`;
            timer = setTimeout(() => {
                finish(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for the browser`)));
            }, timeoutMs);
            timer.unref?.();
            if (opts.openBrowser !== false)
                openInBrowser(target);
            log(`Opening ${target}`);
            log('(If your browser did not open, paste that URL into it.)\n');
            log('Waiting for your wallet…');
        });
    });
}
//# sourceMappingURL=server.js.map