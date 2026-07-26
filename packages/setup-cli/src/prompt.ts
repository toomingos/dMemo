// Prompt primitives. No external TUI dependency (native functions only —
// ground rule 1), and every one of them degrades to a plain readline call
// when there is no terminal to draw on.
//
// WHY THERE IS A SELECT HERE. `[generate/import]` asked the user to type a
// whole word to answer a two-option question, with no indication of which one
// Enter would pick. Every CLI people already use for this kind of question
// (`gh`, `npm create`, `cargo generate`) renders a list you move through with
// the arrow keys, so that is what this does — arrows or j/k to move, number
// keys to jump, first letter to pick, Enter to accept, and a visible default.
//
// The interactive path is used only when BOTH stdin and stdout are TTYs.
// stdin alone is not enough: `dmemo setup | tee install.log` has a real
// keyboard but a pipe for output, and redrawing a list into a pipe writes
// cursor-movement escapes into the user's log file.

import readline from 'node:readline';
import { bold, dim, lime, symbols, unicode } from './theme.js';

// Written as escapes rather than literal control bytes so they survive every
// editor, diff view and clipboard this file passes through.
const ESC = '\u001b';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = ['\u007f', '\b'];

const CLEAR_LINE = `${ESC}[2K`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const up = (n: number): string => (n > 0 ? `${ESC}[${n}A` : '');

/** True when we can draw and erase a list in place. */
function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptText(question: string, fallback = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

/**
 * Reads single keypresses in raw mode until `onKey` returns true.
 * Ctrl-C and Ctrl-D always exit 130 — a half-answered prompt is not a state
 * worth trying to unwind.
 */
function readKeys(onKey: (key: string) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk: string): void => {
      // Arrow keys arrive as one 3-byte chunk, so the chunk is the unit of
      // interest, not the code point — iterating would turn one Up keypress
      // into three meaningless ones.
      if (chunk === CTRL_C || chunk === CTRL_D) {
        stdin.setRawMode(false);
        process.stdout.write(SHOW_CURSOR + '\n');
        process.exit(130);
      }
      if (!onKey(chunk)) return;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve();
    };

    stdin.on('data', onData);
  });
}

export interface SelectChoice<T> {
  value: T;
  label: string;
  /** Dimmed one-liner under the label — the "what does this actually mean"
   * text that otherwise ends up in a paragraph above the prompt nobody
   * reads. */
  hint?: string;
}

export interface SelectOptions {
  /** Pre-highlighted entry, and the answer Enter gives on a non-TTY. */
  defaultIndex?: number;
}

/**
 * An arrow-key list. Returns the chosen `value`.
 *
 * On a non-TTY this collapses to one typed line accepting the full label or
 * any prefix of it (`i` for `import`), so scripted and piped runs keep
 * working exactly as they did before the list existed.
 */
export async function promptSelect<T>(
  question: string,
  choices: Array<SelectChoice<T>>,
  opts: SelectOptions = {}
): Promise<T> {
  const [first] = choices;
  if (!first) throw new Error('promptSelect: no choices');
  const start = Math.min(Math.max(opts.defaultIndex ?? 0, 0), choices.length - 1);
  // `noUncheckedIndexedAccess` is on, and every index here is already clamped
  // to the array — this keeps that provable instead of asserting it away.
  const pick = (i: number): SelectChoice<T> => choices[i] ?? first;

  if (!interactive()) {
    const labels = choices.map((c) => c.label).join('/');
    const typed = (await promptText(`  ${question} [${labels}] `, pick(start).label)).toLowerCase();
    const match = choices.find(
      (c) => c.label.toLowerCase() === typed || (typed !== '' && c.label.toLowerCase().startsWith(typed))
    );
    return (match ?? pick(start)).value;
  }

  const sym = symbols();
  const pointer = unicode() ? '❯' : '>';
  const hintKeys = unicode() ? '↑↓ to move, enter to select' : 'up/down to move, enter to select';
  const out = process.stdout;
  let index = start;

  /** Screen lines the list occupies, so the redraw knows how far to reach. */
  const rows = choices.reduce((n, c) => n + (c.hint ? 2 : 1), 0);

  const draw = (): void => {
    for (const [i, choice] of choices.entries()) {
      const active = i === index;
      out.write(
        CLEAR_LINE +
          (active ? `  ${lime(pointer)} ${bold(choice.label)}` : `    ${dim(choice.label)}`) +
          '\n'
      );
      if (choice.hint) out.write(CLEAR_LINE + dim(`      ${choice.hint}`) + '\n');
    }
  };

  out.write(`  ${question} ${dim(`(${hintKeys})`)}\n`);
  out.write(HIDE_CURSOR);
  draw();

  try {
    await readKeys((key) => {
      if (key === '\r' || key === '\n') return true;

      if (key === `${ESC}[A` || key === 'k') {
        index = (index - 1 + choices.length) % choices.length;
      } else if (key === `${ESC}[B` || key === 'j') {
        index = (index + 1) % choices.length;
      } else if (key >= '1' && key <= '9' && Number(key) <= choices.length) {
        // A number key names exactly one row, so it selects AND submits.
        index = Number(key) - 1;
        return true;
      } else {
        // First letter, when it names exactly one choice.
        const hits = choices.filter((c) => c.label.toLowerCase().startsWith(key.toLowerCase()));
        const [only] = hits;
        if (hits.length === 1 && only) {
          index = choices.indexOf(only);
          return true;
        }
        return false; // unknown key: no redraw, nothing moved
      }

      out.write(up(rows));
      draw();
      return false;
    });
  } finally {
    out.write(SHOW_CURSOR);
  }

  // Collapse question + list back into one settled line. A transcript should
  // record the answer, not the menu it came from.
  out.write(up(rows + 1));
  out.write((CLEAR_LINE + '\n').repeat(rows + 1));
  out.write(up(rows + 1));
  out.write(`  ${lime(sym.ok)} ${dim(question)} ${bold(pick(index).label)}\n`);

  return pick(index).value;
}

/**
 * y/n. On a TTY this takes a single keypress — no Enter — because the answer
 * is one character and demanding a terminator after it is pure ceremony.
 * Enter alone still picks the capitalised default, which is the convention
 * `[Y/n]` has always promised.
 */
export async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';

  if (!interactive()) {
    const answer = (await promptText(`${question} ${suffix} `)).toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  }

  let result = defaultYes;
  process.stdout.write(`${question} ${dim(suffix)} `);
  await readKeys((key) => {
    if (key === '\r' || key === '\n') return true;
    const lower = key.toLowerCase();
    if (lower === 'y' || lower === 'n') {
      result = lower === 'y';
      return true;
    }
    return false; // anything else: keep waiting rather than guessing
  });
  // Echo the answer — a keypress leaves no trace otherwise, and the
  // scrollback has to show what the user actually said.
  process.stdout.write(`${lime(result ? 'yes' : 'no')}\n`);
  return result;
}

/**
 * Reads a line without ever writing it back to stdout. On a TTY, keystrokes
 * are masked as `*`. On a non-TTY (piped) stdin — no terminal to mask — the
 * line is still never echoed by this function (the value itself is only
 * ever returned in memory, never logged).
 */
export function promptSecret(question: string): Promise<string> {
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

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === CTRL_C) {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (BACKSPACE.includes(ch)) {
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
