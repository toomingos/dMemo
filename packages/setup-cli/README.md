# dmemo (setup CLI)

`npx dmemo setup` — the onboarding wizard for dMemo: private, encrypted,
portable memory for coding agents, backed by 0G Storage. One command wires
up the memory leg end-to-end with **zero interactive web steps**.

## What it does, in order

1. **Wallet** — generate a new wallet or import an existing private key.
   The key is never printed, logged, or echoed back — it goes straight into
   `~/.dmemo/config.json` (mode `0600`). If a wallet is **already**
   configured, setup keeps it (see [Replacing a wallet](#replacing-a-wallet)).
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

## Replacing a wallet

`DMEMO_PRIVATE_KEY` is not a rotatable credential. It is the only key that can
decrypt this wallet's blobs on 0G Storage, so replacing it does not
reconfigure anything — it orphans every memory written under it.

So, following the same contract as `solana-keygen new`:

- **Re-running `dmemo setup` keeps the wallet already on record.** It goes
  straight on to refreshing the config and wiring up hosts. This is the normal
  case (you installed a new agent and want it hooked up).
- **Replacing takes an explicit ask** — `--new-wallet` or `--import-key <hex>`
  — **and consent**: an interactive `y/N` you must answer, or `--force` for
  unattended runs. Without either, an unattended run refuses and exits
  non-zero rather than guessing.
- **The old config is always backed up first**, to
  `~/.dmemo/config.json.<timestamp>.bak` (mode `0600`), whichever command did
  the replacing. Backups are written with `COPYFILE_EXCL`, so a backup can
  never overwrite a backup.
- `dmemo connect` asks the same question, *before* it opens a browser — but
  only when the key on record is a locally-generated one. A connect-derived
  account is reproducible forever from the same wallet + scope, so replacing
  one is undoable; a generated key exists nowhere but that file.

```bash
npx dmemo setup --new-wallet          # mint a new wallet, asks before replacing
npx dmemo setup --new-wallet --force  # ...without asking (still backs up)
```

If you replace a wallet by accident, the backup next to `config.json` is the
recovery path: copy it back over `config.json`.

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
- `~/.dmemo/config.json` is written atomically (temp file + `rename`), so an
  interrupted write can never leave a truncated config — and therefore can
  never destroy a key that way. A config that fails to parse is backed up
  before being replaced, never silently discarded.
- The wallet on record is never replaced without an explicit flag *and*
  consent, and never without a backup — see
  [Replacing a wallet](#replacing-a-wallet).
- See `docs/disclosure.md` in the monorepo root for what this CLI does
  **not** protect against (on-chain metadata, key loss, "forget" semantics).
