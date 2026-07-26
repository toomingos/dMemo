// The visual language shared by every page this CLI serves on loopback.
//
// WHY THIS EXISTS. `connect` and `fund` each carried their own ~80-line
// <style> block, both of them a generic indigo-on-white admin form that had
// nothing to do with dmemo.ai. A user runs `npx @dmemo/cli setup` off the
// website and lands on a page that looks like it belongs to a different
// product — which, at the exact moment they are being asked to approve a
// wallet transaction, is the worst possible time to look unfamiliar.
//
// So the tokens below are lifted from `website/app/globals.css`, not
// approximated: same lime `--primary`, same neutral ramp, same 0.625rem
// radius, same 48px pixel grid, same Geist Pixel Square face. The two CLI
// pages and the marketing site now read as one product.
//
// The oklch() values the site uses are converted to sRGB hex here on purpose.
// This page renders in whatever browser the user has set as default, possibly
// an old one, and a page that fails to parse its own colours is a page with
// unreadable text over a transparent background. Hex has no such floor.
//
// DEGRADATION. The font is embedded as a data: URI (28 KB, OFL-1.1, vendored
// at `assets/` with its licence) because the pages must not make external
// requests — see `connect/page.ts`'s header. If that asset is missing from
// the install for any reason, `fontFace()` returns nothing and the stack
// falls through to the platform's monospace face; nothing else changes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** This file builds to `dist/web/theme.js`; assets ship at `<pkg>/assets/`. */
const FONT_FILE = 'GeistPixel-Square.woff2';

let cachedFontFace: string | null | undefined;

/**
 * `@font-face` for the site's typeface, inlined. Empty string when the asset
 * is unavailable — every rule below names fallbacks, so an empty return
 * degrades to a plain monospace page rather than a broken one.
 */
export function fontFace(): string {
  if (cachedFontFace !== undefined) return cachedFontFace ?? '';
  try {
    const file = path.resolve(__dirname, '..', '..', 'assets', FONT_FILE);
    const base64 = fs.readFileSync(file).toString('base64');
    cachedFontFace =
      '@font-face{font-family:"Geist Pixel Square";' +
      `src:url("data:font/woff2;base64,${base64}") format("woff2");` +
      'font-weight:500;font-style:normal;font-display:swap}';
  } catch {
    cachedFontFace = null;
  }
  return cachedFontFace ?? '';
}

/**
 * Dark-only, deliberately. The site sets `defaultTheme="dark"`
 * `enableSystem={false}` — it has exactly one look, so a CLI page that
 * flipped to a light theme on a light-mode machine would match the site on
 * half of all machines and nothing on the other half.
 */
