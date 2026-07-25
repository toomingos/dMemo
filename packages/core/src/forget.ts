import { hkdfSync } from 'node:crypto';
import type { JournalingVectorStore } from './store/journal.js';

// T1.7 — forget = crypto-shred (D13), minimal v1 per TASKS.md: "epoch
// derivation + tombstone record type in the blob spec; a full retention UI
// is out of scope."
//
// KNOWN GAP (see final report deviations): this derives per-epoch sub-keys
// and proves they're derivable, but does NOT currently re-key the actual
// upload/download encryption path per epoch — T1.2's storage layer encrypts
// every blob via a single ECIES-to-wallet-pubkey scheme (D2), not per-epoch
// symmetric sub-keys. Wiring per-epoch keys into the real ciphertext path is
// out of scope for this minimal v1, consistent with "keep minimal in v1."
// `forget()` therefore currently achieves durable, on-chain-visible tombstone
// journaling (real) but not yet actual unrecoverability of pre-epoch
// ciphertext via key discard (aspirational per the D13 UX wording below).

const EPOCH_KEY_LENGTH_BYTES = 32; // AES-256-equivalent key size
const HKDF_DIGEST = 'sha256';

/**
 * Derive the per-epoch sub-key for a wallet. Deterministic: same
 * (privateKey, epoch) always yields the same key, so re-deriving the key
 * for an un-forgotten epoch during restore is cheap and stateless.
 *
 * NOTE: the wallet private key is used as HKDF input key material (IKM),
 * never as the HKDF "key" argument in a MAC sense — this is the standard
 * HKDF-Extract-then-Expand construction (RFC 5869) via node:crypto's
 * native `hkdfSync`, per the ground rule "native SDK/stdlib primitives
 * only, no custom crypto beyond AES-256-CTR/ECIES/HKDF via node:crypto".
 */
export function deriveEpochKey(walletPrivateKeyHex: string, epoch: number): Buffer {
  const ikm = walletPrivateKeyHex.startsWith('0x') ? walletPrivateKeyHex.slice(2) : walletPrivateKeyHex;
  const salt = Buffer.from('dmemo/forget/v1', 'utf8');
  const info = Buffer.from(`epoch:${epoch}`, 'utf8');
  const derived = hkdfSync(HKDF_DIGEST, Buffer.from(ikm, 'hex'), salt, info, EPOCH_KEY_LENGTH_BYTES);
  return Buffer.from(derived);
}

export interface ForgetOptions {
  walletPrivateKeyHex: string;
  epoch: number;
  reason?: string;
  journal: JournalingVectorStore;
}

export interface ForgetResult {
  epoch: number;
  /** Confirms the sub-key was derivable (proof-of-derivability). The key
   * itself is never returned or persisted — it's discarded immediately
   * after this call, which is the "crypto-shred" gesture for this epoch. */
  keyDerived: true;
  tombstonedAt: string;
}

/**
 * "Forget" an epoch: derive its sub-key (to prove it existed / was
 * derivable), immediately discard it, and journal a durable tombstone
 * record so the forget event survives flush/restore and is visible in the
 * on-chain-anchored journal (audit trail). UX wording per D13: "unreadable
 * forever" — never "deleted".
 */
export function forget(opts: ForgetOptions): ForgetResult {
  const key = deriveEpochKey(opts.walletPrivateKeyHex, opts.epoch);
  key.fill(0); // discard immediately — this call never persists or returns it
  opts.journal.journalTombstone(opts.epoch, opts.reason);
  return { epoch: opts.epoch, keyDerived: true, tombstonedAt: new Date().toISOString() };
}
