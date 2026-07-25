export declare function promptText(question: string, fallback?: string): Promise<string>;
export declare function promptYesNo(question: string, defaultYes: boolean): Promise<boolean>;
/**
 * Reads a line without ever writing it back to stdout. On a TTY, keystrokes
 * are masked as `*`. On a non-TTY (piped) stdin — no terminal to mask — the
 * line is still never echoed by this function (the value itself is only
 * ever returned in memory, never logged).
 */
export declare function promptSecret(question: string): Promise<string>;
//# sourceMappingURL=prompt.d.ts.map