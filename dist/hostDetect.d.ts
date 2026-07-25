export interface HostDetection {
    claudeCode: boolean;
    codex: boolean;
    opencode: boolean;
    openclaw: boolean;
}
export declare function codexHome(env?: NodeJS.ProcessEnv): string;
export declare function claudeHome(env?: NodeJS.ProcessEnv): string;
export declare function opencodeConfigDir(env?: NodeJS.ProcessEnv): string;
export declare function opencodeConfigPath(env?: NodeJS.ProcessEnv): string;
export declare function openclawHome(env?: NodeJS.ProcessEnv): string;
export declare function detectHosts(env?: NodeJS.ProcessEnv): HostDetection;
//# sourceMappingURL=hostDetect.d.ts.map