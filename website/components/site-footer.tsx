import { PixelMark } from "@/components/pixel-mark"
import { DOCS_URL, NPM_URL, REPO_URL } from "@/lib/site"

const LINKS = [
  { label: "GitHub", href: REPO_URL },
  { label: "Docs", href: DOCS_URL },
  { label: "npm", href: NPM_URL },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5">
          <PixelMark className="size-3 text-primary" />
          <span className="text-xs text-muted-foreground">
            dMemo — MIT licensed
          </span>
        </div>

        <nav className="flex items-center gap-5 sm:ml-auto">
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  )
}
