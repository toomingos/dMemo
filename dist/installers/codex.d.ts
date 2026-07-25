export interface CodexInstallResult {
    installedPluginDir: string;
    hooksFile: string;
    stdout: string;
}
export declare function installCodex(env?: NodeJS.ProcessEnv): CodexInstallResult;
export declare function uninstallCodex(env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=codex.d.ts.map