export const BASE_CSS = `
:root{
  color-scheme:dark;
  --bg:#0a0a0a;          /* oklch(.145 0 0)  background */
  --fg:#fafafa;          /* oklch(.985 0 0)  foreground */
  --card:#171717;        /* oklch(.205 0 0)  card */
  --muted:#a1a1a1;       /* oklch(.708 0 0)  muted-foreground */
  --line:rgba(255,255,255,.10);        /* border */
  --line-strong:rgba(255,255,255,.18);
  --primary:#a3e635;     /* oklch(.768 .233 130.85) */
  --primary-dim:rgba(163,230,53,.30);
  --primary-fade:rgba(163,230,53,.10);
  --primary-fg:#1a2e05;
  --err:#f87171;
  --warn:#fbbf24;
  --radius:.625rem;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100vh;background:var(--bg);color:var(--fg);
  font-family:"Geist Pixel Square",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  /* A pixel face carries more weight per glyph than a text face; the extra
     leading and tracking are what keep it readable at body sizes. Same
     reasoning, same numbers as globals.css. */
  font-size:15px;line-height:1.6;letter-spacing:.01em;
  -webkit-font-smoothing:antialiased;
}
/* The site's faint pixel grid, masked to a glow behind the header. */
body::before{
  content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.4;
  background-image:
    linear-gradient(to right,var(--line) 1px,transparent 1px),
    linear-gradient(to bottom,var(--line) 1px,transparent 1px);
  background-size:48px 48px;
  -webkit-mask-image:radial-gradient(ellipse 60% 50% at 50% 0%,#000,transparent);
  mask-image:radial-gradient(ellipse 60% 50% at 50% 0%,#000,transparent);
}

/* ---- chrome ------------------------------------------------------------ */
header.bar{
  position:relative;z-index:1;border-bottom:1px solid var(--line);
  background:rgba(10,10,10,.8);backdrop-filter:blur(12px);
}
header.bar .inner{
  margin:0 auto;max-width:44rem;height:3.5rem;padding:0 1.25rem;
  display:flex;align-items:center;gap:.65rem;
}
header.bar .brand{display:flex;align-items:center;gap:.6rem;font-size:.875rem;letter-spacing:-.01em}
.mark{width:.875rem;height:.875rem;color:var(--primary);flex:0 0 auto}
.badge{
  margin-left:auto;display:inline-flex;align-items:center;gap:.45rem;
  border:1px solid var(--line);border-radius:999px;padding:.2rem .6rem;
  font-size:.6875rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
}
.badge .dot{width:.375rem;height:.375rem;border-radius:999px;background:var(--primary)}

main{position:relative;z-index:1;margin:0 auto;max-width:44rem;padding:3rem 1.25rem 4rem}
h1{font-size:1.5rem;line-height:1.25;letter-spacing:-.02em;font-weight:500;margin:0 0 .6rem}
.sub{color:var(--muted);margin:0 0 2rem;font-size:.875rem;max-width:34rem}
.eyebrow{
  display:flex;align-items:center;gap:.5rem;color:var(--muted);
  font-size:.6875rem;letter-spacing:.08em;text-transform:uppercase;margin:0 0 .75rem;
}
.eyebrow .tile{
  display:grid;place-items:center;width:1.5rem;height:1.5rem;border-radius:.375rem;
  background:var(--primary-fade);color:var(--primary);font-size:.75rem;
}

/* ---- surfaces ---------------------------------------------------------- */
.panel{
  background:var(--card);border-radius:var(--radius);
  box-shadow:inset 0 0 0 1px var(--line);padding:1.25rem;
}
.note{font-size:.8125rem;color:var(--muted);margin-top:.85rem}
.note:first-child{margin-top:0}
code{font-family:inherit;color:var(--primary)}

/* The terminal frame from the site's hero, reused wherever this page has to
   show a value the user may need to read character by character. */
.termbox{
  border-radius:var(--radius);background:var(--bg);
  box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;
}
.termbox .top{
  display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;
  border-bottom:1px solid var(--line);
}
.termbox .lights{display:flex;gap:.35rem}
.termbox .lights i{width:.5rem;height:.5rem;border-radius:999px;background:rgba(255,255,255,.15)}
.termbox .label{font-size:.6875rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.termbox .val{padding:.7rem .75rem;font-size:.8125rem;word-break:break-all;letter-spacing:.02em}
.termbox .val .amount{color:var(--primary)}

/* ---- controls ---------------------------------------------------------- */
button{
  font:inherit;letter-spacing:inherit;cursor:pointer;width:100%;text-align:left;
  display:flex;align-items:center;gap:.7rem;padding:.8rem .9rem;
  border:0;border-radius:var(--radius);background:transparent;color:var(--fg);
  box-shadow:inset 0 0 0 1px var(--line);
  transition:box-shadow .15s ease,color .15s ease,background .15s ease;
}
button:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--primary-dim)}
button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
button:disabled{opacity:.5;cursor:default}
button.primary{
  background:var(--primary);color:var(--primary-fg);box-shadow:none;justify-content:center;
}
button.primary:hover:not(:disabled){background:#b7ef5c;box-shadow:none}
button.ghost{box-shadow:none;color:var(--muted);justify-content:center;font-size:.8125rem}
button.ghost:hover:not(:disabled){box-shadow:none;color:var(--fg)}
button img{width:1.5rem;height:1.5rem;border-radius:.3rem;flex:0 0 auto}
button .arrow{margin-left:auto;color:var(--muted);transition:color .15s ease}
button:hover:not(:disabled) .arrow{color:var(--primary)}
.stack{display:grid;gap:.55rem}
.stack.tight{gap:.4rem}
.options button{flex-direction:column;align-items:flex-start;gap:.2rem;position:relative}
.options button .t{display:block}
.options button .d{display:block;font-size:.8125rem;color:var(--muted);padding-right:1.25rem}
.options button .arrow{position:absolute;right:.9rem;top:.85rem;margin:0}
.back{
  width:auto;padding:.3rem .6rem;font-size:.8125rem;color:var(--muted);
  box-shadow:none;margin-bottom:.85rem;
}
.back:hover:not(:disabled){box-shadow:none;color:var(--fg)}
a{color:var(--primary);text-underline-offset:.2em}
a:focus-visible{outline:2px solid var(--primary);outline-offset:2px}

/* ---- numbered steps (the bento "01 / 02 / 03" rhythm) ------------------- */
ol.steps{list-style:none;display:grid;gap:.75rem;margin:0 0 1.5rem;padding:0}
@media (min-width:34rem){ol.steps{grid-template-columns:repeat(4,1fr);gap:1rem}}
ol.steps li{border-top:1px solid var(--line);padding-top:.6rem;color:var(--muted);font-size:.8125rem}
ol.steps li .n{display:block;font-size:.6875rem;color:var(--muted);margin-bottom:.3rem}
ol.steps li[data-state="active"]{border-top-color:var(--primary);color:var(--fg)}
ol.steps li[data-state="active"] .n{color:var(--primary)}
ol.steps li[data-state="done"]{border-top-color:var(--primary-dim);color:var(--fg)}
ol.steps li[data-state="done"] .n{color:var(--primary)}

/* ---- status ------------------------------------------------------------ */
.msg{margin-top:1.25rem;font-size:.875rem;min-height:1.4em;color:var(--muted)}
.msg.err{color:var(--err)}
.msg.ok{color:var(--primary)}
.msg.warn{color:var(--warn)}
/* The site's blinking block cursor, doing the job a spinner would. It says
   "still working" without implying a measurable percentage. */
.cursor{
  display:inline-block;width:.5rem;height:1em;background:var(--primary);
  vertical-align:-.15em;margin-right:.5rem;animation:blink 1s steps(2,start) infinite;
}
@keyframes blink{50%{opacity:.25}}
.done{display:flex;align-items:center;gap:.6rem}
.done .tick{color:var(--primary)}
iframe{
  width:100%;height:34rem;border:0;border-radius:var(--radius);
  box-shadow:inset 0 0 0 1px var(--line);background:var(--bg);display:block;
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  .cursor{animation:none}
}
`;

