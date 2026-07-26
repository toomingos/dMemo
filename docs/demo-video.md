# Demo video — script & shot list

Target: **3:30** (requirement window is 2:00–4:00). The story arc: **install in one
command → an agent that remembers you → proof that it's private and unkillable.**
Ease of install is the star of act one.

## Recording setup (meets the submission requirements)

- **Resolution**: record the full screen on a Retina display (QuickTime → File →
  New Screen Recording, or OBS). Anything ≥ 1280×720 output qualifies; a Mac
  screen recording is comfortably above that.
- **Audio**: built-in or headset mic, quiet room, **no music**. Clear voice audio
  is a hard requirement — speak the narration below.
- **Terminal**: dark theme, font size 16–18 pt, window ≈ 110 columns so banners
  don't wrap. Hide notifications (macOS Focus mode on).
- **Dry-run everything once** before recording: the setup flow, and `pnpm demo`
  (warms the fastembed model cache; a run costs ~0.0012 0G testnet plus a 0.05 0G
  throwaway-wallet funding transfer).

### The install command on camera

- **If published to npm** (best): `npx @dmemo/cli setup`
- **If not yet published**: pack it locally first, off camera:
  `cd packages/setup-cli && npm pack --pack-destination ~/Desktop` — then on
  camera run `npx ~/Desktop/dmemo-0.1.0.tgz setup`. Same code, honest framing
  ("this ships as npx @dmemo/cli setup").

To make the host-detection moment pop, have at least Claude Code installed (it
will be) so setup visibly finds and wires it. `--check-balance` makes the faucet
step resolve on screen. If you want a guaranteed-smooth take, pre-fund the wallet
and use `--import-key` off camera in rehearsal to learn the prompt rhythm.

## Timeline

| Time | Shot | What's on screen |
|---|---|---|
| 0:00–0:20 | Hook | README top: "Private, decentralized, plug-and-play memory" |
| 0:20–1:20 | **Act 1 — Install** | Terminal: `npx @dmemo/cli setup`, prompts, host detection |
| 1:20–1:45 | Act 2 — It just works | Claude Code (or any host) opens; memory adapter active |
| 1:45–2:55 | Act 3 — X-ray (`pnpm demo`) | Terminal: encrypt → flush → ciphertext proof → restore |
| 2:55–3:15 | Numbers + honesty | `docs/benchmarks.md` table, flash `docs/disclosure.md` |
| 3:15–3:30 | Close | README package table / repo root |

## Narration (word-for-word)

### 0:00 — Hook (README visible)

> Every AI agent you use today has amnesia — and the ones that don't, keep your
> life on someone else's server. This is dMemo: private, decentralized memory for
> agents like Claude Code, Codex, OpenCode and OpenClaw — and the whole point is
> that it's plug-and-play. Let me show you the entire setup, from zero.

### 0:20 — Act 1: Install (terminal, type the setup command, hit enter)

> One command. No account, no sign-up, no API key — because in dMemo, a wallet
> *is* your memory identity.

As the wallet step runs:

> It generates a wallet — or imports one — and points me at the testnet faucet
> for a few free tokens. That funding is the only setup step that isn't instant.

As host detection runs:

> Now watch this: it scans my machine for agent hosts — finds Claude Code, Codex,
> OpenCode, OpenClaw — and wires the memory adapter into each one it detects.
> Config lands in one file in my home directory. That's the whole install.

### 1:20 — Act 2: It just works (open Claude Code briefly)

> From this moment, my agent remembers. I can tell Claude Code my preferences
> today, and next week — on a different laptop, with nothing but my wallet key —
> the same memories come back. No dMemo server exists that could lose them, leak
> them, or lock me out. Sounds like magic, so let's X-ray it.

### 1:45 — Act 3: X-ray (terminal, run `pnpm demo`)

While stages 1–2 run:

> This is the same pipeline the adapters use, live on the 0G testnet. A fresh
> wallet, an agent learning six facts about me — extracted and embedded entirely
> on this laptop, including a secret codeword: octopus-umbrella. Recall works.
> And so far, nothing has left this machine.

When stage 3 prints (flush):

> Now the flush: the memory delta is encrypted to my wallet key and pushed to 0G
> Storage. There's the Merkle root — and the cost: about a tenth of a cent.

When stage 4 prints (ciphertext proof):

> Don't take privacy on faith. We pull the raw on-chain bytes: pure ciphertext.
> Grep them for the codeword — not found. A stranger's wallet trying to decrypt
> gets sixteen kilobytes of unparseable garbage. No key, no plaintext.

When stage 5 prints (restore):

> The punchline: local state wiped — imagine this laptop at the bottom of a
> river. A new session, armed with nothing but the key, finds the pointer in the
> chain logs, Merkle-verifies, decrypts, replays — three seconds — and answers
> the same question with the identical memory, identical score.

### 2:55 — Numbers + honesty (benchmarks.md, flash disclosure.md)

> The numbers are measured, not promised: cold restore around three seconds,
> flushes fire-and-forget so the agent never waits, and a LoCoMo benchmark shows
> retrieval is invariant across the flush-wipe-restore cycle. And the disclosure
> doc says plainly what dMemo does *not* protect — we'd rather you trust the
> parts we can prove.

### 3:15 — Close (back to README)

> One command to install. Four hosts supported. Memory that only you can read
> and no one can take away. dMemo — your agent remembers, and it answers to you.
> Thanks for watching.

## Fallback

If testnet is flaky on recording day, screen-record a previously captured
successful run played back with `asciinema` (record a good take in advance:
`asciinema rec demo.cast -c "pnpm demo"`, replay with `asciinema play demo.cast`).
The narration is unchanged.
