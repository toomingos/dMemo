// `dmemo connect` step 3: turn a wallet signature into dMemo's account key.
//
// WHY ONE KEY, NOT TWO: an earlier sketch of this flow derived a separate
// "data key" (ECIES) and "gas key" (tx signing). Reading
// `packages/core/src/storage/client.ts` rules that out for v1 — core takes a
// single `DMEMO_PRIVATE_KEY` and uses it for all three jobs at once:
//   - `client.ts:120`  new ethers.Wallet(privateKey, provider)   -> signs/pays
//   - `client.ts:126`  senderTopic = zeroPadValue(wallet.address) -> IS the
//                      stream identity; pointers are found by filtering Submit
//                      logs on the submitter address (`client.ts:233`)
//   - `client.ts:214`  tryDecrypt(..., { privateKey })            -> decrypts
// Splitting them would split the stream identity away from the decrypt key,
// which is a storage-layer refactor, not a CLI feature. So `connect` derives
// exactly one key that does all three, and the wallet the user connects is
// only ever used to (a) prove identity by signing and (b) fund that key.
// The user's real wallet therefore never holds memory data and never needs
// to hand over its private key.
//
// HARD RULE (inherited from wallet.ts): the derived key is never printed,
// logged, or returned to the browser. Only its address crosses that boundary.

import { hkdfSync } from 'node:crypto';
import { Wallet, getAddress, verifyMessage, getBytes, hexlify } from 'ethers';

/** Bump ONLY with a migration path: every existing user's memories are
 * encrypted to the key this version derives. A silent bump is a silent
 * "all your memories are gone". */
export const DERIVATION_VERSION = 1;

const HKDF_SALT = 'dmemo-connect-v1';
const ACCOUNT_KEY_INFO = 'dmemo/account-key/v1';

/** secp256k1 group order. A derived scalar must land in [1, n-1] to be a
 * valid private key. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * The exact text the wallet is asked to sign. Deterministic in (address,
 * scope, version) and nothing else — deliberately NOT chain-dependent, so
 * switching a wallet between 0G testnet and mainnet cannot silently change
 * which key decrypts your memories.
 *
 * Built here in Node and handed to the page, rather than templated in the
 * browser, so the string that gets signed has exactly one source of truth.
 */
export function derivationMessage(address: string, scope: string): string {
  return [
    'dMemo — derive memory key',
    '',
    'Signing this message derives the encryption key for your dMemo',
    'memories. It authorizes no transaction and costs no gas.',
    '',
    `Version: ${DERIVATION_VERSION}`,
    `Scope: ${scope}`,
    `Account: ${getAddress(address)}`,
  ].join('\n');
}

export interface DerivedAccount {
  /** 0x-prefixed. Never log this. */
  privateKey: string;
  address: string;
}

const SIG_HEX = /^0x[0-9a-fA-F]{130}$/;

/**
 * HKDF-SHA256 over the raw 65-byte signature, rejection-sampled into the
 * secp256k1 scalar range. The counter loop is not paranoia theatre: it makes
 * the out-of-range case (p ~ 2^-128) structurally impossible rather than an
 * unreachable throw, so there is no input that can produce a corrupt key.
 */
export function deriveAccountKey(signature: string): DerivedAccount {
  if (!SIG_HEX.test(signature)) {
    throw new Error('invalid signature: expected 65 bytes of hex (0x + 130 hex chars)');
  }
  const ikm = getBytes(signature);

  for (let counter = 0; counter < 256; counter++) {
    const info = counter === 0 ? ACCOUNT_KEY_INFO : `${ACCOUNT_KEY_INFO}/${counter}`;
    const raw = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, info, 32));
    const scalar = BigInt(hexlify(raw));
    if (scalar === 0n || scalar >= SECP256K1_N) continue;
    const wallet = new Wallet(hexlify(raw));
    return { privateKey: wallet.privateKey, address: wallet.address };
  }
  // Unreachable short of a broken SHA-256.
  throw new Error('key derivation failed: no valid scalar after 256 attempts');
}

export interface VerifySignaturesResult {
  ok: true;
  account: DerivedAccount;
}

/**
 * The determinism gate. ECDSA nonces are only deterministic by convention
 * (RFC 6979) — no spec obliges a wallet to be. A wallet that randomizes them
 * produces a different key on every connect, i.e. silent, permanent loss of
 * every memory written under the previous one. So we ask for the SAME message
 * twice and refuse the wallet if the two signatures disagree.
 *
 * Also re-verifies that both signatures actually recover to the claimed
 * address: the callback arrives over loopback HTTP, and a token check alone
 * would still let a confused/hostile local caller hand us a signature that
 * was never produced by the wallet it claims.
 */
export function verifyAndDerive(
  address: string,
  scope: string,
  signature: string,
  signatureRepeat: string
): VerifySignaturesResult {
  const expected = getAddress(address);
  const message = derivationMessage(expected, scope);

  for (const sig of [signature, signatureRepeat]) {
    if (!SIG_HEX.test(sig)) {
      throw new Error('invalid signature: expected 65 bytes of hex (0x + 130 hex chars)');
    }
    let recovered: string;
    try {
      recovered = verifyMessage(message, sig);
    } catch {
      throw new Error('signature verification failed: could not recover a signer');
    }
    if (getAddress(recovered) !== expected) {
      throw new Error(`signature does not match the connected account ${expected}`);
    }
  }

  if (signature.toLowerCase() !== signatureRepeat.toLowerCase()) {
    throw new Error(
      'This wallet does not produce stable signatures: signing the same message ' +
        'twice gave two different results, so your memory key could not be ' +
        'recovered on another machine. Use a different wallet, or run ' +
        '`npx dmemo setup` for a locally generated account instead.'
    );
  }

  return { ok: true, account: deriveAccountKey(signature) };
}