/** The 4x4 checkerboard from `website/components/pixel-mark.tsx`, inlined. */
const PIXEL_MARK =
  '<svg class="mark" viewBox="0 0 4 4" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">' +
  '<rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg>';

export interface ShellOptions {
  /** Browser tab title. */
  title: string;
  /** Uppercase pill in the top-right, naming the command that opened this. */
  badge: string;
  heading: string;
  /** One-sentence explanation under the heading. Plain text, escaped by
   * the caller when it interpolates anything. */
  sub: string;
  /** Everything between the sub-heading and the status line. */
  body: string;
  /** The page's own `<script>` contents, without the tag. */
  script: string;
  /** Appended after BASE_CSS for page-specific rules. */
  css?: string;
}

/**
 * One document skeleton for both pages, so a change to the chrome cannot land
 * on `fund` and miss `connect` (which is exactly how the two <style> blocks
 * this replaces drifted apart in the first place).
 */
export function renderShell(opts: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>${opts.title}</title>
<style>${fontFace()}${BASE_CSS}${opts.css ?? ''}</style>
</head>
<body>
<header class="bar">
  <div class="inner">
    <span class="brand">${PIXEL_MARK}dMemo</span>
    <span class="badge"><span class="dot"></span>${opts.badge}</span>
  </div>
</header>
<main>
  <h1>${opts.heading}</h1>
  <p class="sub">${opts.sub}</p>
${opts.body}
  <div class="msg" id="msg" role="status" aria-live="polite"></div>
</main>
<script>
${opts.script}
</script>
</body>
</html>
`;
}

/**
 * The DOM helpers both page scripts need, as a string of ES5 (these pages
 * ship unbundled and untranspiled, so they target the oldest browser a user
 * might have set as default).
 *
 * Shared for the same reason `renderShell` is: `say()`/`busy()` are how every
 * state in both flows is announced, and two copies would eventually disagree
 * about what "busy" looks like.
 */
export const SHARED_SCRIPT = `
  var msgEl = document.getElementById("msg");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function say(text, kind) {
    msgEl.className = "msg" + (kind ? " " + kind : "");
    msgEl.textContent = text || "";
  }

  function busy(text) {
    msgEl.className = "msg";
    msgEl.innerHTML = '<span class="cursor"></span>';
    msgEl.appendChild(document.createTextNode(text));
  }

  /** A read-only value in the site's terminal frame. */
  function termbox(label, value, valueClass) {
    var box = el("div", "termbox");
    var top = el("div", "top");
    var lights = el("div", "lights");
    lights.appendChild(el("i"));
    lights.appendChild(el("i"));
    lights.appendChild(el("i"));
    top.appendChild(lights);
    top.appendChild(el("span", "label", label));
    box.appendChild(top);
    var val = el("div", "val");
    var inner = el("span", valueClass || null, value);
    val.appendChild(inner);
    box.appendChild(val);
    box.valueEl = inner;
    return box;
  }

  function arrow() {
    return el("span", "arrow", "\\u2192");
  }
`;
