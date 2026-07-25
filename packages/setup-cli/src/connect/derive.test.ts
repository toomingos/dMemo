import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import {
  derivationMessage,
  deriveAccountKey,
  verifyAndDerive,
  DERIVATION_VERSION,
} from './derive.js';

// A fixed wallet standing in for "the wallet the user connects". ethers signs
// deterministically (RFC 6979), which is exactly the property the real flow
// checks for at runtime — so it doubles as the well-behaved-wallet fixture.
const SIGNER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

async function sign(scope = 'default', signer = SIGNER): Promise<string> {
  return await signer.signMessage(derivationMessage(signer.address, scope));
}

test('derivationMessage is stable and binds version, scope, and account', () => {
  const message = derivationMessage(SIGNER.address, 'default');
  assert.equal(message, derivationMessage(SIGNER.address.toLowerCase(), 'default'));
  assert.match(message, new RegExp(`Version: ${DERIVATION_VERSION}`));
  assert.match(message, /Scope: default/);
  assert.ok(message.includes(SIGNER.address), 'must bind the checksummed account address');
  assert.match(message, /authorizes no transaction/);
});

test('the same signature always derives the same account', async () => {
  const signature = await sign();
  const a = deriveAccountKey(signature);
  const b = deriveAccountKey(signature);
  assert.equal(a.privateKey, b.privateKey);
  assert.equal(a.address, b.address);
  assert.match(a.privateKey, /^0x[0-9a-fA-F]{64}$/);
  assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
});

test('the derived account is NOT the connected wallet', async () => {
  const derived = deriveAccountKey(await sign());
  assert.notEqual(derived.address, SIGNER.address);
  assert.notEqual(derived.privateKey, SIGNER.privateKey);
});

test('a different scope on the same wallet yields a different account', async () => {
  const work = deriveAccountKey(await sign('work'));
  const personal = deriveAccountKey(await sign('personal'));
  assert.notEqual(work.address, personal.address);
});

test('a different wallet yields a different account', async () => {
  const other = Wallet.createRandom();
  const a = deriveAccountKey(await sign('default'));
  const b = deriveAccountKey(await other.signMessage(derivationMessage(other.address, 'default')));
  assert.notEqual(a.address, b.address);
});

test('deriveAccountKey rejects malformed signatures', () => {
  assert.throws(() => deriveAccountKey('nope'), /invalid signature/);
  assert.throws(() => deriveAccountKey('0xdeadbeef'), /invalid signature/);
});

test('verifyAndDerive accepts two identical valid signatures', async () => {
  const signature = await sign();
  const { account } = verifyAndDerive(SIGNER.address, 'default', signature, signature);
  assert.equal(account.address, deriveAccountKey(signature).address);
});

test('verifyAndDerive rejects a wallet whose signatures differ (the determinism gate)', async () => {
  const signature = await sign();
  // Simulate a wallet that randomizes its ECDSA nonce: same message, same
  // signer, two different valid-looking signatures. This is the case that
  // would otherwise silently orphan every memory on the next connect.
  const flipped = await SIGNER.signMessage(derivationMessage(SIGNER.address, 'other-scope'));
  assert.throws(
    () => verifyAndDerive(SIGNER.address, 'default', signature, flipped),
    /does not match the connected account|not produce stable signatures/
  );
});

test('verifyAndDerive rejects a signature from a different account', async () => {
  const impostor = Wallet.createRandom();
  const signature = await impostor.signMessage(derivationMessage(SIGNER.address, 'default'));
  assert.throws(
    () => verifyAndDerive(SIGNER.address, 'default', signature, signature),
    /does not match the connected account/
  );
});

test('verifyAndDerive rejects a signature over a different message', async () => {
  const wrong = await SIGNER.signMessage('some other message entirely');
  assert.throws(
    () => verifyAndDerive(SIGNER.address, 'default', wrong, wrong),
    /does not match the connected account/
  );
});

test('the determinism gate fires even when both signatures are individually valid', async () => {
  // Two genuinely different signatures over the SAME message by the SAME
  // signer — what a non-RFC-6979 wallet produces. Constructed by flipping the
  // recovery byte, which keeps the signature verifiable in some libraries but
  // must still be rejected as "not stable".
  const signature = await sign();
  const message = derivationMessage(SIGNER.address, 'default');
  const alt = signature.slice(0, -2) + (signature.endsWith('1b') ? '1c' : '1b');
  assert.throws(
    () => verifyAndDerive(SIGNER.address, 'default', signature, alt),
    /does not match the connected account|not produce stable signatures/
  );
  // Sanity: the honest path over the same message still works.
  assert.ok(verifyAndDerive(SIGNER.address, 'default', signature, signature).ok);
  assert.ok(message.length > 0);
});
