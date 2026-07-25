import { type NetworkName } from './dmemoConfig.js';
import { type InstalledHosts } from './installHosts.js';
export interface ConnectOptions {
    env?: NodeJS.ProcessEnv;
    network?: NetworkName;
    /** Memory namespace. Part of the signed message, so a different scope on
     * the same wallet yields a different, fully isolated dMemo account. */
    scope?: string;
    /** Amount the page offers to send to the derived account, in ether units. */
    fundAmount?: string;
    skipHosts?: boolean;
    /** Print the URL but don't spawn a browser (headless/CI/remote shells). */
    noOpen?: boolean;
    port?: number;
    timeoutMs?: number;
    /** Skip the confirmation asked before replacing a locally-generated
     * (irreproducible) key. The old config is backed up regardless. */
    force?: boolean;
    log?: (line: string) => void;
}
export interface ConnectResult {
    /** The wallet the user connected — funds and proves identity, holds no memory. */
    walletAddress: string;
    /** The derived dMemo account — signs storage txs, is the stream identity, decrypts. */
    address: string;
    network: NetworkName;
    scope: string;
    configPath: string;
    fundingTxHash: string | null;
    hosts: InstalledHosts;
}
export declare function runConnect(opts?: ConnectOptions): Promise<ConnectResult>;
//# sourceMappingURL=connect.d.ts.map