export type NetworkName = 'testnet' | 'mainnet';
export interface DmemoConfigFile {
    DMEMO_PRIVATE_KEY: string;
    DMEMO_NETWORK: NetworkName;
    [key: string]: string | undefined;
}
/** Mirrors `@dmemo/node-adapter`'s `DMEMO_HOME` resolution exactly (env
 * override for sandboxed testing, `~/.dmemo` otherwise) so a config written
 * by this CLI is found by every host adapter without any extra wiring. */
export declare function dmemoHome(env?: NodeJS.ProcessEnv): string;
export declare function dmemoConfigPath(env?: NodeJS.ProcessEnv): string;
export interface WriteConfigOptions {
    /**
     * Permit this write to replace an existing, DIFFERENT `DMEMO_PRIVATE_KEY`.
     * Without it such a write throws `ExistingKeyError` and touches nothing.
     * Writing the SAME key back is never a replacement and never needs this
     * (that is what keeps an idempotent `dmemo setup` re-run safe).
     */
    allowKeyReplacement?: boolean;
}
export interface WriteConfigResult {
    path: string;
    created: boolean;
    merged: boolean;
    /** Timestamped 0600 copy taken before this write destroyed anything
     * (a key swap, or an unparseable file), or null if nothing was at risk. */
    backupPath: string | null;
    /** True if this write swapped `DMEMO_PRIVATE_KEY` for a different value. */
    keyReplaced: boolean;
}
/** Everything about an on-record key that is safe to show a human. Carries no
 * key material — only the address it derives to and its provenance. */
export interface ExistingKeyInfo {
    configPath: string;
    /** Address of the stored key. Null only if the stored value is unparseable. */
    address: string | null;
    /** `'connect'` for a key derived from a wallet signature (reproducible by
     * reconnecting the same wallet + scope), otherwise `'generated'` for a
     * random or imported key, which exists nowhere else in the universe. */
    source: 'connect' | 'generated';
    scope?: string;
    connectedWallet?: string;
    network?: string;
}
/** Thrown instead of clobbering a key the caller did not explicitly consent
 * to replace. Never carries key material — address and provenance only. */
export declare class ExistingKeyError extends Error {
    readonly existing: ExistingKeyInfo;
    readonly incomingAddress: string | null;
    constructor(existing: ExistingKeyInfo, incomingAddress: string | null);
}
/** Address for a private key, or null if it isn't one. Never throws, and
 * never includes the key in anything it returns. */
export declare function addressForKey(key: unknown): string | null;
/**
 * Describes the key currently on record, or null if there is none. Callers
 * use this to decide whether they are about to do something destructive
 * BEFORE they do any work (generate a wallet, spawn a browser, ...).
 */
export declare function inspectExistingKey(env?: NodeJS.ProcessEnv): ExistingKeyInfo | null;
/** How to get back a key that was just replaced — recovery advice tailored to
 * how the old key came into existence. */
export declare function recoveryHint(existing: ExistingKeyInfo, backupPath: string | null): string;
/**
 * Writes (or merges into) `~/.dmemo/config.json`. Existing keys not
 * mentioned in `updates` are preserved (an idempotent re-run of `dmemo setup`
 * shouldn't clobber e.g. a hand-set `DMEMO_EMBEDDER_PROVIDER`). File mode is
 * forced to 0600 on every write since it may contain a private key.
 *
 * Throws `ExistingKeyError` — writing nothing — if `updates` carries a
 * `DMEMO_PRIVATE_KEY` that differs from the one already on record and the
 * caller did not pass `allowKeyReplacement`. When a replacement IS permitted,
 * or when the existing file is unparseable, the old file is copied to a
 * timestamped 0600 backup first.
 */
export declare function writeDmemoConfig(updates: Partial<DmemoConfigFile>, env?: NodeJS.ProcessEnv, options?: WriteConfigOptions): WriteConfigResult;
export declare function readDmemoConfig(env?: NodeJS.ProcessEnv): Record<string, unknown> | null;
//# sourceMappingURL=dmemoConfig.d.ts.map