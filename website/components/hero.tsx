import { ArrowRight01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { AGENTS } from "@/components/agent-logos"
import { InstallCommand } from "@/components/install-command"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DOCS_URL } from "@/lib/site"

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 grid-backdrop opacity-40 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
        aria-hidden="true"
      />

      <div className="relative mx-auto w-full max-w-5xl px-6 pt-20 pb-16 text-center sm:pt-28 sm:pb-24">
        <Badge variant="outline" className="mb-8 gap-2">
          <span className="size-1.5 rounded-full bg-primary" />
          Open source · MIT
        </Badge>

        <h1 className="font-heading mx-auto max-w-3xl text-4xl leading-[1.15] font-medium tracking-tight text-balance sm:text-5xl md:text-6xl">
          Private Memory for Private Agents
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-sm text-balance text-muted-foreground sm:text-base">
          Plug-and-play agent memory on decentralized, sovereign and encrypted
          cloud.
        </p>

        {/* The five marks differ wildly in density — Claude Code's is eight
            solid blocks, Hermes' is fine linework — so each gets an identical
            tile and a single tint. The frame is what makes the row read as a
            set rather than five logos pasted in a line. */}
        {/* Sized down on phones so all five stay on one line — the row is the
            claim, and it stops being one the moment the last agent wraps onto
            a line by itself. "CLAUDE CODE" is the label that sets the floor. */}
        <ul className="mt-14 flex flex-wrap items-start justify-center gap-x-3 gap-y-6 sm:gap-x-10">
          {AGENTS.map(({ name, Mark }) => (
            <li key={name} className="group flex flex-col items-center gap-3">
              <span className="grid size-12 place-items-center rounded-xl bg-card text-muted-foreground ring-1 ring-foreground/10 transition-colors group-hover:text-primary group-hover:ring-primary/30 sm:size-14">
                <Mark className="size-6 sm:size-7" />
              </span>
              <span className="text-[10px] tracking-wider whitespace-nowrap text-muted-foreground uppercase sm:text-[11px]">
                {name}
              </span>
            </li>
          ))}
        </ul>

        <div className="mx-auto mt-14 max-w-xl">
          <InstallCommand />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="mt-6 text-muted-foreground"
          render={<a href={DOCS_URL} target="_blank" rel="noreferrer noopener" />}
        >
          Read the docs
          <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
        </Button>
      </div>
    </section>
  )
}
