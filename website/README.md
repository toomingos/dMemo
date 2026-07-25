# dMemo website

The one-page marketing site for dMemo.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

## How this fits into the monorepo

This app is **deliberately not a pnpm workspace member**. `pnpm-workspace.yaml`
globs `packages/*` only, so root `pnpm install --frozen-lockfile`, `pnpm build`
and `pnpm test` — and therefore CI — never see it. It has its own
`package-lock.json` and is installed with npm from inside this directory.

Because of that split, Turbopack's lockfile-based root detection walks past the
repo and finds an unrelated lockfile further up, so `turbopack.root` is pinned
in `next.config.ts`. Don't remove it.

Deploying on Vercel: set the project root directory to `website`.

## Stack

- Next.js 16 (App Router, Turbopack) + React 19 + Tailwind v4
- shadcn/ui, `base-nova` style, preset `b3QvsS26a` (neutral base, lime accent),
  built on Base UI — components take a `render` prop, not `asChild`
- Icons: `@hugeicons/react` + `@hugeicons/core-free-icons`, per the preset

## Typography

Geist Pixel Square is the only typeface, backing `--font-sans`, `--font-heading`
and `--font-mono` alike (see `app/globals.css`).

The font is vendored into `app/fonts/` rather than imported from the `geist`
package: that package's `font/pixel` module instantiates all five pixel faces,
so importing it makes Next preload ~112 KB of Circle/Grid/Line/Triangle that
never render. It ships as a single static weight (500), not a variable font.
`app/fonts/GeistPixel-LICENSE.txt` is the SIL Open Font License it comes under
and must stay alongside the `.woff2`.

To update the font, `npm pack geist`, and copy
`dist/fonts/geist-pixel/GeistPixel-Square.woff2` plus `LICENSE.txt` over.

## Theme

Dark by default and system preference is off (`app/layout.tsx`), since the
design is drawn for the dark palette. The light tokens still work and `d`
toggles between them — that hotkey ships in `components/theme-provider.tsx`.

## Content

Links and the install command live in `lib/site.ts`. dMemo's own pixel
wordmark is `components/pixel-mark.tsx`.

`components/agent-logos.tsx` holds the five agent marks and the `AGENTS` list
that both the hero row and the Agents card read from. They are the real vendor
marks, taken from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT) and
compressed with svgo — inlined rather than installed, so the page ships five
logos instead of the package's several hundred. Every path inherits
`currentColor`, which is what lets the whole row tint as one.

The trademarks belong to their owners; they appear here referentially, to say
which agents dMemo works with. Two things to know before touching them:

- **Hermes** is Nous Research's character mark — fine linework, 18 KB, and by
  far the largest asset on the page. It is legible in the hero's 56px tiles and
  would not be much smaller. If page weight ever matters more than showing the
  real mark, that is the one to drop.
- The marks differ enormously in density (Claude Code's is eight solid blocks,
  Hermes' is a portrait). The uniform tiles and single tint in the hero are
  what hold them together as a set — don't remove the frame.
