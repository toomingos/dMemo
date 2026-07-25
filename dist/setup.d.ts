import { type NetworkName } from './dmemoConfig.js';
import { type InstalledHosts } from './installHosts.js';
export interface SetupOptions {
    env?: NodeJS.ProcessEnv;
    /** Non-interactive mode: no prompts, sensible defaults, never blocks on
     * stdin. Used by CI and by this task's own sandboxed test run. */
    yes?: boolean;
    network?: NetworkName;
    /** Import this key instead of generating one (still never printed). */
    importKey?: string;
    /** Explicitly mint a NEW wallet even though one is already configured.
     * Still subject to the consent gate below — this states the intent, it
     * does not grant permission. */
    newWallet?: boolean;
    /** Grant permission to replace the configured wallet without a prompt.
     * The old config is backed up regardless. */
    force?: boolean;
    skipHosts?: boolean;
    checkBalanceOnce?: boolean;
    log?: (line: string) => void;
}
export interface SetupResult {
    address: string;
    network: NetworkName;
    configPath: string;
    hosts: InstalledHosts;
    /** True when an already-configured wallet was kept as-is. */
    walletReused: boolean;
    /** Where the pre-replacement config was copied, when one was replaced. */
    backupPath: string | null;
}
export declare function runSetup(opts?: SetupOptions): Promise<SetupResult>;
//# sourceMappingURL=setup.d.ts.map