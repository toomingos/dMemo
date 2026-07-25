import {
  ArrowRight01Icon,
  LockIcon,
  SourceCodeIcon,
  TerminalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { AGENT_NAMES } from "@/components/agent-logos"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const STEPS = ["Install", "Fund your wallet", "Connect your private storage"]

/* Cards default to a 16px gutter, which is right for dense app UI and too tight
   for a marketing bento. `--card-spacing` is the knob the card exposes for
   exactly this, and it drives the padding of every slot at once. */
const CARD = "[--card-spacing:--spacing(6)]"

function CardEyebrow({
  icon,
  label,
}: {
  icon: typeof LockIcon
  label: string
}) {
  return (
    <div className="flex items-center gap-2 px-(--card-spacing) text-muted-foreground">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        <HugeiconsIcon icon={icon} className="size-3.5" />
      </span>
      <span className="text-[11px] tracking-wider uppercase">{label}</span>
    </div>
  )
}

export function Bento() {
  return (
    <section className="mx-auto w-full max-w-5xl px-6 pb-24 sm:pb-32">
      <div className="mb-10 sm:mb-14">
        <h2 className="font-heading text-2xl font-medium tracking-tight sm:text-3xl">
          How it works
        </h2>
        <p className="mt-3 max-w-lg text-sm text-muted-foreground">
          Install and plug in to your favorite coding or personal agent in one
          copy and paste.
        </p>
      </div>

      {/* Two rows of 4/2 and 2/4. The intermediate 2-column step matters: going
          straight from stacked to six columns leaves the narrow cards ~230px
          wide on a tablet, which shreds their titles across four lines. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <Card className={`${CARD} sm:col-span-2 lg:col-span-4`}>
          <CardEyebrow icon={TerminalIcon} label="Agents" />
          <CardHeader className="gap-2">
            <CardTitle className="text-lg sm:text-xl">
              Works with the agents you already use
            </CardTitle>
          </CardHeader>
          <CardContent className="mt-auto">
            {/* The names are the proof behind the title, so they outrank the
                description. Each separator trails its own name rather than
                leading the next one: on a narrow card the list wraps, and a
                trailing "·" ends a line naturally where a leading one would
                dangle at the start of the next. */}
            <ul className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
              {AGENT_NAMES.map((name, index) => (
                <li key={name} className="flex items-center gap-2">
                  {name}
                  {index < AGENT_NAMES.length - 1 && (
                    <span aria-hidden="true" className="text-muted-foreground/40">
                      ·
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <CardDescription className="mt-5">
              Memory works in the background automatically. No workflow changes.
            </CardDescription>
          </CardContent>
        </Card>

        <Card className={`${CARD} lg:col-span-2`}>
          <CardEyebrow icon={LockIcon} label="Privacy" />
          {/* These two carry a third of the copy of their row-mates but are
              stretched to match their height. Centring the block splits the
              leftover space above and below, so it reads as padding rather
              than as a hole punched under the eyebrow. */}
          <CardHeader className="my-auto gap-2">
            <CardTitle className="text-lg">
              Your memory never stays on the machine
            </CardTitle>
            <CardDescription>
              Loaded when needed, used and discarded.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card className={`${CARD} lg:col-span-2`}>
          <CardEyebrow icon={SourceCodeIcon} label="Open Source" />
          <CardHeader className="my-auto gap-2">
            <CardTitle className="text-lg">Fully open source</CardTitle>
            <CardDescription>
              Built in the open. No black boxes. No lock-in.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card className={`${CARD} sm:col-span-2 lg:col-span-4`}>
          <CardEyebrow icon={Tick02Icon} label="Simplicity" />
          <CardHeader className="gap-2">
            <CardTitle className="text-lg sm:text-xl">
              Three steps. Done.
            </CardTitle>
          </CardHeader>
          <CardContent className="mt-auto">
            {/* Laid across the card rather than down it — three short steps
                stacked in a four-column-wide card leave most of the width
                empty, and the rules turn the count into the visual rhythm. */}
            <ol className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step} className="border-t border-border pt-3">
                  <span className="block text-xs text-primary">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="mt-1.5 block">{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 flex items-center gap-2 text-primary">
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
              Your agents start remembering
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
