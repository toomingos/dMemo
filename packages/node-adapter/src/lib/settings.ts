// Config/settings resolution for the Node adapter hooks. Ported pattern from
// claude-supermemory's src/lib/settings.js (loadSettings/debugLog) merged
// with dMemo's env-first config surface (@dmemo/core's loadConfigFromEnv,
// T1.6). Every hook calls `loadHookSettings()` first and fails open
// (skip silently, exit 0) if it throws or returns `configured: false` —
// there is no dMemo wallet configured yet is a normal, expected state.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DMEMO_HOME = process.env.DMEMO_HOME ?? path.join(os.homedir(), '.dmemo');
export const DMEMO_CONFIG_PATH = path.join(DMEMO_HOME, 'config.json');
export const DMEMO_NATIVE_DIR = path.join(DMEMO_HOME, 'native');
export const DMEMO_LOG_PATH = path.join(DMEMO_HOME, 'hooks.log');

/**
 * `~/.dmemo/config.json` (written by `npx @dmemo/cli setup`, T4.1 — not built by
 * this task) is a flat map of the exact env var names @dmemo/core's
 * `loadConfigFromEnv` reads (`DMEMO_PRIVATE_KEY`, `DMEMO_NETWORK`, ...).
 * Loading it here and merging into `process.env` (env wins if already set)
 * means hosts that already export env vars need no file at all, and hosts
 * that ran the setup wizard need no env vars.
 */
export function loadDmemoEnv(): NodeJS.ProcessEnv {
  let fileEnv: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(DMEMO_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') fileEnv = parsed;
  } catch {
    // No config file yet — env-only. Not an error (fresh install / CI).
  }
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined && typeof value === 'string') {
      process.env[key] = value;
    }
  }
  // Claude Code plugin `userConfig` surfaces as CLAUDE_PLUGIN_OPTION_<KEY>
  // env vars (shell-form hook commands can't reference ${user_config.*}
  // directly, per the packaging research) — map plugin.json's `privateKey`
  // option onto the same DMEMO_PRIVATE_KEY the rest of the adapter reads.
  if (!process.env.DMEMO_PRIVATE_KEY && process.env.CLAUDE_PLUGIN_OPTION_PRIVATE_KEY) {
    process.env.DMEMO_PRIVATE_KEY = process.env.CLAUDE_PLUGIN_OPTION_PRIVATE_KEY;
  }
  return process.env;
}

export function isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DMEMO_PRIVATE_KEY && env.DMEMO_PRIVATE_KEY.trim() !== '');
}

/** Stable per-user memory scope. One dMemo wallet == one memory scope by
 * default (v1 has no multi-profile UX); override with DMEMO_SCOPE for
 * testing / multi-identity setups. */
export function resolveScope(env: NodeJS.ProcessEnv = process.env): string {
  return env.DMEMO_SCOPE?.trim() || 'default';
}

export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DMEMO_DEBUG === 'true' || env.DMEMO_DEBUG === '1';
}

export function debugLog(message: string, data?: unknown): void {
  if (!debugEnabled()) return;
  try {
    fs.mkdirSync(DMEMO_HOME, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
    fs.appendFileSync(DMEMO_LOG_PATH, line);
  } catch {
    // Logging must never throw inside a fail-open hook.
  }
}

/** Per-session dedupe marker directory (mem0-plugin's rubric-flag pattern,
 * ported generically): one small file per (hookName, sessionId) so a hook
 * can tell "have I already done X for this session" across the fresh
 * subprocess-per-invocation lifecycle (gotcha 10). */
export function markerPath(hookName: string, sessionId: string): string {
  const dir = path.join(DMEMO_HOME, 'markers');
  return path.join(dir, `${hookName}.${sessionId || 'unknown'}`);
}

export function hasMarker(hookName: string, sessionId: string): boolean {
  try {
    return fs.existsSync(markerPath(hookName, sessionId));
  } catch {
    return false;
  }
}

export function writeMarker(hookName: string, sessionId: string): void {
  try {
    const p = markerPath(hookName, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(Date.now()));
  } catch {
    // Best-effort; a missing marker just means the guard re-fires, not fatal.
  }
}
