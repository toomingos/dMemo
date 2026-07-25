# dAI Values & Encrypted Memory Checklist

Research area 7 of `/Users/tomasdomingos/dMemo/research-questions.md`. Scope: what the
decentralized-AI/crypto audience expects from a "private, encrypted, decentralized memory"
product, how comparable projects implement/communicate it, and what must be true — technically
and in practice — for dMemo to make that claim honestly on the 0G stack.

Repos used (already cloned in scratchpad by prior research passes, not re-cloned):
`0g-ts-sdk`, `0g-storage-kv`, `0g-serving-user-broker` (now `0g-compute-ts-sdk`), `supermemory`.

---

## A. High-level overview

### A.1 The trust stack the audience is actually evaluating

```
┌───────────────────────────────────────────────────────────────┐
│ 5. Recovery       — losing keys = losing memory, no backdoor   │
│ 4. Deletion       — can bytes/keys really be made unreadable?  │
│ 3. Verifiability  — proofs, not promises (attestation, Merkle) │
│ 2. Metadata       — what leaks even when payload is encrypted  │
│ 1. Keys/Encrypt.  — who can decrypt, and where do keys live    │
└───────────────────────────────────────────────────────────────┘
        ↑ table stakes at the bottom, differentiators at the top
```
Crypto-native audiences interrogate bottom-up: if layer 1 fails ("the operator can read my
data"), nothing above it matters — this is why "not your keys, not your data" is the load-bearing
phrase in every self-custody discussion (see §B.1).

### A.2 dMemo's actual data flow against this stack

```
Agent runtime (Claude Code / OpenClaw / …)
   │ 1. plaintext memory query/write
   ▼
dMemo SDK (client-side, on user's machine)
   │ 2. encrypt with user's key (AES-256-CTR, optionally ECIES to wallet pubkey)   [layer 1]
   ▼
0G Storage upload  ──(tx: signer, size, timestamp on-chain)──────────────────────► [layer 2: metadata leaks]
   │ 3. content-addressed ciphertext, root hash public, PoRA-provable              [layer 3: verifiable]
   ▼
   ... later, at next agent runtime ...
   │ 4. fetch by root hash (indexer.download) — anyone with hash can fetch bytes
   ▼
dMemo SDK decrypts in-memory only                                                  [layer 1 again]
   │ 5. inject plaintext into 0G Compute request, ephemeral, discarded after call
   ▼
0G Compute (TEE) — TeeML: model inside TEE, TeeTLS: proxy to external LLM          [layer 3: mode matters]
   │ 6. signed response, verifiable against on-chain TEE signer
   ▼
completion → mutation → re-encrypt → re-upload (append/update in KV layer)         [layer 4: old ciphertext persists]
```

---

## B. What the dAI / crypto community expects

### B.1 Table stakes vs. differentiators

| Tier | Expectation | Why it's in this tier |
|---|---|---|
| Table stakes | Client-side encryption; keys never touch a server the team operates | "Not your keys, not your data" is the direct AI-memory analogue of "not your keys, not your coins" — the crypto community's post-Mt.-Gox baseline for any custody claim ([bit2me](https://news.bit2me.com/en/not-your-keys-not-your-coins-crypto-self-custody/), [Ledger](https://www.ledger.com/academy/not-your-keys-not-your-coins-why-it-matters)) |
| Table stakes | Open-source, auditable client + contracts | Claims of privacy without inspectable code are dismissed as marketing in this audience |
| Table stakes | No silent centralized override (can't be censored/frozen/read by the operator) | Direct extension of self-sovereignty ethos — "no exchange, company, or platform has access to your funds" generalizes to "your memory" ([bit2me](https://news.bit2me.com/en/not-your-keys-not-your-coins-crypto-self-custody/)) |
| Table stakes | Proofs over promises for any "verifiable"/"private" claim | Matches 0G Compute's own positioning: TEE attestation + signed, on-chain-verifiable responses, not just a ToS promise (`0g-serving-user-broker/CLAUDE.md:310-345`) |
| Differentiator | True decentralization (no single storage/compute operator) vs. "encrypted SaaS" | Many privacy products (Signal, Proton) are centralized+encrypted and are still trusted — decentralization is the extra claim this specific audience rewards |
| Differentiator | Metadata minimization (hiding access patterns, not just payload) | Almost no project in this space does this well (see §C) — genuine differentiator if solved |
| Differentiator | Provable/receipted deletion (crypto-shredding with an on-chain tombstone) | Most projects punt to "off-chain storage, on-chain hash" and stop there (see §B.3) |
| Differentiator | Non-custodial recovery that isn't just "write down your seed phrase" | Threshold/social recovery (Lit-style) is still rare and valued when done well |

### B.2 How comparable projects implement/communicate this

| Project | Model | Key custody | What they optimize for | Relevance to dMemo |
|---|---|---|---|---|
| [Lit Protocol](https://spark.litprotocol.com/introduction-to-decentralized-access-control/) | Threshold-secret-sharing key network; identity-based encryption with on-chain Access Control Conditions | Keys split across nodes, never fully reconstructed; user encrypts locally and defines who can decrypt | Decentralized *access control*, not storage — the piece 0G Storage lacks natively (§C.4) | Model for a future "share memory with another agent" feature; out of scope for MVP |
| [Nillion](https://docs.nillion.com/blind-computer/learn/overview) | "Blind computation" — MPC/FHE/TEE so data is processed without ever being decrypted anywhere | Data stays encrypted through storage *and* compute | Computing on private data without a trust-me TEE | Useful contrast: 0G Compute's TeeML mode is TEE-based (single hardware root of trust), not MPC/FHE — weaker trust model than Nillion's blind compute, worth disclosing |
| [Vana](https://docs.vana.org/docs/proof-of-contribution) | DataDAOs; user data encrypted, user holds keys, metadata on-chain, validation happens in TEEs (Proof of Contribution) | User-held keys explicitly stated in docs | Data *ownership* and monetization, privacy-preserving validation | Closest architectural analogue to dMemo: "metadata on-chain, encrypted payload off-chain, user controls keys" is exactly dMemo's shape |
| [Recall Network](https://messari.io/report/recall-onchain-ai-and-intelligence-competitions) | On-chain agent memory, deliberately public/auditable ("verifiable onchain blobs") | No privacy claim — opposite design point | Optimizes for transparency/reputation of agents, not privacy | Important negative example: proves "on-chain agent memory" already exists but chose transparency over privacy — dMemo must be explicit that it is the private counter-position, not confuse messaging with Recall's model |
| supermemory | Centralized API, standard REST auth | Operator-held (API key model); real `DELETE /v4/memories` endpoint (`supermemory/packages/tools/src/shared/forget-memory.ts:18-30`) | Product velocity, not decentralization/privacy | Cautionary reference, not a template: this hard-`DELETE` pattern must NOT be replicated — a true `DELETE` is possible in supermemory's centralized DB but not on 0G's append-only log (§B.3) |

### B.3 The deletion/immutability tension (regulatory + community angle)

GDPR Article 17 and blockchain immutability are in direct, well-documented tension: "personal
data recorded [on a public ledger] is replicated across the entire network, making it impossible
to remove... even if a single participant was willing to comply... he or she lacks the technical
ability to erase data across the entire network" ([Secure Privacy](https://secureprivacy.ai/blog/blockchain-immutability-vs-gdpr-article-17-right-to-be-forgotten)).
The accepted mitigation pattern — "store personal data off-chain, keep only a hash/reference
on-chain; delete off-chain, leave the reference" ([arXiv:2210.04541](https://arxiv.org/pdf/2210.04541)) — is
structurally what 0G already does (payload on the Log/KV layer, reference is the root hash), but
it does **not** by itself satisfy erasure: the off-chain blob (0G Storage) is itself an
append-only, erasure-coded, content-addressed network — nobody can un-store it either. The only
mechanism that actually makes data unrecoverable in this architecture is **crypto-shredding**
(destroy/rotate the key so ciphertext becomes permanently unreadable), which several sources
confirm is an accepted equivalent to erasure: "'Erasure' does not have to mean 'physical
destruction' of the data... anonymization[/making data permanently unlinkable] would allow for
irreversible destruction of the link" ([Secure Privacy](https://secureprivacy.ai/blog/blockchain-immutability-vs-gdpr-article-17-right-to-be-forgotten)).

---

## C. What must be true to legitimately claim "private, encrypted, decentralized memory"

### C.1 Keys

- **Verified true today (0G ts-sdk):** two native encryption modes exist and are wire-compatible
  with the Go reference client — v1 symmetric (caller-supplied 32-byte AES key) and v2 ECIES
  (encrypt to a recipient's secp256k1 public key, decrypt with the matching private key)
  (`0g-ts-sdk/src.ts/common/encryption.ts:224-246`, design doc
  `0g-ts-sdk/docs/superpowers/specs/2026-04-23-ts-sdk-ecies-encryption-design.md:9-13`).
- **Key decision for dMemo:** ECIES-to-wallet-pubkey means the *same* secp256k1 wallet a user
  already holds for 0G Storage/Compute payments can double as the memory encryption keypair — no
  second secret to generate, back up, or lose. This directly satisfies "not your keys, not your
  data" without extra UX friction, which is the plug-and-play constraint from `idea.md:9-14`.
- **Open question:** for always-on coding-agent runtimes (Claude Code, OpenCode), the private key
  must be available locally on every inference call with no human present to unlock a wallet.
  Where does that key live (OS keychain vs. plaintext env var) has not been decided — this is a
  real custodial risk if done carelessly and needs its own design doc before ship.

### C.2 Encryption

- **Verified true today:** `EncryptedFile` wraps the file *before* the Merkle-tree/segment
  pipeline runs, so plaintext is never staged unencrypted anywhere in the upload path —
  encryption happens inline in `readFromFile` (`0g-ts-sdk/src.ts/file/EncryptedFile.ts:42-82`).
- **Important limitation to disclose, not hide:** AES-256-CTR is confidentiality-only, explicitly
  **not authenticated encryption** — the design doc states this as a non-goal and notes integrity
  instead comes from the storage layer's Merkle root, matching the Go reference
  (`0g-ts-sdk/docs/.../2026-04-23-ts-sdk-ecies-encryption-design.md:21-23`). The SDK's
  `with_proof` flag (`indexer.download(<root_hash>, <output_file>, <with_proof>)` per
  `0g-ts-sdk/README.md`) is a no-op — proof verification is an unimplemented `// TODO: add proof
  check` in `Downloader.ts`. dMemo achieves "private and tamper-evident" by self-verifying
  client-side instead: after download, recompute the blob's Merkle root and compare it against
  the on-chain root hash from the flush transaction (D9).

### C.3 Metadata

- **Verified true today:** uploads go through an EVM transaction — the signer address, upload
  size, and timestamp are all public on-chain even when the payload is ciphertext
  (`0g-ts-sdk/README.md` upload example uses `signer` directly against `evmRpc`). Anyone
  correlating a wallet address can observe an agent's memory-write cadence and payload-size
  growth over time, even with perfect encryption.
- **Open question / differentiator opportunity:** no native 0G feature was found for hiding
  writer identity or write timing (e.g., rotating sub-wallets, write batching/padding). This is
  the gap Lit Protocol-style or mixnet-style approaches address in adjacent designs — worth an
  explicit "known limitation" disclosure at minimum, and a candidate differentiator if solved
  later.

### C.4 Verifiability

- **Verified true today (0G Compute):** two TEE modes exist with different guarantees.
  **TeeML** — "the AI model runs directly inside a Trusted Execution Environment... responses are
  signed by the TEE's private key," full prompt confidentiality from the operator.
  **TeeTLS** — the Broker (itself TEE-protected) proxies to an external LLM provider over HTTPS
  and bundles a signed routing proof; the *external provider* still sees plaintext prompts even
  though the Broker cannot ([docs.0g.ai/developer-hub/building-on-0g/compute-network/inference](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference)).
  This is confirmed structurally in code: `Verifier.ts` fetches the provider's TEE public key
  from the contract and verifies response signatures (`0g-serving-user-broker/CLAUDE.md:310-345`),
  and a real NVIDIA Hopper confidential-computing attestation quote was captured from a live
  provider (`0g-serving-user-broker/llm_attestation_report.json` — `"arch":"HOPPER"`, Intel/NVIDIA
  quote + certificate chain).
- **Critical decision for dMemo:** "private LLM inference" is only true end-to-end if dMemo
  restricts itself to **TeeML providers**, or clearly discloses per-provider which mode is in use.
  Silently allowing TeeTLS providers while marketing "private" would be a false claim by this
  audience's standard (see B.1, "proofs over promises").
- **TEE limitations to disclose (not 0G-specific, general to the category):** TEEs "inherit
  vulnerabilities to side-channel exploits... centralize trust in proprietary hardware... exhibit
  limited auditability," and conventional TEEs often don't let the *client* independently attest —
  the client must trust the broker/relay to have checked it correctly
  ([dhiria.com](https://www.dhiria.com/en/blog/are-trusted-execution-environments-trustable),
  [arXiv:2605.26196](https://arxiv.org/html/2605.26196v1)). This is a hardware-rooted trust
  assumption, not a cryptographic guarantee — "private" here means "private unless the TEE is
  broken," which should be stated plainly, matching how 0G's own SDK treats verification failure
  as a warning, not a hard stop (`Verifier.ts` review checklist: "Verification failure is logged
  but doesn't crash," `0g-serving-user-broker/CLAUDE.md:361`).
- **0G Storage side:** Proof of Random Access (PoRA) makes storage-node possession of data
  cryptographically checkable — miners must produce a valid hash proving they hold the claimed
  data (per docs.0g.ai/concepts/storage summary). This proves availability/possession, not
  confidentiality — confidentiality is entirely the client-side encryption's job (§C.2).

### C.5 Deletion

- **Verified true today:** the Log Layer is explicitly append-only ("write once, read many"); the
  KV Layer supports "updates" but implements them as new operations replayed on top of the log —
  a KV node "reconstructs the KV database locally by replaying the KV database operations
  contained in the KV files" (`0g-storage-kv/README.md`, top). There is **no access control** at
  the storage layer — `indexer.download(<root_hash>, ...)` retrieves bytes for anyone who has the
  root hash, uploader identity notwithstanding (`0g-ts-sdk/README.md` download example).
- **Consequence:** a "delete my memory" call cannot physically erase bytes from 0G Storage. The
  only real deletion mechanism available is **crypto-shredding** — discard/rotate the AES key or
  ECIES private key so the ciphertext at the old root hash becomes permanently unrecoverable —
  combined with a logical tombstone entry in the KV layer so the *current* memory view no longer
  surfaces it. This matches the accepted GDPR-blockchain mitigation pattern (§B.3) and is the
  honest phrasing dMemo should use: "forget" = key destroyed + KV tombstone, not "bytes removed
  from the network."
- **Anti-pattern to avoid:** supermemory implements a real, physical `DELETE` semantics
  (`supermemory/packages/tools/src/shared/forget-memory.ts:10-17` — "Marks a memory as forgotten
  via `DELETE /v4/memories`"). Reusing this endpoint's *name* or *semantics* for dMemo without
  re-specifying its *meaning* (crypto-shred, not physical delete) would misrepresent what actually
  happens on 0G.

### C.6 Recovery

- **Not addressed by any 0G repo reviewed** — no native key-recovery mechanism found in
  `0g-ts-sdk`, `0g-storage-kv`, or `0g-compute-ts-sdk`. Standard EVM-wallet recovery (seed phrase)
  is the only path, and per C.1 it doubles as the memory-decryption key if ECIES-to-wallet-pubkey
  is used.
- **Table-stakes requirement:** dMemo must state plainly, up front, that losing the wallet
  key means permanent, unrecoverable loss of all memory — no backdoor, no support-ticket
  recovery. This is the direct cost of satisfying "not your keys, not your data" (§B.1) and must
  be communicated, not buried.
- **Open question / differentiator:** whether to integrate a threshold/social-recovery layer
  (Lit Protocol-style, §B.2) for the memory-encryption key specifically (decoupled from the
  payment wallet) so recovery doesn't require re-custodying the whole wallet. Out of scope for
  MVP; flagged for later.

---

## D. Checklist — requirement → why it matters → 0G-stack satisfaction

| Requirement | Why it matters (community expectation) | How satisfied on 0G stack / open question |
|---|---|---|
| ✅ Client-side encryption before upload | Table stakes; "not your keys, not your data" | `0g-ts-sdk` `EncryptedFile` wraps data pre-Merkle-tree; plaintext never staged unencrypted (`file/EncryptedFile.ts:42-82`) |
| ✅ Keys derived from user's own wallet, not a dMemo-operated server | Self-custody baseline | ECIES mode encrypts to the user's secp256k1 wallet pubkey — same key used for 0G payments (`common/encryption.ts:224-246`) |
| ✅ Authenticated (tamper-evident) encryption | Confidentiality without integrity is an incomplete privacy claim | AES-256-CTR is confidentiality-only by design; integrity comes from dMemo's client-side Merkle-root self-verification against the on-chain root on every download (D9) — the SDK's `with_proof` flag is a no-op and cannot be relied on; mechanism decided, implementation/testing still pending |
| ✅ Verifiable storage availability | "Proofs over promises" | PoRA: storage nodes must cryptographically prove data possession (docs.0g.ai/concepts/storage) |
| ⚠️ Verifiable, confidential inference | Core "private LLM inference" claim | TeeML mode gives true prompt confidentiality (model inside TEE, signed response); TeeTLS mode only proves routing integrity — external provider still sees plaintext. **Open decision: dMemo must pin to TeeML-only providers or disclose per-provider mode** |
| ❌ Metadata-minimized writes (hidden writer identity/cadence) | Differentiator; leakage undermines "private" claim | No native 0G mechanism found. **Open question** — candidate mitigations (sub-wallet rotation, write batching) unexplored |
| ⚠️ Meaningful deletion ("forget") | Regulatory (GDPR-style) and community expectation of user control | No physical erasure possible (append-only Log Layer, unrestricted content-addressed download). Honest equivalent = crypto-shred key + KV tombstone. **Must not replicate supermemory's hard-`DELETE` semantics/wording** |
| ❌ No silent centralized override of stored memory | Self-sovereignty baseline | No dMemo-operated key escrow by design (ties to C.1) — but the always-on-agent key-storage question (C.1 open item) could reintroduce this risk if implemented carelessly |
| ⚠️ Recoverable without a custodian | User expects to not "lose everything" from one mistake, but also expects no backdoor | Wallet seed phrase is the only recovery path today; **must be disclosed clearly as permanent-loss-on-key-loss**. Threshold/social recovery is an open, unbuilt differentiator |
| ✅ Open-source, auditable SDK/contracts | Table stakes for any privacy claim in this audience | 0G SDKs and dMemo's client/contracts (embedding mem0 OSS, Apache-2.0) are inspectable; maintain this posture through ship |

Legend: ✅ verified true today on 0G stack · ⚠️ partially true / conditional on an implementation
decision dMemo hasn't made yet · ❌ not available natively, open question.

---

## E. Key decisions for dMemo (summary)

1. **Use ECIES-to-wallet-pubkey as the default encryption mode**, not a separate symmetric key —
   removes a second secret from the plug-and-play setup (`0g-ts-sdk/src.ts/common/encryption.ts:254-262`).
2. **Self-verify the Merkle root on every download (D9)** — AES-256-CTR has no auth tag, and the
   SDK's `with_proof` flag is a no-op, so integrity verification must happen client-side.
3. **Restrict to (or clearly label) TeeML-only 0G Compute providers** — TeeTLS breaks the
   "private inference" claim for the underlying model provider, even though routing is verified
   (docs.0g.ai/developer-hub/building-on-0g/compute-network/inference).
4. **Do not replicate supermemory's hard-`DELETE` semantics** — dMemo's "forget" must be
   documented as crypto-shred + KV tombstone, never as physical erasure (supermemory's
   `DELETE /v4/memories` is the anti-pattern to avoid: `supermemory/packages/tools/src/shared/forget-memory.ts:10-17`
   vs. `0g-storage-kv/README.md`).
5. **Write an explicit key-custody design for always-on agent runtimes** before shipping the
   coding-agent integrations — this is the single biggest way dMemo could accidentally
   reintroduce a custodial risk despite the underlying stack being self-custodial by default.

---

## Open questions carried forward

- Which 0G Compute marketplace providers currently run TeeML vs. TeeTLS, and is that mode exposed
  in `listService()` metadata for dMemo to filter on programmatically?
- Is there any 0G-native or ecosystem-adjacent (Lit Protocol integration, etc.) primitive for
  metadata minimization (writer-identity/timing obfuscation) that a future dMemo version could
  adopt, or is this a from-scratch design problem?
- Should dMemo decouple the memory-encryption key from the payment wallet key to enable future
  threshold/social recovery without touching funds custody? Not resolved here — flagged as a
  product decision, not a research gap.

---

## Decisions (settled)

| # | Decision | Detail |
|---|---|---|
| D13 | **"Forget" = crypto-shred + tombstone** | Per-epoch sub-keys derived from wallet key, aligned to checkpoint epochs. Wording: "unreadable forever", never "deleted" |
