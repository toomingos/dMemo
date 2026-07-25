// Minimal readline-based prompt helpers. No external TUI dependency (native
// functions only — ground rule 1). `promptSecret` masks keystrokes on a TTY
// and falls back to a plain (but still never-echoed-back) read on a
// non-TTY stdin (piped input, e.g. test harnesses).
import readline from 'node:readline';
export async function promptText(question, fallback = '') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise((resolve) => rl.question(question, resolve));
        return answer.trim() || fallback;
    }
    finally {
        rl.close();
    }
}
export async function promptYesNo(question, defaultYes) {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await promptText(`${question} ${suffix} `)).toLowerCase();
    if (answer === '')
        return defaultYes;
    return answer === 'y' || answer === 'yes';
}
/**
 * Reads a line without ever writing it back to stdout. On a TTY, keystrokes
 * are masked as `*`. On a non-TTY (piped) stdin — no terminal to mask — the
 * line is still never echoed by this function (the value itself is only
 * ever returned in memory, never logged).
 */
export function promptSecret(question) {
    return new Promise((resolve) => {
        process.stdout.write(question);
        if (!process.stdin.isTTY) {
            // Non-interactive (piped/test) stdin: read one line via the default
            // readline echo-off path — nothing this function prints includes it.
            const rl = readline.createInterface({ input: process.stdin, terminal: false });
            rl.once('line', (line) => {
                rl.close();
                resolve(line.trim());
            });
            return;
        }
        const stdin = process.stdin;
        let value = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\n' || ch === '\r') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    resolve(value.trim());
                    return;
                }
                if (ch === '') {
                    // Ctrl-C
                    stdin.setRawMode(false);
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (ch === '' || ch === '\b') {
                    // Backspace
                    if (value.length > 0) {
                        value = value.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                    continue;
                }
                value += ch;
                process.stdout.write('*');
            }
        };
        stdin.on('data', onData);
    });
}
//# sourceMappingURL=prompt.js.map