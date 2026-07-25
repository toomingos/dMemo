import { cn } from "@/lib/utils"

/**
 * dMemo's own mark: a 4x4 checkerboard drawn on the same pixel grid as Geist
 * Pixel Square, so it sits flush against the wordmark beside it.
 *
 * The agents dMemo plugs into use their real vendor marks — see agent-logos.tsx.
 */
const LOGO = ["##..", "##..", "..##", "..##"]

export function PixelMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${LOGO.length} ${LOGO.length}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      className={cn("size-8", className)}
    >
      {LOGO.map((row, y) =>
        row
          .split("")
          .map((cell, x) =>
            cell === "#" ? (
              <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
            ) : null
          )
      )}
    </svg>
  )
}
