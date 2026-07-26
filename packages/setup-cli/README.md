# dmemo (setup CLI)

`npx @dmemo/cli setup` — the onboarding wizard for dMemo: private, encrypted,
portable memory for coding agents, backed by 0G Storage. One command wires up
the memory leg end-to-end with **no sign-ins, no accounts, and no API keys**.
Every browser step is a page served from your own machine on `127.0.0.1`, and
**no step ever asks you to paste a private key**.

## What it does, in order

1. **Wallet** — connect a browser wallet (the default) or generate a local key.
   Connecting opens a local page, you pick a wallet and sign one message, and
   dMemo derives a **separate** account from that signature — your wallet's own
   private key is never asked for, typed, or transmitted (see
   [Connecting a wallet](#connecting-a-wallet)). Either way the resulting key is
   never printed, logged, or echoed back — it goes straight into
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
npx @dmemo/cli setup                  # interactive wizard (offers to connect a wallet first)
npx @dmemo/cli setup --connect        # skip the ask: go straight to the wallet page
npx @dmemo/cli setup --scope work     # a second, fully isolated account off the same wallet
npx @dmemo/cli setup --generate       # mint a local key instead — no wallet, no browser
npx @dmemo/cli setup --yes            # non-interactive: generate a wallet, sensible defaults
npx @dmemo/cli setup --import-key 0x… # restore a key from a backup (scripted installs)
npx @dmemo/cli setup --testnet        # run the whole install against the free throwaway chain
npx @dmemo/cli setup --skip-hosts     # wallet + config only, skip host wiring
npx @dmemo/cli setup --skip-funding   # don't offer to fund; just print how to
npx @dmemo/cli setup --check-balance  # report the balance out loud even when it's still zero
npx @dmemo/cli fund                   # add 0G: card, another chain, or your own wallet
npx @dmemo/cli balance                # check the configured wallet's balance any time
npx @dmemo/cli --help                 # or -h, or `npx @dmemo/cli help` — from any position, always safe
npx @dmemo/cli --version              # or -v
```

`--help`/`-h` and `--version`/`-v` win outright no matter where they appear on
the command line (e.g. `npx @dmemo/cli setup --help` prints help, it does not run
the wizard) and never touch a wallet. An unknown command or an unrecognized
flag (including a typo of a real one, like `--newwallet`) is a hard error —
a message naming the offending token on stderr and a non-zero exit — never a
silent no-op that quietly runs a different command than the one you typed.

## Networks

**Mainnet (0G Aristotle, chain 16661) is the default.** It is where writes are
durable, so it is what a plain `npx @dmemo/cli setup` gives you.

`--testnet` (or the longhand `--network testnet`) runs the whole install
against 0G Galileo, chain 16602 — free, faucet-funded, and throwaway. It works
on `setup` and `fund`.

```bash
npx @dmemo/cli setup --testnet   # evaluate for free; memories live on a disposable chain
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
account needs a small balance. `npx @dmemo/cli fund` (also offered by `setup`) opens
a local page covering every starting point:

| You have | What the page offers |
|---|---|
| 0G in a browser wallet | Send it, via EIP-6963 wallet discovery. Nothing leaves your machine. |
| Crypto on another chain | ETH/USDC and more on Base, Arbitrum, Optimism, Polygon, BNB… converted to 0G and delivered to your address. |
| Neither — no crypto | Card, Apple Pay, or Google Pay. $5 minimum, $25 default (fees drop sharply above ~$25). |
| No wallet at all | Same card path — it needs no wallet and no crypto. |

```bash
npx @dmemo/cli fund              # $25 prefilled
npx @dmemo/cli fund --usd 50     # prefill a different amount (5–3000)
npx @dmemo/cli fund --no-open    # print the URL instead of launching a browser
npx @dmemo/cli balance           # check any time
```

On **testnet** none of those rails exist (they do not reach chain 16602), so
`fund` says so plainly and points at `https://faucet.0g.ai`.

"Funded" is always a balance read off the chain, never something the page
claimed — the CLI re-reads `eth_getBalance` before reporting success. The
destination address is locked into the payment URL and is not editable from
inside the page.

## Connecting a wallet

Step 1 of `setup` offers to connect a browser wallet, and that is the
pre-selected default. It serves a page on `127.0.0.1`, discovers your installed
wallets via [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963), and asks you to
sign one plain-text message. That message authorizes no transaction and costs no
gas.

**Your wallet's private key is never requested, entered, or transmitted.**
There is deliberately no prompt anywhere in this CLI that asks you to paste one:
a private key is the most sensitive string you own, and asking for it in a
terminal teaches exactly the habit phishing relies on.

What dMemo does with the signature is derive a **separate account** from it
(HKDF-SHA256 over the signature bytes). That derived account is what signs
storage transactions and decrypts your memories. Your own wallet only ever does
two things: prove it is yours by signing, and optionally send the derived
account a little 0G to spend.

Two consequences worth knowing:

- **It is portable.** The same wallet + the same scope reproduces the same
  account, forever, on any machine. Reconnecting is how you get your memories
  back — there is nothing to export or back up.
- **Scope splits identities.** `--scope work` derives a different account from
  the same wallet, with its own memories, fully isolated from `default`. The
  scope is part of the signed message, so it is not a label you can change
  later without changing the account.

```bash
npx @dmemo/cli setup --connect              # go straight to the wallet page
npx @dmemo/cli setup --connect --scope work # a separate account off the same wallet
npx @dmemo/cli setup --connect --no-open    # print the URL instead of launching a browser
```

`npx @dmemo/cli connect` still works as a deprecated alias for
`setup --connect`.

Wallets are asked to sign twice, and both signatures must match byte-for-byte.
Deterministic ECDSA nonces ([RFC 6979](https://www.rfc-editor.org/rfc/rfc6979))
are a near-universal convention rather than a requirement, and a wallet that
signs non-deterministically would derive a different account every time — so
that wallet is refused up front with an explanation, rather than silently
stranding your memories behind a key you can never reproduce.

`--generate` (or `--yes`, or any non-interactive run) skips all of this and
mints a local key instead. Nothing opens, nothing is signed — but that key then
exists in exactly one place on earth, `~/.dmemo/config.json`.

## Replacing a wallet

`DMEMO_PRIVATE_KEY` is not a rotatable credential. It is the only key that can
decrypt this wallet's blobs on 0G Storage, so replacing it does not
reconfigure anything — it orphans every memory written under it.

So, following the same contract as `solana-keygen new`:

- **Re-running `dmemo setup` keeps the wallet already on record.** It goes
  straight on to refreshing the config and wiring up hosts. This is the normal
  case (you installed a new agent and want it hooked up).
- **Replacing takes an explicit ask** — `--connect`, `--generate`,
  `--new-wallet` or `--import-key <hex>` — **and consent**: an interactive
  `y/N` you must answer, or `--force` for unattended runs. Without either, an
  unattended run refuses and exits non-zero rather than guessing.
- **The old config is always backed up first**, to
  `~/.dmemo/config.json.<timestamp>.bak` (mode `0600`), whichever command did
  the replacing. Backups are written with `COPYFILE_EXCL`, so a backup can
  never overwrite a backup.
- **`--connect` asks *before* it opens a browser.** The other modes ask after,
  because they can name the exact address they are about to displace;
  connecting cannot know the derived address until you have already picked a
  wallet and signed, and making you do that only to be refused would be
  backwards.
- **What "recoverable" means depends on the key on record.** A connect-derived
  account is reproducible forever from the same wallet + scope, so replacing
  one is undoable by reconnecting. A generated or imported key exists nowhere
  but `~/.dmemo/config.json` and its backups. The prompt tells you which one
  you are about to replace.

```bash
npx @dmemo/cli setup --new-wallet          # mint a new wallet, asks before replacing
npx @dmemo/cli setup --new-wallet --force  # ...without asking (still backs up)
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

- **No prompt in this CLI ever asks for a private key.** Connecting a wallet
  exchanges a signature, never a key; `--import-key` exists as a flag only, for
  scripted installs and restoring from a backup.
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
- The wallet and funding pages are bound to `127.0.0.1` (never
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
