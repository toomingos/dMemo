/** Bump ONLY with a migration path: every existing user's memories are
 * encrypted to the key this version derives. A silent bump is a silent
 * "all your memories are gone". */
export declare const DERIVATION_VERSION = 1;
/**
 * The exact text the wallet is asked to sign. Deterministic in (address,
 * scope, version) and nothing else — deliberately NOT chain-dependent, so
 * switching a wallet between 0G testnet and mainnet cannot silently change
 * which key decrypts your memories.
 *
 * Built here in Node and handed to the page, rather than templated in the
 * browser, so the string that gets signed has exactly one source of truth.
 */
export declare function derivationMessage(address: string, scope: string): string;
export interface DerivedAccount {
    /** 0x-prefixed. Never log this. */
    privateKey: string;
    address: string;
}
/**
 * HKDF-SHA256 over the raw 65-byte signature, rejection-sampled into the
 * secp256k1 scalar range. The counter loop is not paranoia theatre: it makes
 * the out-of-range case (p ~ 2^-128) structurally impossible rather than an
 * unreachable throw, so there is no input that can produce a corrupt key.
 */
export declare function deriveAccountKey(signature: string): DerivedAccount;
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
export declare function verifyAndDerive(address: string, scope: string, signature: string, signatureRepeat: string): VerifySignaturesResult;
//# sourceMappingURL=derive.d.ts.map