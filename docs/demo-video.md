# Demo video — script & shot list

Target: **3:30** (requirement window is 2:00–4:00). ~490 words of narration at a
comfortable pace. One take of the live demo is 30–35 s of terminal time, so there
is room to breathe.

## Recording setup (meets the submission requirements)

- **Resolution**: record the full screen on a Retina display (QuickTime → File →
  New Screen Recording, or OBS). Anything ≥ 1280×720 output qualifies; a Mac
  screen recording is comfortably above that.
- **Audio**: built-in or headset mic, quiet room, **no music**. Speak the
  narration below — clear voice audio is a hard requirement.
- **Terminal**: dark theme, font size 16–18 pt, window ≈ 110 columns so the demo
  banners don't wrap. Hide other windows/notifications (macOS Focus mode on).
- **Dry-run first**: run `pnpm demo` once before recording so the fastembed
  model cache is warm and you know the run completes (~35 s). Each run costs
  ~0.0012 0G testnet plus a 0.05 0G throwaway-wallet funding transfer.
- Have two browser tabs pre-opened: the GitHub repo README (architecture
  diagram visible) and `docs/disclosure.md`.

## Timeline

| Time | Shot | What's on screen |
|---|---|---|
| 0:00–0:25 | Hook | README top: title + "Private, decentralized, plug-and-play memory" |
| 0:25–0:55 | Architecture | README "How it works" ASCII flow |
| 0:55–2:50 | **Live demo** | Terminal: `pnpm demo` (narrate over each stage) |
| 2:50–3:15 | Honesty + numbers | `docs/disclosure.md`, then `docs/benchmarks.md` table |
| 3:15–3:30 | Close | README package table / repo root |

## Narration (word-for-word)

### 0:00 — Hook (README visible)

> Every AI agent you use today has amnesia — and the ones that don't, store your
> life on someone else's server. This is dMemo: private, decentralized,
> plug-and-play memory for AI agents like Claude Code, Codex, OpenCode and
> OpenClaw. Your agent's memory becomes something *you* own — because it's keyed
> to your wallet, not to an account.

### 0:25 — Architecture (scroll to the ASCII diagram)

> The design is simple. Memories are extracted and embedded entirely on your
> machine using mem0 and a local embedding model — no API calls. They're
> journaled, encrypted to your wallet's public key, and flushed to 0G Storage as
> an append-only chain of blobs. The only thing that ever leaves your laptop is
> ciphertext. Next session — on any machine — the pointer is resolved straight
> from chain logs, every blob is Merkle-verified against its on-chain root,
> decrypted, and replayed. Let me show you the whole thing live, on the 0G
> testnet, in thirty seconds.

### 0:55 — Live demo (switch to terminal, type `pnpm demo`, hit enter)

While stage 1–2 runs:

> No accounts, no server — a wallet key *is* the memory identity. Here a fresh
> wallet gets funded on the 0G Galileo testnet… and now the agent learns six
> things about me — my package manager, my deploy rules, even a secret codeword:
> octopus-umbrella. Watch the recall check: ask it about package managers, it
> finds the pnpm memory. So far, nothing has left this machine.

When stage 3 prints (flush):

> Now the flush. The memory delta is encrypted to my wallet key and uploaded to
> 0G Storage — there's the Merkle root, sixteen kilobytes, and the cost: about a
> tenth of a cent.

When stage 4 prints (ciphertext proof):

> Don't take privacy on faith — verify it. We download the raw on-chain bytes:
> pure ciphertext. We grep them for the secret codeword: not found. And a
> stranger's wallet trying to decrypt it gets sixteen kilobytes of unparseable
> garbage. No key, no plaintext.

When stage 5 prints (restore):

> Now the punchline. Session closed, local state wiped — imagine this laptop at
> the bottom of a river. I open a new session with nothing but the wallet key: it
> finds the pointer in the chain logs, downloads, Merkle-verifies, decrypts and
> replays — in about three seconds. Same question, same answer, identical score.
> Byte-for-byte memory survival.

### 2:50 — Honesty + numbers (switch to disclosure.md, then benchmarks.md)

> We're honest about the limits: the disclosure doc spells out exactly what
> dMemo does and doesn't protect — on-chain metadata, key loss, what "forget"
> really means. And the numbers are measured, not promised: cold restore around
> three seconds, a flush around ten — fire-and-forget, so the agent never waits —
> all verified live on testnet, plus a LoCoMo benchmark proving retrieval is
> invariant across the flush-wipe-restore cycle.

### 3:15 — Close (back to README)

> Nine packages, one command to onboard — `npx dmemo setup` — with adapters for
> Claude Code, Codex, OpenCode and OpenClaw. dMemo: your agent remembers, and
> only you can read why. Thanks for watching.

## Fallback

If testnet is flaky on recording day, screen-record a previously captured
successful run played back with `asciinema` (record a good take in advance:
`asciinema rec demo.cast -c "pnpm demo"`, replay with `asciinema play demo.cast`).
The narration is unchanged.
