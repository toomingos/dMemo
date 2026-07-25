# dMemo — what you are actually trusting

This document says plainly what dMemo does and does not protect against.
No marketing language, no hedging. If you are deciding whether to store real
data in dMemo, read this first.

## 1. On-chain metadata is public, even with perfect encryption

dMemo encrypts the *content* of every memory blob (client-side, before it
ever leaves your machine — see §3). It does **not** and cannot hide the fact
that a write happened. 0G Storage is a public blockchain-anchored network.
Anyone watching the chain can see, for every blob dMemo writes:

- **Your wallet address** as the writer (the same address whose private key
  is your dMemo memory key — see §2). If that address is linkable to your
  identity anywhere else (an exchange KYC, a public repo commit, a tip jar),
  your dMemo activity is linkable to you too.
- **The size of each blob** (delta or checkpoint). Content is encrypted;
  size is not. Size differences between memory writes can leak information
  about what happened in a session (a long assistant reply vs. a short one,
  a checkpoint's full-history size vs. an incremental delta) even though the
  bytes themselves are unreadable.
- **The timing and cadence of writes** — when you had a session, how long it
  ran, how often it flushed. This is a real side channel: usage patterns
  (working hours, session frequency, sudden silence) are visible to anyone
  who bothers to watch the chain, forever, with no way to retroactively hide
  it.

Encryption protects *what you said*. It does not protect *that you said
something, when, roughly how much, and from which wallet*. If your threat
model includes an adversary who can correlate on-chain activity with your
identity, dMemo's current design does not defend against that. There is no
mixing, no batching-to-obscure-timing, and no plan to add either in the
near term — this is a structural property of writing to a public chain, not
a bug we intend to patch.

## 2. Losing your key means losing your memory. Permanently. No recovery.

Your dMemo memory key is your wallet's private key (D2: "wallet key doubles
as memory key, zero extra secrets"). This is deliberate — one key, one
thing to lose track of — but it means:

- **There is no password reset.** There is no "forgot your key" flow.
  There is no customer support that can get your memories back.
- **There is no custodian.** dMemo (the project) never sees, stores, or has
  any way to reconstruct your private key. `npx dmemo setup` generates it
  locally or accepts one you paste in, writes it to `~/.dmemo/config.json`
  with file mode `0600`, and that is the only copy dMemo's tooling ever
  creates. If that file is lost and you didn't back up the key elsewhere,
  every memory blob you ever wrote is permanently unreadable ciphertext
  sitting on 0G Storage forever. It is not deleted — it is just noise to
  anyone without the key, including you.
- **This is symmetric with the upside.** The same property that makes your
  memory yours and unreadable by dMemo, 0G, or anyone else also means
  nobody — including you, once the key is gone — can undo that.

Back up your private key somewhere durable, the same way you would a
seed phrase, if the memories stored under it matter to you.

### What the tooling guarantees about *not* destroying it

Because the key is irreplaceable, no dMemo command replaces one silently.
This is a hard contract, covered by tests, not a best effort:

- **Re-running `npx dmemo setup` keeps the wallet already on record.** It
  does not mint a new one. Replacing takes an explicit `--new-wallet` or
  `--import-key`, *and* consent — an interactive `y/N`, or `--force` for
  unattended runs. Without either, an unattended run refuses and exits
  non-zero rather than guessing.
- **Any replacement writes a timestamped `0600` backup first**
  (`~/.dmemo/config.json.<timestamp>.bak`), whichever command did it.
  Backups are created with `COPYFILE_EXCL`, so a backup can never overwrite
  a backup.
- **A config that fails to parse is backed up before being replaced**, never
  silently discarded — a stray comma in a hand edit must not cost you a key.
- **The config is written atomically** (temp file + `rename`), so an
  interrupted or crashed write cannot leave a truncated file.
- **`npx dmemo connect` asks before it opens a browser**, but only when the
  key on record is locally generated. A connect-derived account is
  reproducible forever from the same wallet + scope, so replacing one is
  undoable; a generated key exists nowhere but that file.

What this does **not** give you: a recovery path if you delete `~/.dmemo`
outright, lose the disk, or discard the backups. The guarantees above narrow
the window for *accidental* key loss by dMemo's own tooling. They do not
change §2 — you are still the only custodian, and an off-machine backup of
your key is still the only real insurance.

## 3. What encryption actually happens, precisely

Every memory blob is encrypted via ECIES to your wallet's public key before
upload (`@0gfoundation/0g-ts-sdk`'s native `UploadOption.encryption = {
type: 'ecies', recipientPubKey }`), and decrypted via the SDK's `tryDecrypt`
with your private key on read. Merkle self-verification of blob integrity
always happens on the raw ciphertext as downloaded from the network — never
on an already-decrypted convenience path — so integrity is checked against
what is actually on-chain, not against a value that could be tampered with
post-decryption.

This protects blob *contents* in transit and at rest against everyone
without your private key, including 0G node operators. It does not protect
the metadata described in §1, and (see §5) it does not currently mean
"forgotten" memories are cryptographically unreadable even to you — v1's
`forget()` is a tombstone + proof mechanism, not a re-keying mechanism.

## 4. TeeML vs TeeTLS — and today's testnet reality

If you use dMemo's optional inference leg (routing chat completions through
the 0G Compute Router, separate from the memory/storage leg), the trust
model of that call depends entirely on which of two very different things
the model provider actually is:

- **TeeML** ("private inference," `X-0G-Provider-Trust-Mode: private`
  header, `verifiability === "TeeML"` in the Router's model catalog): your
  prompt is processed inside a machine-learning-specific trusted execution
  environment. The Router and the model provider running inside the TEE
  cannot read your prompt or response in plaintext. This is the mode dMemo
  is designed around and defaults to (`listPrivateModels()` in
  `@dmemo/sdk-wrappers` filters to `verifiability === "TeeML"` specifically,
  and the default trust-mode header is `private`).
- **TeeTLS**: a much weaker guarantee. It means the *connection* is
  TLS-protected in transit — the same protection any HTTPS API call has.
  It does **not** mean your prompt is hidden from the upstream model
  provider. TeeTLS providers see your plaintext prompt and response exactly
  like any normal API call to any normal LLM vendor. Calling a TeeTLS model
  through the Router gives you the Router's routing/discovery convenience;
  it does **not** give you the privacy property that makes "private
  inference" the point of using dMemo's Router integration in the first
  place.

**Current testnet reality, verified live 2026-07-25**: there is no TeeML
*chat* model live on the 0G Router testnet. The spec-era model id
`qwen/qwen2.5-omni-7b (TeeML)` no longer exists in the catalog. The current
testnet chat model, `qwen2.5-omni`, is **TeeTLS**, not TeeML. The only
TeeML model currently live on testnet is `qwen-image-edit` (image, not
chat). This is a live, checkable fact — run `GET
{router-base-url}/v1/models` yourself and look at the `verifiability`
field — not a permanent architectural limit; the catalog can and does
change. If you route chat inference through the Router today, on testnet,
you are using TeeTLS by necessity, not by dMemo's design choice, and your
prompts are visible to the upstream provider exactly as they would be
calling that provider directly. dMemo's own defaults (`trustMode: 'private'`
header, `listPrivateModels()` filtering) are built to prefer TeeML the
moment a TeeML chat model exists on whichever network you're pointed at —
they do not retroactively make a TeeTLS-only catalog private.

The memory/storage leg (everything described in §1–§3) does not depend on
or use the Router at all — it works, and keeps its privacy properties,
whether or not you ever touch the inference leg.

## 5. "Forget" is crypto-shred, and v1's crypto-shred is a tombstone, not a real shred yet

dMemo's `forget()` operation (per-epoch) is explicitly **not** "delete" in
the sense of removing bytes from disk or from 0G Storage — that's not how
a content-addressed, replicated, blockchain-anchored store works, and
dMemo does not pretend otherwise. What "forget" means here is **crypto-shred**:
make the forgotten epoch's data unreadable by discarding the key that could
decrypt it, rather than by erasing the ciphertext (which may be technically
impossible or prohibitively expensive to guarantee across a replicated
network anyway).

**What v1 actually does today** (`packages/core/src/forget.ts`):

1. Derives a per-epoch sub-key from your wallet private key via HKDF
   (`deriveEpochKey`) — deterministic, so the same epoch always re-derives
   the same key.
2. Immediately zeroes and discards that derived key in memory. It is never
   persisted, logged, or returned.
3. Journals a durable **tombstone record** for that epoch — this is real
   and durable: it survives flush/restore and is visible in the
   on-chain-anchored journal as an audit trail proving a forget event
   happened for that epoch.

**What v1 does NOT yet do, stated plainly**: it does not re-key the actual
blob ciphertext per epoch. Every blob, forgotten epoch or not, is still
encrypted under the single wallet-level ECIES key described in §3. The
per-epoch sub-key derived in step 1 is not actually used to encrypt or
decrypt anything on the storage path today — it exists to *prove* the key
was derivable (a "crypto-shred gesture"), not to *gate* readability of that
epoch's ciphertext.

**The practical consequence**: if you still hold your wallet's private key,
you can still decrypt a "forgotten" epoch's ciphertext, because forgetting
an epoch does not remove or rotate the actual decryption key for that data
— only losing the whole wallet key (§2) or a future v1.1 mechanism would.
"Forget" in v1 gives you a durable, auditable record that you asked to
forget something, and a proof-of-concept that per-epoch keys can be derived
— it does not yet give you unrecoverability of that epoch's plaintext
independent of your wallet key.

**v1.1 (not yet built)** is where true per-epoch shredding is intended to
land: actually re-keying the upload/download encryption path per epoch, so
that discarding an epoch's sub-key genuinely removes the ability to decrypt
that epoch's blobs even for someone holding the wallet's main private key.
Until that ships, treat `forget()` as "I have a durable record that I asked
to forget this, and a mechanism exists that could enforce it in the future"
— not as "this data is now cryptographically inaccessible to anyone,
including future-me with the same wallet key."

## Summary table

| Claim | True today? |
|---|---|
| Memory blob contents are encrypted so 0G node operators can't read them | Yes (ECIES to wallet pubkey) |
| Nobody without your private key can decrypt your memories | Yes |
| Your wallet address, blob sizes, and write timing are hidden from chain observers | **No** — all public |
| Losing your private key is recoverable | **No** — permanent, no custodian, no reset |
| dMemo's inference leg is always processed in a TEE hidden from the model provider | **Only if the model is TeeML.** As of 2026-07-25, no TeeML chat model exists on testnet; the default testnet chat model (TeeTLS) is visible to the upstream provider |
| `forget()` makes an epoch's data cryptographically unreadable, even to you | **No, not yet** — v1 is a tombstone + proof-of-derivability; true per-epoch re-keying is v1.1 |
