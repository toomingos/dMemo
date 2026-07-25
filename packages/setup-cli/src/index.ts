// Library surface (mainly for tests / programmatic use). The CLI entry
// point is `cli.ts` (see `bin.dmemo` in package.json).
export { runSetup } from './setup.js';
export type { SetupOptions, SetupResult } from './setup.js';
export { runConnect } from './connect.js';
export type { ConnectOptions, ConnectResult } from './connect.js';
export { derivationMessage, deriveAccountKey, verifyAndDerive, DERIVATION_VERSION } from './connect/derive.js';
export type { DerivedAccount } from './connect/derive.js';
export { installDetectedHosts } from './installHosts.js';
export type { InstalledHosts } from './installHosts.js';
export { generateWallet, importWallet } from './wallet.js';
export type { WalletResult } from './wallet.js';
export { writeDmemoConfig, readDmemoConfig, dmemoHome, dmemoConfigPath } from './dmemoConfig.js';
export type { DmemoConfigFile, NetworkName } from './dmemoConfig.js';
export { detectHosts } from './hostDetect.js';
export type { HostDetection } from './hostDetect.js';
export { checkBalance, faucetInstructions } from './network.js';
