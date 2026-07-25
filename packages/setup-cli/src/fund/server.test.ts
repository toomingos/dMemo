// Guards for the `dmemo fund` loopback server.
//
// Two groups of things are worth pinning here. The first is the same
// loopback threat model `connect/server.test.ts` covers — token gating,
// cross-site Origin, DNS-rebinding via a forged Host — re-asserted because
// `fund` widens CSP and a shared transport is exactly where a per-page
// change can quietly weaken a sibling.
//
// The second is specific to funding and is the part with real money behind
// it: the destination address must be locked in the widget URL, the CSP must
// widen by frame-src and nothing else, and "funded" must be a fact read off
// the chain rather than a claim the page made.
//
// Hermetic: `readBalance` is a stub, so no test here touches an RPC endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runFundServer, FUND_CSP, type FundServerOptions, type FundBalance } from './server.js';
import { tokenflightWidgetUrl, TOKENFLIGHT_ORIGIN } from '../network.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

interface Harness {
  origin: string;
  token: string;
  done: Promise<{ funded: boolean; skipped: boolean; balanceLabel: string }>;
  /** Number of real balance reads, to prove the cache works. */
  reads: () => number;
  setBalance: (next: FundBalance) => void;
}

function harness(overrides: Partial<FundServerOptions> = {}): Promise<Harness> {
  return new Promise((resolveHarness, rejectHarness) => {
    let announced = false;
    let reads = 0;
    let current: FundBalance = { balanceLabel: '0.0', funded: false };

    const done = runFundServer({
      address: ADDRESS,
      network: 'mainnet',
      chainIdHex: '0x4115',
      chainName: '0G Mainnet',
      rpcUrl: 'http://127.0.0.1:1/never-called',
      currencySymbol: '0G',
      fundAmountLabel: '0.05',
      fundAmountWeiHex: '0xb1a2bc2ec50000',
      widgetUrl: tokenflightWidgetUrl({ recipient: ADDRESS, amountUsd: 25 }),
      costLow: 0.0012,
      costHigh: 0.003,
      valueHint: '$25 ≈ 42,000 memory writes',
      initialBalance: current,
      balanceCacheMs: 50,
      async readBalance() {
        reads++;
        return current;
      },
      openBrowser: false,
      timeoutMs: 15_000,
      log(line) {
        const match = /Opening http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})/.exec(line);
        if (match && !announced) {
          announced = true;
          resolveHarness({
            origin: `http://127.0.0.1:${match[1]!}`,
            token: match[2]!,
            done: done as Harness['done'],
            reads: () => reads,
            setBalance: (next) => {
              current = next;
            },
          });
        }
      },
      ...overrides,
    }).catch((err) => {
      if (!announced) rejectHarness(err);
      throw err;
    }) as Promise<{ funded: boolean; skipped: boolean; balanceLabel: string }>;
  });
}

