import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runLoopbackServer } from './loopback.js';

/** A pinned `--port` is the only way a bind can fail — the default (0) always
 * gets a free ephemeral port from the OS — so these hold a port hostage and
 * check that the collision reads as guidance rather than as a raw errno. */
test('a taken --port reports the port and the way out, not `listen EADDRINUSE`', async () => {
  const squatter = http.createServer(() => {});
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const port = (squatter.address() as AddressInfo).port;

  try {
    await assert.rejects(
      runLoopbackServer({
        port,
        openBrowser: false,
        log: () => {},
        renderPage: () => '<!doctype html>',
        handle: async () => ({ ok: true }),
      }),
      (err: Error) => {
        assert.ok(!/EADDRINUSE/.test(err.message), `raw errno leaked: ${err.message}`);
        assert.match(err.message, new RegExp(`port ${port} is already in use`));
        assert.match(err.message, /--port/, 'must name the flag to drop');
        return true;
      }
    );
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('an ephemeral port never hits the collision path', async () => {
  // Same squatter, but no `--port`: the OS hands out something else and the
  // server comes up. Guards against the rewrite firing on the default path.
  const squatter = http.createServer(() => {});
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));

  const lines: string[] = [];
  let listening: string | undefined;

  const done = runLoopbackServer<'ok'>({
    openBrowser: false,
    timeoutMs: 5000,
    log(line) {
      lines.push(line);
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})/.exec(line);
      if (match && !listening) listening = `${match[1]}:${match[2]}`;
    },
    renderPage: () => '<!doctype html>',
    async handle({ finish }) {
      finish('ok');
      return { ok: true };
    },
  });

  try {
    // Give the listen callback a turn to log its URL, then settle the flow so
    // the promise resolves instead of running out the timeout.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(listening, `server never announced a URL: ${lines.join('\n')}`);
    const [boundPort, token] = listening.split(':');

    const res = await fetch(`http://127.0.0.1:${boundPort}/api/done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dmemo-token': token! },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(await done, 'ok');
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});
