// T4.1 step 4: detect which coding-agent hosts are present on this machine.
// Detection is best-effort and side-effect-free (no writes) — installers
// decide what to do with a positive detection. Every check honors the same
// env overrides the rest of this CLI uses for sandboxed testing (HOME,
// CODEX_HOME, XDG_CONFIG_HOME) so a throwaway-HOME test run never touches a
// real dotfile.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface HostDetection {
  claudeCode: boolean;
  codex: boolean;
  opencode: boolean;
  openclaw: boolean;
}

function onPath(bin: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function homedir(env: NodeJS.ProcessEnv): string {
  // `os.homedir()` reads $HOME on POSIX / %USERPROFILE% on Windows, so
  // setting `env.HOME` before invoking this CLI (or importing this module
  // in tests) is sufficient — no separate override plumbing needed. We
  // still accept `env` explicitly (rather than reading `process.env`
  // directly) so unit tests can pass a synthetic env without mutating the
  // real process-wide `process.env`.
  return env.HOME ?? os.homedir();
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(homedir(env), '.codex');
}

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homedir(env), '.claude');
}

export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(env), '.config'), 'opencode');
}

export function opencodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opencodeConfigDir(env), 'opencode.json');
}

export function openclawHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homedir(env), '.openclaw');
}

export function detectHosts(env: NodeJS.ProcessEnv = process.env): HostDetection {
  return {
    claudeCode: onPath('claude') || fs.existsSync(claudeHome(env)),
    codex: onPath('codex') || fs.existsSync(codexHome(env)),
    opencode: onPath('opencode') || fs.existsSync(opencodeConfigDir(env)),
    openclaw: onPath('openclaw') || fs.existsSync(openclawHome(env)),
  };
}
