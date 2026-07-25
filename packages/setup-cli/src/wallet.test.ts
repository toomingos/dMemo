import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWallet, importWallet } from './wallet.js';

test('generateWallet produces a valid 0x-prefixed key and matching address', () => {
  const w1 = generateWallet();
  const w2 = generateWallet();
  assert.match(w1.privateKey, /^0x[0-9a-fA-F]{64}$/);
  assert.match(w1.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(w1.generated, true);
  assert.notEqual(w1.privateKey, w2.privateKey, 'two generated wallets must differ');
});

test('importWallet round-trips a generated key deterministically', () => {
  const generated = generateWallet();
  const imported = importWallet(generated.privateKey);
  assert.equal(imported.address, generated.address);
  assert.equal(imported.generated, false);
});

test('importWallet accepts a key without the 0x prefix', () => {
  const generated = generateWallet();
  const withoutPrefix = generated.privateKey.slice(2);
  const imported = importWallet(withoutPrefix);
  assert.equal(imported.address, generated.address);
});

test('importWallet rejects malformed input without throwing the raw value', () => {
  assert.throws(() => importWallet('not-a-key'), /invalid private key/);
  assert.throws(() => importWallet('0x1234'), /invalid private key/);
});
