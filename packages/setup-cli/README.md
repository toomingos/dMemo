# dmemo (setup CLI)

`npx dmemo setup` — the onboarding wizard for dMemo: private, encrypted,
portable memory for coding agents, backed by 0G Storage. One command wires
up the memory leg end-to-end with **zero interactive web steps**.

## What it does, in order

1. **Wallet** — generate a new wallet or import an existing private key.
   The key is never printed, logged, or echoed back — it goes straight into
   `~/.dmemo/config.json` (mode `0600`).
2. **Funding** — prints the testnet faucet link (`https://faucet.0g.ai`) and
   your address; optionally polls your live balance (read-only, zero spend).
3. **Config** — writes `~/.dmemo/config.json`, the flat env-var-shaped
   config file every dMemo host adapter (`@dmemo/node-adapter`,
   `@dmemo/opencode-plugin`, `@dmemo/openclaw-plugin`) already knows how to
   read (`DMEMO_PRIVATE_KEY`, `DMEMO_NETWORK`, ...).
4. **Per-host install** — detects which of Claude Code / Codex / OpenCode /
   OpenClaw are present and wires each one up:
   - **Codex**: installs dMemo's hooks directly into `~/.codex/hooks.json`
     (idempotent merge) using a vendored copy of the Codex hook scripts —
     no separate download needed.
   - **OpenCode**: merges `"@dmemo/opencode-plugin"` into
     `~/.config/opencode/opencode.json`'s `"plugin"` array.
   - **Claude Code**: best-effort runs `claude plugin marketplace add` /
     `claude plugin install`; always prints the manual two-command fallback
     (marketplace repo `dmemo-ai/claude-dmemo`) plus a local-plugin-path
     option for testing an unpublished checkout.
   - **OpenClaw**: best-effort runs `openclaw plugins install
     @dmemo/openclaw-plugin`; always prints the manual config steps (config
     file schema/location isn't nailed down enough to safely auto-edit —
     see the plugin's own README).
5. **Optional inference leg** — prints (never scripts) the one interactive
   `pc.0g.ai` sign-in step needed to mint a Router `sk-...` key. This step
   is a documented, accepted gap (no headless first-key mint exists) and is
   entirely separate from the memory leg, which never needs it.

## Usage

```bash
npx dmemo setup                  # interactive wizard
npx dmemo setup --yes            # non-interactive: generate a wallet, sensible defaults
npx dmemo setup --import-key 0x… # import an existing key instead of generating one
npx dmemo setup --network mainnet
npx dmemo setup --skip-hosts     # wallet + config only, skip host wiring
npx dmemo setup --check-balance  # also poll the balance once after printing the faucet link
npx dmemo balance                # check the configured wallet's balance any time
```

## Env overrides (sandboxed testing only — never needed for real use)

| Var | Effect |
|---|---|
| `HOME` | Home directory used for all host detection/config paths (`~/.dmemo`, `~/.codex`, `~/.claude`, `~/.config/opencode`, `~/.openclaw`) |
| `DMEMO_HOME` | Overrides `~/.dmemo` specifically |
| `CODEX_HOME` | Overrides `~/.codex` specifically |
| `XDG_CONFIG_HOME` | Overrides the `~/.config` root used for OpenCode's config path |

These are the same overrides `@dmemo/node-adapter` and the Codex installer
already honor — the entire test suite for this CLI runs against a
throwaway `HOME`, never a real machine's dotfiles.

## Security notes

- The private key never appears in any `console.log`, error message, or
  written file other than `~/.dmemo/config.json` (mode `0600`).
- The balance check is a read-only `eth_getBalance` RPC call — it never
  signs or broadcasts anything.
- Host installers are additive/idempotent merges into existing config
  files, never blind overwrites — re-running `dmemo setup` is always safe.
- See `docs/disclosure.md` in the monorepo root for what this CLI does
  **not** protect against (on-chain metadata, key loss, "forget" semantics).
