import { installCodex } from './installers/codex.js';
import { installOpenCode } from './installers/opencode.js';
import { installClaudeCode } from './installers/claudeCode.js';
import { installOpenClaw } from './installers/openclaw.js';
export interface InstalledHosts {
    claudeCode?: Awaited<ReturnType<typeof installClaudeCode>>;
    codex?: Awaited<ReturnType<typeof installCodex>> | {
        error: string;
    };
    opencode?: Awaited<ReturnType<typeof installOpenCode>>;
    openclaw?: Awaited<ReturnType<typeof installOpenClaw>>;
}
export declare function installDetectedHosts(env: NodeJS.ProcessEnv, log: (line: string) => void): InstalledHosts;
//# sourceMappingURL=installHosts.d.ts.map