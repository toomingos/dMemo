"use client"

import * as React from "react"
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import { INSTALL_COMMAND } from "@/lib/site"

const OUTPUT = [
  "wallet created — the only key that can decrypt your memory",
  "storage connected — encrypted, yours, off this machine",
  "adapters installed — every agent we found on this box",
]

export function InstallCommand() {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) {
      return
    }

    const timeout = setTimeout(() => setCopied(false), 2000)

    return () => clearTimeout(timeout)
  }, [copied])

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND)
      setCopied(true)
    } catch {
      // Clipboard is unavailable (insecure origin, denied permission) — the
      // command is selectable text either way, so there is nothing to recover.
    }
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card text-left ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
        </div>
        <span className="text-xs tracking-wider text-muted-foreground">
          terminal
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto -mr-1.5"
          onClick={onCopy}
          aria-label={copied ? "Command copied" : "Copy install command"}
        >
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            className={copied ? "text-primary" : undefined}
          />
        </Button>
      </div>

      <div className="px-4 py-4 sm:px-5 sm:py-5">
        <p className="text-sm sm:text-base">
          <span className="text-primary">$</span>{" "}
          <span className="select-all">{INSTALL_COMMAND}</span>
          <span className="ml-0.5 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-primary" />
        </p>

        <ul className="mt-4 space-y-1.5 text-xs text-muted-foreground sm:text-sm">
          {OUTPUT.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-primary">✓</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
