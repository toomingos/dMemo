# dmemo (setup CLI)

`npx dmemo setup` — the onboarding wizard for dMemo: private, encrypted,
portable memory for coding agents, backed by 0G Storage. One command wires up
the memory leg end-to-end with **no sign-ins, no accounts, and no API keys**.
The only browser step is funding, it is optional, and it is a page served from
your own machine on `127.0.0.1`.

## What it does, in order

1. **Wallet** — generate a new wallet or import an existing private key.
   The key is never printed, logged, or echoed back — it goes straight into
   `~/.dmemo/config.json` (mode `0600`). If a wallet is **already**
   configured, setup keeps it (see [Replacing a wallet](#replacing-a-wallet)).
2. **Config** — writes `~/.dmemo/config.json`, the flat env-var-shaped
   config file every dMemo host adapter (`@dmemo/node-adapter`,
   `@dmemo/opencode-plugin`, `@dmemo/openclaw-plugin`) already knows how to
   read (`DMEMO_PRIVATE_KEY`, `DMEMO_NETWORK`, ...). This happens *before*
   funding on purpose: funding opens a browser and can take minutes, and
   losing a freshly generated key to a closed tab would be unrecoverable.
3. **Funding** — reads your live balance (read-only, zero spend) and, if it
   is empty, offers to open [`dmemo fund`](#funding). Already funded, or
   `--skip-funding`, or non-interactive (`--yes`): it says how to fund and
   moves on — it never opens a payment page unattended.
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
npx dmemo setup --testnet        # run the whole install against the free throwaway chain
npx dmemo setup --skip-hosts     # wallet + config only, skip host wiring
npx dmemo setup --skip-funding   # don't offer to fund; just print how to
npx dmemo setup --check-balance  # report the balance out loud even when it's still zero
npx dmemo fund                   # add 0G: card, another chain, or your own wallet
npx dmemo balance                # check the configured wallet's balance any time
npx dmemo --help                 # or -h, or `npx dmemo help` — from any position, always safe
npx dmemo --version              # or -v
```

`--help`/`-h` and `--version`/`-v` win outright no matter where they appear on
the command line (e.g. `npx dmemo setup --help` prints help, it does not run
the wizard) and never touch a wallet. An unknown command or an unrecognized
flag (including a typo of a real one, like `--newwallet`) is a hard error —
a message naming the offending token on stderr and a non-zero exit — never a
silent no-op that quietly runs a different command than the one you typed.

## Networks

**Mainnet (0G Aristotle, chain 16661) is the default.** It is where writes are
durable, so it is what a plain `npx dmemo setup` gives you.

`--testnet` (or the longhand `--network testnet`) runs the whole install
against 0G Galileo, chain 16602 — free, faucet-funded, and throwaway. It works
on `setup`, `connect`, and `fund`.

```bash
npx dmemo setup --testnet   # evaluate for free; memories live on a disposable chain
```

A network name is validated, not guessed: `--network mainet` is a hard error,
not a silent demotion to testnet. `--testnet --network mainnet` is refused
rather than resolved in either direction. And a **re-run never moves an
existing install** — the network already in `~/.dmemo/config.json` wins over
the default, so `dmemo setup` on a testnet install stays on testnet unless you
say otherwise.

Memories do not follow you across networks: the blob chain lives on whichever
chain wrote it.

## Funding

Memory writes cost roughly **0.0012–0.003 0G each**, paid on 0G mainnet, so the
account needs a small balance. `npx dmemo fund` (also offered by `setup`) opens
a local page covering every starting point:

| You have | What the page offers |
|---|---|
| 0G in a browser wallet | Send it, via EIP-6963 wallet discovery. Nothing leaves your machine. |
| Crypto on another chain | ETH/USDC and more on Base, Arbitrum, Optimism, Polygon, BNB… converted to 0G and delivered to your address. |
| Neither — no crypto | Card, Apple Pay, or Google Pay. $5 minimum, $25 default (fees drop sharply above ~$25). |
| No wallet at all | Same card path — it needs no wallet and no crypto. |

```bash
npx dmemo fund              # $25 prefilled
npx dmemo fund --usd 50     # prefill a different amount (5–3000)
npx dmemo fund --no-open    # print the URL instead of launching a browser
npx dmemo balance           # check any time
```

On **testnet** none of those rails exist (they do not reach chain 16602), so
`fund` says so plainly and points at `https://faucet.0g.ai`.

"Funded" is always a balance read off the chain, never something the page
claimed — the CLI re-reads `eth_getBalance` before reporting success. The
destination address is locked into the payment URL and is not editable from
inside the page.

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
- The pages `connect` and `fund` serve are bound to `127.0.0.1` (never
  `0.0.0.0`), gated by a single-use 32-byte token compared in constant time,
  and reject a cross-site `Origin` or a rebound `Host`. They time out on
  their own if you close the tab.
- Those pages make **no external requests** — no CDN, no fonts, no analytics
  — with exactly one disclosed exception: on mainnet, `fund` frames the
  hosted payment widget, because only its own allowlisted origin can price a
  card purchase. The iframe is not created until you click the card or
  cross-chain option, so a wallet-only funding run stays fully local. CSP
  widens by `frame-src` alone: the widget can be framed, and can never be a
  script source, a fetch target, or an image source for our page.
- The destination address is pinned in the widget URL and marked
  non-editable, and completion is confirmed by re-reading the chain balance,
  never by trusting what the page reported.
- See `docs/disclosure.md` in the monorepo root for what this CLI does
  **not** protect against (on-chain metadata, key loss, "forget" semantics).
