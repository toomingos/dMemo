export declare const COMMANDS: readonly ["setup", "connect", "balance", "help"];
export type Command = (typeof COMMANDS)[number];
export interface CliArgs {
    command: Command;
    /** `--help`/`-h`, from any position. Wins over everything else — never
     * dispatches to a command. */
    help: boolean;
    /** `--version`/`-v`, from any position. Same precedence as `help`. */
    version: boolean;
    yes: boolean;
    network: 'testnet' | 'mainnet' | undefined;
    importKey: string | undefined;
    skipHosts: boolean;
    checkBalance: boolean;
    scope: string | undefined;
    fundAmount: string | undefined;
    noOpen: boolean;
    port: number | undefined;
    newWallet: boolean;
    force: boolean;
}
/** Anything the user typed wrong: an unknown command, an unknown flag, a flag
 * missing its value, or a stray extra positional. `cli.ts` catches this
 * specifically and turns it into a clean stderr message + a non-zero exit —
 * it must never be mistaken for an unexpected internal error, and it must
 * never result in falling through to a command anyway (that fallthrough is
 * the bug this type exists to prevent). */
export declare class CliUsageError extends Error {
    constructor(message: string);
}
export declare function parseArgs(argv: string[]): CliArgs;
export declare function printHelp(): void;
/** Reads this package's own `version` field. Never touches the network; the
 * only file it reads is the CLI's own `package.json`, which sits one
 * directory above the compiled `dist/*.js` this runs from. */
export declare function readPackageVersion(): string;
//# sourceMappingURL=cliArgs.d.ts.map