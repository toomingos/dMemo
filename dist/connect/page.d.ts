export interface ConnectPageOptions {
    token: string;
    scope: string;
    network: 'testnet' | 'mainnet';
    chainIdHex: string;
    chainName: string;
    rpcUrl: string;
    currencySymbol: string;
    fundAmountLabel: string;
    fundAmountWeiHex: string;
    faucetUrl?: string;
}
export declare function renderConnectPage(opts: ConnectPageOptions): string;
//# sourceMappingURL=page.d.ts.map