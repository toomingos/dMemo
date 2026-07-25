export interface OpenClawInstallResult {
    attempted: boolean;
    succeeded: boolean;
    output?: string;
    error?: string;
    manualInstructions: string;
}
export declare function installOpenClaw(env?: NodeJS.ProcessEnv): OpenClawInstallResult;
//# sourceMappingURL=openclaw.d.ts.map