import Link from "next/link"
import { GithubIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PixelMark } from "@/components/pixel-mark"
import { Button } from "@/components/ui/button"
import { DOCS_URL, REPO_URL } from "@/lib/site"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <PixelMark className="size-3.5 text-primary" />
          <span className="text-sm font-medium tracking-tight">dMemo</span>
        </Link>

        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" render={<a href={DOCS_URL} />}>
            Docs
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="dMemo on GitHub"
            render={
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener" />
            }
          >
            <HugeiconsIcon icon={GithubIcon} />
          </Button>
        </div>
      </div>
    </header>
  )
}
