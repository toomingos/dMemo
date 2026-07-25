import type { Metadata } from "next"
import localFont from "next/font/local"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils"

// Vendored from the `geist` package rather than imported from it: that module
// instantiates all five pixel faces, so importing it preloads ~112 KB of
// Circle/Grid/Line/Triangle we never render. See app/fonts/GeistPixel-LICENSE.txt.
const geistPixelSquare = localFont({
  src: "./fonts/GeistPixel-Square.woff2",
  variable: "--font-geist-pixel-square",
  display: "swap",
  // Geist Pixel Square ships as a single static face, not a variable font.
  weight: "500",
})

export const metadata: Metadata = {
  title: "dMemo — Private Memory for Private Agents",
  description:
    "Plug-and-play agent memory on decentralized, sovereign and encrypted cloud.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", geistPixelSquare.variable, "font-sans")}
    >
      <body>
        <ThemeProvider defaultTheme="dark" enableSystem={false}>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
