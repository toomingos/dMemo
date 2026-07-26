import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

// Config surface for `plugins.entries.dmemo.config` (matches the
// apiKey/baseUrl-style config block pattern every OpenClaw memory backend
// uses, e.g. Honcho's `plugins.entries.entries["openclaw-honcho"].config` —
// `research/openclaw.md` §5 "Config surface").
//
// T0.1 measured cold restore = 3.3s with chainLength 1 (K=2 checkpoint
// cadence; `TASKS.md` line 138). `DEFAULT_RECALL_TIMEOUT_MS` gives ~3x
// headroom over that for testnet latency variance while staying well under
// OpenClaw's generic per-hook runner default and its own documented
// `before_prompt_build` example budget of 90s
// (`docs/plugins/hooks.md:55-90` in the cloned openclaw repo) — matches the
// order of magnitude of Claude Code's UserPromptSubmit hook budget (10s)
// noted in `TASKS.md`'s T5.3 host-budget table.
export const DEFAULT_RECALL_TIMEOUT_MS = 10_000;
export const DEFAULT_TOP_K = 5;

/** Same `~/.dmemo/config.json` every other dMemo host adapter reads (written
 * by `npx @dmemo/cli setup`; flat map of `DMEMO_*` env-var names). Without this,
 * OpenClaw would be the only host that needs the key pasted into its own
 * config or exported into its daemon's environment — the config block and
 * `DMEMO_PRIVATE_KEY` still win over it, in that order. Never throws:
 * a missing/corrupt file is the normal "not set up yet" state. */
function dmemoConfigFile(): Record<string, string> {
  try {
    const home = process.env.DMEMO_HOME ?? nodePath.join(nodeOs.homedir(), ".dmemo");
    const parsed: unknown = JSON.parse(nodeFs.readFileSync(nodePath.join(home, "config.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export type RecallStrategy = "always" | "smart" | "manual";

export interface DmemoOpenClawConfig {
  /** 0G wallet private key (0x-prefixed hex). Required — no config, no memory (fail-open). */
  privateKey: string;
  /** Base mem0 `user_id` / isolation namespace. */
  scope: string;
  network: "testnet" | "mainnet";
  recall: {
    strategy: RecallStrategy;
    topK: number;
    timeoutMs: number;
  };
  /** Capture inference flag. NEVER wired to a real LLM in this build — see
   * README "Known limitation" and the T3.3 final report: `@dmemo/core`'s
   * `DmemoSession.open()` (T1.4/D7 seam) has no `llm` field in
   * `OpenSessionOptions`; its internal `Memory` is constructed with a
   * placeholder OpenAI LLM config that is safe ONLY as long as `infer:false`
   * is always passed (`packages/core/src/session.ts:85-97`, comment: "Never
   * actually called: dMemo always passes infer:false on add()"). Passing
   * `infer:true` through to that `Memory` instance would make a REAL network
   * call to OpenAI's completions endpoint with a bogus key — i.e. exactly
   * the "shipped defaults call OpenAI" bug this plugin exists to close.
   * Until core grows a real LLM slot wired to the 0G Router (T1.4 follow-up,
   * not in scope for T3.3), this plugin hardcodes `infer:false`
   * unconditionally and only warns if a user sets `infer:true`. (O6: mem0
   * has no dedup/idempotency of its own under `infer:false` either — see
   * `index.ts`'s E1 state-file doc comment for the full citation trail —
   * so this isn't leaving a native mechanism unused.) */
  infer: boolean;
  dream: {
    enabled: boolean;
    minHours: number;
    minSessions: number;
    minMemories: number;
    stateDir?: string;
  };
}

function str(v: unknown, fallback: string): string {
  // OpenClaw interpolates `"${FOO}"` config values from the environment and
  // leaves the placeholder verbatim when the var is unset — treat that as
  // absent rather than passing a literal "${DMEMO_PRIVATE_KEY}" downstream.
  if (typeof v === "string" && v.length > 0 && !/^\$\{[A-Z0-9_]+\}$/.test(v)) return v;
  return fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Parse+default the plugin config block. Never throws — malformed/missing
 * fields fall back to safe defaults; the only thing callers must check
 * themselves is `privateKey` (empty => fail-open, no memory backend). */
export function parseConfig(raw: Record<string, unknown> | undefined | null): DmemoOpenClawConfig {
  const cfg = raw ?? {};
  const recall = (cfg.recall as Record<string, unknown>) ?? {};
  const dream = (cfg.dream as Record<string, unknown>) ?? {};

  const strategyRaw = recall.strategy;
  const strategy: RecallStrategy =
    strategyRaw === "always" || strategyRaw === "manual" ? strategyRaw : "smart";

  if (cfg.infer === true) {
    // Deliberately not throwing — fail-open. The caller (index.ts) still
    // always passes infer:false to session.memory.add(); this is enforced
    // in one place, not delegated to config plumbing.
  }

  const file = dmemoConfigFile();
  const network = cfg.network ?? file.DMEMO_NETWORK;

  return {
    privateKey: str(cfg.privateKey, str(process.env.DMEMO_PRIVATE_KEY, str(file.DMEMO_PRIVATE_KEY, ""))),
    scope: str(cfg.scope, str(file.DMEMO_SCOPE, "default")),
    network: network === "mainnet" ? "mainnet" : "testnet",
    recall: {
      strategy,
      topK: num(recall.topK, DEFAULT_TOP_K),
      timeoutMs: num(recall.timeoutMs, DEFAULT_RECALL_TIMEOUT_MS),
    },
    infer: bool(cfg.infer, false),
    dream: {
      enabled: bool(dream.enabled, true),
      minHours: num(dream.minHours, 24),
      minSessions: num(dream.minSessions, 5),
      minMemories: num(dream.minMemories, 20),
      stateDir: typeof dream.stateDir === "string" ? dream.stateDir : undefined,
    },
  };
}
