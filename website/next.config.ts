import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // This app lives inside the dMemo monorepo but is not a pnpm workspace
  // member, so Turbopack's lockfile-based root detection walks past the repo
  // and picks up an unrelated lockfile in the home directory. Pin it here.
  turbopack: {
    root: import.meta.dirname,
  },
}

export default nextConfig
