import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Wallet } from 'ethers';
import { runConnectServer, type ConnectServerOptions } from './server.js';
import { derivationMessage, verifyAndDerive } from './derive.js';

const SIGNER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SCOPE = 'default';

interface Harness {
  origin: string;
  token: string;
  done: Promise<{ txHash: string | null; skipped: boolean }>;
  completed: Array<{ txHash: string | null; skipped: boolean }>;
}

/** Boots a real server on an ephemeral port and recovers its URL + token from
 * the log line the CLI would otherwise print to the user. */
function harness(overrides: Partial<ConnectServerOptions> = {}): Promise<Harness> {
  return new Promise((resolveHarness, rejectHarness) => {
    const completed: Array<{ txHash: string | null; skipped: boolean }> = [];
    let announced = false;

    const done = runConnectServer({
      scope: SCOPE,
      network: 'testnet',
      chainIdHex: '0x40da',
      chainName: '0G Galileo Testnet',
      rpcUrl: 'http://127.0.0.1:1/never-called',
      currencySymbol: '0G',
      fundAmountLabel: '0.05',
      fundAmountWeiHex: '0xb1a2bc2ec50000',
      openBrowser: false,
      timeoutMs: 15_000,
      buildMessage: (address) => derivationMessage(address, SCOPE),
      async onSignature({ address, signature, signatureRepeat }) {
        const { account } = verifyAndDerive(address, SCOPE, signature, signatureRepeat);
        return { derivedAddress: account.address, needsFunding: true, balanceLabel: '0.0' };
      },
      async onComplete(payload) {
        completed.push({ txHash: payload.txHash, skipped: payload.skipped === true });
      },
      log(line) {
        const match = /Opening http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})/.exec(line);
        if (match && !announced) {
          announced = true;
          resolveHarness({
            origin: `http://127.0.0.1:${match[1]!}`,
            token: match[2]!,
            done: done as Harness['done'],
            completed,
          });
        }
      },
      ...overrides,
    }).catch((err) => {
      if (!announced) rejectHarness(err);
      throw err;
    }) as Promise<{ txHash: string | null; skipped: boolean }>;
  });
}

function api(origin: string, path: string, token: string | null, body: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (token) headers['x-dmemo-token'] = token;
  return fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('serves the page only with a valid token', async () => {
  const h = await harness();
  try {
    const denied = await fetch(`${h.origin}/`);
    assert.equal(denied.status, 403);

    const wrong = await fetch(`${h.origin}/?t=${'0'.repeat(64)}`);
    assert.equal(wrong.status, 403);

    const ok = await fetch(`${h.origin}/?t=${h.token}`);
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /eip6963:announceProvider/, 'page must implement EIP-6963 discovery');
    assert.match(html, /eip6963:requestProvider/);
    assert.ok(!html.includes('privateKey'), 'page must never reference a private key');
  } finally {
    await finish(h);
  }
});

test('rejects API calls with a missing or wrong token', async () => {
  const h = await harness();
  try {
    assert.equal((await api(h.origin, '/api/begin', null, { address: SIGNER.address })).status, 403);
    assert.equal((await api(h.origin, '/api/begin', '0'.repeat(64), { address: SIGNER.address })).status, 403);
  } finally {
    await finish(h);
  }
});

test('rejects a cross-site Origin', async () => {
  const h = await harness();
  try {
    const res = await api(h.origin, '/api/begin', h.token, { address: SIGNER.address }, {
      origin: 'https://evil.example',
    });
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
    // fetch() forbids overriding Host, so drive the socket directly — this is
    // the DNS-rebinding shape the check exists to stop.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/begin', method: 'POST', headers: { host: 'evil.example' } },
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

test('happy path: begin -> signature -> complete resolves the server promise', async () => {
  const h = await harness();

  const begin = await api(h.origin, '/api/begin', h.token, { address: SIGNER.address });
  assert.equal(begin.status, 200);
  const { message } = (await begin.json()) as { message: string };
  assert.equal(message, derivationMessage(SIGNER.address, SCOPE));

  const signature = await SIGNER.signMessage(message);
  const sigRes = await api(h.origin, '/api/signature', h.token, {
    address: SIGNER.address,
    signature,
    signatureRepeat: signature,
  });
  assert.equal(sigRes.status, 200);
  const { derivedAddress, needsFunding } = (await sigRes.json()) as {
    derivedAddress: string;
    needsFunding: boolean;
  };
  assert.match(derivedAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(derivedAddress, SIGNER.address, 'derived account must not be the connected wallet');
  assert.equal(needsFunding, true);

  const doneRes = await api(h.origin, '/api/complete', h.token, { txHash: '0xabc' });
  assert.equal(doneRes.status, 200);

  const result = await h.done;
  assert.equal(result.txHash, '0xabc');
  assert.deepEqual(h.completed, [{ txHash: '0xabc', skipped: false }]);
});

test('a non-deterministic wallet is refused with an actionable message', async () => {
  const h = await harness();
  try {
    const message = derivationMessage(SIGNER.address, SCOPE);
    const signature = await SIGNER.signMessage(message);
    const other = await SIGNER.signMessage(derivationMessage(SIGNER.address, 'different'));

    const res = await api(h.origin, '/api/signature', h.token, {
      address: SIGNER.address,
      signature,
      signatureRepeat: other,
    });
    assert.equal(res.status, 400);
    const { error } = (await res.json()) as { error: string };
    assert.match(error, /does not match the connected account|not produce stable signatures/);
  } finally {
    await finish(h);
  }
});

/** Drives the server to completion so its promise settles and the port frees. */
async function finish(h: Harness): Promise<void> {
  await api(h.origin, '/api/complete', h.token, { txHash: null, skipped: true }).catch(() => {});
  await h.done.catch(() => {});
}
