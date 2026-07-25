// T4.1 step 1: generate a new wallet or import an existing private key.
// HARD RULE: never print, log, or echo a private key back to the terminal —
// not the generated one, not an imported one. Callers get the key in memory
// only, to write straight into `~/.dmemo/config.json` (mode 0600).
import { Wallet } from 'ethers';
export function generateWallet() {
    const wallet = Wallet.createRandom();
    return { privateKey: wallet.privateKey, address: wallet.address, generated: true };
}
const HEX_64 = /^[0-9a-fA-F]{64}$/;
/** Normalizes and validates a pasted/imported private key. Throws (message
 * only — never includes the key value) on malformed input. */
export function importWallet(rawKey) {
    const trimmed = rawKey.trim();
    const withPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`;
    const hexPart = withPrefix.slice(2);
    if (!HEX_64.test(hexPart)) {
        throw new Error('invalid private key: expected 32 bytes of hex (64 hex chars, optional 0x prefix)');
    }
    let wallet;
    try {
        wallet = new Wallet(withPrefix);
    }
    catch {
        throw new Error('invalid private key: not a valid secp256k1 key');
    }
    return { privateKey: wallet.privateKey, address: wallet.address, generated: false };
}
/** Redacts a private key for any diagnostic string that might otherwise
 * include it (defense in depth — callers should not be passing the raw key
 * into logs at all, but this is the last line of defense). */
export function redact(_key) {
    return '<redacted>';
}
//# sourceMappingURL=wallet.js.map