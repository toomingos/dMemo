export interface ClaudeCodeInstallResult {
    attempted: boolean;
    succeeded: boolean;
    output?: string;
    error?: string;
    manualInstructions: string;
    localDevInstructions: (pluginDir: string) => string;
}
export declare function installClaudeCode(env?: NodeJS.ProcessEnv): ClaudeCodeInstallResult;
//# sourceMappingURL=claudeCode.d.ts.map