#!/usr/bin/env node
// npm sets the executable bit on `bin` entries at install time from the
// registry, but local dev (`node ./dist/cli.js`, `pnpm link`, `npm pack`
// inspection) benefits from the bit being set in the build output directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');
if (fs.existsSync(cliPath)) {
  fs.chmodSync(cliPath, 0o755);
}
