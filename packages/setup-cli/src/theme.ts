// Presentation primitives: colour, glyphs, and width-aware layout.
//
// Ground rule 1 (native functions only) rules out chalk/picocolors, and the
// whole surface is small enough that a dependency would cost more than it
// saves — this file has no imports beyond `node:os`.
//
// EVERYTHING DEGRADES, and that is the point. Colour is off unless stdout is
// a TTY that asked for it; the glyph set falls back to ASCII on a non-UTF-8
// locale; every width is clamped so a 300-column terminal does not emit a
// 300-column rule. `dmemo setup > install.log` and a CI job therefore get
// exactly the plain text this CLI has always produced.
//
// Nothing here is memoised on purpose. The checks are a few string compares,
// and reading the environment on every call is what lets a test flip
// FORCE_COLOR or COLUMNS between cases without reloading the module.

import os from 'node:os';

type Paint = (text: string) => string;

const IDENTITY: Paint = (text) => text;

/** Colour depth: 0 = none, 1 = basic 16, 2 = 256, 3 = truecolor. */
function depth(env: NodeJS.ProcessEnv = process.env): number {
  // no-color.org's contract: any non-empty NO_COLOR disables colour, and
  // FORCE_COLOR is the escape hatch that overrides it (matching the
  // convention npm, node itself, and most of the ecosystem already follow).
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0' && force !== 'false') {
    return terminalDepth(env) || 1;
  }
  if (env.NO_COLOR) return 0;
  if (env.TERM === 'dumb') return 0;
  if (!process.stdout.isTTY) return 0;
  return terminalDepth(env) || 1;
}

/** What the terminal claims it can render, ignoring whether we want it to. */
function terminalDepth(env: NodeJS.ProcessEnv): number {
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  if ((env.TERM ?? '').includes('256')) return 2;
  // Windows Terminal, VS Code's integrated terminal and Terminal.app all
  // handle 256 colours without advertising it through TERM.
  if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'Apple_Terminal') {
    return 2;
  }
  return 0;
}

/**
 * Builds a painter from one SGR sequence per depth. `basic` is the floor: a
 * terminal that reports colour support at all can render the 16 ANSI colours.
 */
function paint(truecolor: string, xterm256: string, basic: string): Paint {
  return (text) => {
    const d = depth();
    if (d === 0) return text;
    const open = d >= 3 ? truecolor : d === 2 ? xterm256 : basic;
    return `\x1b[${open}m${text}\x1b[0m`;
  };
}

// Lime is the site's `--primary`, oklch(0.841 0.238 128.85) — the same
// chartreuse the hero paints its `$` and checkmarks with. #a3e635 is that
// colour in sRGB; xterm 155 (#afff5f) is its nearest cube neighbour.
export const lime: Paint = paint('38;2;163;230;53', '38;5;155', '32');
export const red: Paint = paint('38;2;239;68;68', '38;5;203', '31');
export const amber: Paint = paint('38;2;245;158;11', '38;5;214', '33');

export const dim: Paint = (text) => (depth() === 0 ? text : `\x1b[2m${text}\x1b[0m`);
export const bold: Paint = (text) => (depth() === 0 ? text : `\x1b[1m${text}\x1b[0m`);

/** True when the terminal can be trusted with the box-drawing/tick glyphs. */
export function unicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DMEMO_ASCII) return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/utf-?8/i.test(locale)) return true;
  // Windows has no locale env vars to read, so go by the terminal instead:
  // Windows Terminal and VS Code render these fine, conhost historically
  // does not.
  if (process.platform === 'win32') return Boolean(env.WT_SESSION || env.TERM_PROGRAM);
  // A bare `LANG=C` or an empty environment is the ambiguous case. Terminal
  // emulators have defaulted to UTF-8 for over a decade, so assume it — but
  // only when we are actually attached to one.
  return Boolean(process.stdout.isTTY);
}

export interface Symbols {
  ok: string;
  bad: string;
  skip: string;
  mark: string;
  rule: string;
  bullet: string;
}

const UNICODE_SYMBOLS: Symbols = { ok: '✓', bad: '✗', skip: '○', mark: '▪', rule: '─', bullet: '·' };
const ASCII_SYMBOLS: Symbols = { ok: '[ok]', bad: '[!!]', skip: '[ ]', mark: '*', rule: '-', bullet: '-' };

