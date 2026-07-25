export interface SignaturePayload {
    address: string;
    signature: string;
    signatureRepeat: string;
}
export interface SignatureResponse {
    derivedAddress: string;
    needsFunding: boolean;
    balanceLabel: string;
}
export interface CompletePayload {
    txHash: string | null;
    skipped?: boolean;
}
export interface ConnectServerOptions {
    scope: string;
    network: 'testnet' | 'mainnet';
    chainIdHex: string;
    chainName: string;
    rpcUrl: string;
    currencySymbol: string;
    fundAmountLabel: string;
    fundAmountWeiHex: string;
    faucetUrl?: string;
    timeoutMs?: number;
    /** Bind port. 0 (default) = let the OS pick a free ephemeral port. */
    port?: number;
    openBrowser?: boolean;
    log?: (line: string) => void;
    /** Text the wallet is asked to sign, built in Node for a single source of truth. */
    buildMessage: (address: string) => string;
    onSignature: (payload: SignaturePayload) => Promise<SignatureResponse>;
    onComplete: (payload: CompletePayload) => Promise<void>;
}
export interface ConnectServerResult {
    completed: true;
    txHash: string | null;
    skipped: boolean;
}
export declare function runConnectServer(opts: ConnectServerOptions): Promise<ConnectServerResult>;
//# sourceMappingURL=server.d.ts.map