function api(
  origin: string,
  path: string,
  token: string | null,
  body: unknown,
  extra: Record<string, string> = {}
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (token) headers['x-dmemo-token'] = token;
  return fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function finish(h: Harness): Promise<void> {
  await api(h.origin, '/api/complete', h.token, { skipped: true }).catch(() => {});
  await h.done.catch(() => {});
}

// --- shared loopback guarantees, re-asserted for this page ----------------

test('serves the page only with a valid token', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.origin}/`)).status, 403);
    assert.equal((await fetch(`${h.origin}/?t=${'0'.repeat(64)}`)).status, 403);

    const ok = await fetch(`${h.origin}/?t=${h.token}`);
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /eip6963:announceProvider/, 'the wallet path must use EIP-6963 discovery');
    assert.ok(!html.includes('privateKey'), 'page must never reference a private key');
  } finally {
    await finish(h);
  }
});

test('rejects API calls with a missing or wrong token', async () => {
  const h = await harness();
  try {
    assert.equal((await api(h.origin, '/api/balance', null, {})).status, 403);
    assert.equal((await api(h.origin, '/api/balance', '0'.repeat(64), {})).status, 403);
  } finally {
    await finish(h);
  }
});

test('rejects a cross-site Origin', async () => {
  const h = await harness();
  try {
    const res = await api(h.origin, '/api/balance', h.token, {}, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'bad origin');
  } finally {
    await finish(h);
  }
});

test('rejects a rebound Host header', async () => {
  const h = await harness();
  const port = Number(new URL(h.origin).port);
  try {
    // fetch() forbids overriding Host, so drive the socket directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/balance', method: 'POST', headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 403);
  } finally {
    await finish(h);
  }
});

// --- funding-specific guarantees ------------------------------------------

test('CSP widens by frame-src only, and only for the widget origin', async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.origin}/?t=${h.token}`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.equal(csp, FUND_CSP);
    assert.match(csp, new RegExp(`frame-src ${TOKENFLIGHT_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // The widget must not gain any other reach into the page. If one of these
    // ever picks up the third-party origin, the "it can only be framed"
    // argument in fund/page.ts stops being true.
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(!/script-src[^;]*tokenflight/.test(csp), 'widget must never be a script source');
    assert.ok(!/connect-src[^;]*tokenflight/.test(csp), 'widget must never be a fetch target');
    assert.ok(!/img-src[^;]*tokenflight/.test(csp), 'widget must never be an image source');
  } finally {
    await finish(h);
  }
});

test('the widget URL locks the destination so funds cannot be redirected', () => {
  const url = new URL(tokenflightWidgetUrl({ recipient: ADDRESS, amountUsd: 25 }));

  assert.equal(url.origin, TOKENFLIGHT_ORIGIN);
  assert.equal(url.searchParams.get('recipient'), ADDRESS);
  // The three that matter: the user picks what they pay with, never where it
  // lands. Any of these flipping is a funds-loss bug, not a UX regression.
  assert.equal(url.searchParams.get('recipient-editable'), 'false');
  assert.equal(url.searchParams.get('lock-to-token'), 'true');
  assert.equal(
    url.searchParams.get('to-token'),
    'eip155:16661:0x0000000000000000000000000000000000000000',
    'destination must be native 0G on mainnet — storage fees cannot be paid in anything else'
  );
});

test('the page does not contact the widget until the user asks for it', async () => {
  const h = await harness();
  try {
    const html = await (await fetch(`${h.origin}/?t=${h.token}`)).text();
    // The URL is present (the page has to know it) but must not appear in a
    // src=/href= that the browser would fetch on load. Funding from a wallet
    // you already have stays a zero-external-request flow.
    assert.ok(html.includes(TOKENFLIGHT_ORIGIN), 'the widget URL should be embedded in config');
    assert.ok(
      !new RegExp(`<iframe[^>]*src=["']?https://embed\\.tokenflight`).test(html),
      'no iframe may be present in the served markup'
    );
  } finally {
    await finish(h);
  }
});

test('balance reads are cached so a fast-polling page does not hammer the RPC', async () => {
  const h = await harness();
  try {
    await Promise.all([
      api(h.origin, '/api/balance', h.token, {}),
      api(h.origin, '/api/balance', h.token, {}),
      api(h.origin, '/api/balance', h.token, {}),
    ]);
    assert.ok(h.reads() <= 1, `expected at most 1 RPC read within the cache window, got ${h.reads()}`);
  } finally {
    await finish(h);
  }
});

test('completion reports funded only when the chain says so, not the page', async () => {
  const h = await harness();

  // The page claims success while the balance is still zero. Believing it
  // would tell the user they are funded when they are not.
  const res = await api(h.origin, '/api/complete', h.token, { funded: true });
  assert.equal(res.status, 200);

  const result = await h.done;
  assert.equal(result.funded, false, 'a page-asserted "funded" must not be trusted');
  assert.equal(result.skipped, false);
});

test('completion reports funded once the balance actually arrives', async () => {
  const h = await harness();
  h.setBalance({ balanceLabel: '0.05', funded: true });
  await new Promise((r) => setTimeout(r, 60)); // let the 50ms cache lapse

  await api(h.origin, '/api/complete', h.token, { funded: true });

  const result = await h.done;
  assert.equal(result.funded, true);
  assert.equal(result.balanceLabel, '0.05');
});

test('skipping resolves without claiming the account is funded', async () => {
  const h = await harness();
  await api(h.origin, '/api/complete', h.token, { skipped: true });

  const result = await h.done;
  assert.equal(result.skipped, true);
  assert.equal(result.funded, false);
});

test('a malformed address is refused before any funding UI opens', async () => {
  const { runFund } = await import('../fund.js');
  await assert.rejects(
    // Valid hex, wrong checksum — the shape a hand-edited config produces.
    () => runFund({ env: {}, address: '0x7a3B9e2C41d5F08a6C1E4b7D9F250aE3c8B14652', log: () => {} }),
    /not a valid Ethereum address/,
    'a bad address must fail loudly, not surface as a 0.0 balance'
  );
});

test('testnet omits the widget entirely rather than offering a dead rail', async () => {
  const h = await harness({
    network: 'testnet',
    chainIdHex: '0x40da',
    chainName: '0G Galileo Testnet',
    widgetUrl: undefined,
    faucetUrl: 'https://faucet.0g.ai',
  });
  try {
    const html = await (await fetch(`${h.origin}/?t=${h.token}`)).text();
    assert.ok(!html.includes(TOKENFLIGHT_ORIGIN), 'no card/cross-chain rail reaches chain 16602');
    assert.match(html, /faucet\.0g\.ai/, 'the faucet is the only testnet route in');
  } finally {
    await finish(h);
  }
});