export function symbols(env: NodeJS.ProcessEnv = process.env): Symbols {
  return unicode(env) ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
}

/**
 * Usable line width. Clamped at 80 because prose set much wider stops being
 * scannable, and floored at 40 so a narrow split pane degrades to something
 * cramped rather than something negative.
 */
export function width(): number {
  const columns = process.stdout.columns;
  if (!columns || !Number.isFinite(columns)) return 80;
  return Math.max(40, Math.min(columns, 80));
}

/**
 * `── 2/5 Config ─────────────────────────`
 *
 * The counter is the fix for a run that otherwise gives no indication of how
 * much is left, and the rule gives the eye somewhere to rest between steps.
 */
export function step(n: number, total: number, title: string): string {
  const sym = symbols();
  const lead = sym.rule.repeat(2);
  const counter = `${n}/${total}`;
  const head = `${lead} ${counter} ${title} `;
  const fill = Math.max(0, width() - head.length);
  return `${dim(lead)} ${bold(counter)} ${dim(title)} ${dim(sym.rule.repeat(fill))}`;
}

/** The closing rule, which reads as an outcome rather than another step. */
export function outcome(title: string, detail: string): string {
  const sym = symbols();
  const lead = sym.rule.repeat(2);
  const head = `${lead} ${title}  ${sym.bullet}  ${detail}`;
  const fill = Math.max(0, width() - head.length - 1);
  return `${lime(lead)} ${lime(title)}  ${dim(sym.bullet)}  ${dim(detail)} ${dim(sym.rule.repeat(fill))}`;
}

/** A result line: `  ✓ claude-code   plugin installed`. */
export function status(kind: 'ok' | 'bad' | 'skip', text: string, detail?: string): string {
  const sym = symbols();
  const glyph = kind === 'ok' ? lime(sym.ok) : kind === 'bad' ? red(sym.bad) : dim(sym.skip);
  // `text` is often column-padded so a run of hosts lines up. That padding is
  // only worth carrying when something follows it.
  const body = detail ? `${text} ${dim(detail)}` : text.trimEnd();
  return `  ${glyph} ${body}`;
}

/**
 * Greedy word wrap at the current terminal width. Replaces the hand-split
 * `log()` calls that were hard-coded to roughly 72 columns and so wrapped
 * twice on a narrow terminal and left a ragged column on a wide one.
 *
 * Existing newlines are preserved as paragraph breaks — callers that already
 * shaped their copy deliberately keep that shape.
 */
export function wrap(text: string, indent = 0): string {
  const limit = Math.max(20, width() - indent);
  const pad = ' '.repeat(indent);

  return text
    .split('\n')
    .map((paragraph) => {
      if (!paragraph.trim()) return '';
      const lines: string[] = [];
      let current = '';
      for (const word of paragraph.trim().split(/\s+/)) {
        if (!current) current = word;
        else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines.map((line) => pad + line).join('\n');
    })
    .join('\n');
}

/**
 * Indents text that already has the shape it wants — a numbered procedure, a
 * pasteable command block — without reflowing it. `wrap()` is for prose;
 * this is for everything whose existing line breaks carry meaning.
 */
export function indent(text: string, spaces = 4): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() ? pad + line : ''))
    .join('\n');
}

/**
 * `/Users/you/.dmemo/config.json` -> `~/.dmemo/config.json`.
 *
 * Shorter, stops wrapping across three lines on an 80-column terminal, and
 * matches the form the surrounding copy already uses.
 */
export function tildify(target: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (!home || !target.startsWith(home)) return target;
  const rest = target.slice(home.length);
  if (rest && rest[0] !== '/' && rest[0] !== '\\') return target;
  return `~${rest}`;
}

/** `0xe797a820763595BD5759B1345a2f9F04409eb16D` -> `0xe797a820…09eb16D`. */
export function shortAddress(address: string): string {
  if (!address || address.length <= 20) return address;
  return `${address.slice(0, 10)}${unicode() ? '…' : '...'}${address.slice(-7)}`;
}
