# Follow-up: Can mem0 Run Remotely "on 0G" (Convex-style server functions next to storage)?

Research date: 2026-07-25. Repos cloned into scratchpad (`0g-compute-ts-sdk`, `0g-serving-broker`, `0g-tapp`); docs read from docs.0g.ai; GitHub orgs `0glabs`/`0gfoundation` enumerated via `gh api`.

## High Level Overview

**Local-engine (current dMemo architecture):**
```
User's machine
 ├── mem0 engine (fact extraction, embedding, vector search) — runs in-process
 ├── plaintext memory only ever exists here
 ├── encrypts state → writes append-only blob → 0G Storage (1 tx/write, Galileo/Aristotle L1)
 └── LLM calls → 0G Compute Router (router-api.0g.ai/v1, OpenAI-compatible, TeeML providers)
```

**Hypothetical remote-engine (Convex "use node" analogy):**
```
User's machine
 └── sends {query} ──────────────► Remote runtime "near" 0G Storage
                                     ├── decrypts memory blob (needs plaintext or a TEE)
                                     ├── runs mem0 (embed, vector search, extract)
                                     └── returns {result} only
```
**Verified finding: no such remote runtime exists as a native 0G product today.** 0G Storage nodes are dumb blob stores; 0G Compute Network is an inference/fine-tuning marketplace with fixed service types; the only thing that looks like generic remote compute (0G Tapp) is a self-operate-your-own-TEE-VM toolkit, not a "submit code, someone else's node runs it" marketplace. Details below.

---

## Q1 — What does 0G Compute Network support beyond LLM inference?

| Aspect | Finding | Reference |
|---|---|---|
| Ledger-level service types | Enum is exactly `'inference' \| 'fine-tuning'` — no third option | `0g-compute-ts-sdk/src.ts/sdk/ledger/ledger.ts`, `broker.ts:236,260,281,303` |
| Inference `serviceType` values | `chatbot` (OpenAI chat-completions), `text-to-image`, `image-editing`, `speech-to-text` — a fixed enum, not free-form | `0g-compute-ts-sdk/src.ts/cli/inference.ts:358-621`; https://docs.0g.ai/build-with-0g/compute-network/provider (lists exactly these 3 categories + chatbot) |
| Provider contract | Every provider exposes an OpenAI-compatible HTTP interface; the broker verifies request/response token counts against that contract | `0g-serving-broker` README; `0g-compute-ts-sdk/src.ts/example/inference-server.ts:60-` (proxy re-implements OpenAI chat schema) |
| Fine-tuning | Fixed pipeline: JSONL dataset in → LoRA adapter out, "Do not add or remove parameters" from the config template. Not generic compute. | https://docs.0g.ai/developer-hub/building-on-0g/compute-network/fine-tuning |
| Custom/arbitrary services on the inference marketplace | **Not supported.** Docs and SDK never expose a way to register a service outside the fixed `serviceType` enum; the on-chain `InferenceServing`/`LedgerManager` contracts settle by service type, not by arbitrary interface | `0g-compute-ts-sdk/src.ts/sdk/ledger/contract/typechain/LedgerManager.ts:29,40`; provider docs above |
| Third-party registering a *custom* mem0-shaped service on someone else's provider node | **Not possible.** A provider is one operator's own container behind their own broker; there's no "deploy my code to your GPU" flow in the inference marketplace. The only way to expose custom logic is to *become the provider yourself* and shoehorn it behind the OpenAI chat-completions interface (hacky, unsupported, breaks the billing model which prices by token count) | `0g-serving-broker/doc/design-doc.md` (provider registers `service type/url/name/price`, url = the provider's own endpoint) |

**Verdict Q1:** 0G Compute Network is a two-product marketplace (inference, fine-tuning), both schema-constrained, both OpenAI-API-shaped. It is not a serverless/FaaS platform. A third party cannot register a "mem0 server" as a new service type.

---

## Q2 — Does 0G Storage have any query-time compute? (confirm prior finding)

| Component | Finding | Reference |
|---|---|---|
| Storage nodes | Serve raw content-addressed segments only; no stored procedures, no server-side functions | `0g-storage-node` repo (not re-audited this pass; consistent with prior research) |
| `0g-storage-kv` (zgs_kv) | **Confirmed unchanged**: "Users who wish to use KV can set up a service called KV Node themselves. This service monitors, downloads and deserializes KV files. It then reconstructs the KV database locally by replaying the KV database operations contained in the KV files." Self-hosted replay daemon, 4GB RAM / 2 core minimum, no compute-over-data | `0g-storage-kv/README.md` (fetched raw, this pass) |
| `0g-storage-map` | Sibling KV-style repo, last pushed Oct 2024 — stale, same replay-daemon model, no new primitive | `gh api repos/0gfoundation/0g-storage-map` (pushed_at: 2024-10-17) |
| Vector search primitive | None found anywhere in 0G Storage docs or repos | — |

**Verdict Q2:** No change from prior research. 0G Storage has zero query-time compute of any kind.

---

## Q3 — Any announced/roadmap product for general compute, serverless, agent runtimes, or verifiable compute beyond inference?

| Candidate | What it actually is | Is it "run arbitrary code near 0G data"? | Reference |
|---|---|---|---|
| **0G Tapp** ("Trusted Application Platform") | A toolkit (Rust `tapp-service` + `tapp-cli` + `TappRegistry.sol`) that lets **you** run a TEE-measured Docker Compose stack on **your own** TDX/SEV/SGX cloud VM (Alibaba Cloud confidential ECS or GCP TDX image), then register the app + node on-chain for attestation/verification. Deployer boots the VM, runs `tapp-service`, claims ownership, deploys any `docker-compose.yml` via `tapp-cli start-app`. | **Closest thing that exists**, but it is self-operated infrastructure, not a shared marketplace where a third party submits code to someone else's already-running node. You still stand up and pay for the TEE VM yourself. Currently testnet only (`evmrpc-testnet.0g.ai` in every example, no mainnet contract address published); primary docs live in a **Notion page**, not docs.0g.ai — i.e. not yet part of the mainstream developer hub | `0g-tapp/README.md:1-470` (cloned this pass); `0g-tapp/contract/src/TappRegistry.sol`; DeepWiki https://deepwiki.com/0gfoundation/0g-tapp/7-smart-contract-layer (staking/minStakeAmount/lockPeriod confirmed, but doc explicitly could not confirm whether node registration is open to arbitrary third parties or how many operators exist) |
| **ERC-7857 / iNFT** | Pure ownership/metadata standard for encrypting and transferring "agent" state (weights/config) between owners via a trusted-oracle re-encryption flow. **Not an execution layer** — actual inference is explicitly delegated to the existing 0G Compute inference marketplace (`ogCompute.executeSecure(...)` in the docs example) | No — confirms execution still routes through Q1's fixed inference marketplace | https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857 |
| **0g-agent-nft, 0g-inft-oracle-server-ts** | Support infra for ERC-7857 (oracle that does the re-encrypt-on-transfer step) | No — narrow, single-purpose oracle service, not general compute | `gh api repos/0gfoundation/0g-agent-nft` (repo exists, no description) |
| **0G App** (app.0g.ai) | Consumer-facing "chat, build, deploy AI from browser" product launched 2026; per 0G's own blog, "AI inference runs inside sealed hardware enclaves and conversations sync to decentralized storage" — this is 0G's own product built **on top of** the inference marketplace + Storage, not a platform third parties can deploy custom services into | https://0g.ai/blog/0g-app-is-live |
| **0G DA** | Data-availability layer for rollups/scaling — no compute semantics at all, orthogonal to this question | `0g-da-*` repos (not deep-dived; out of scope, no compute claims found) |
| Explicit "serverless"/"general compute"/"verifiable compute" roadmap page | **Not found.** No roadmap doc or blog post announces a FaaS-style or "run any container as a paid service" product distinct from Tapp | targeted web search returned nothing on docs.0g.ai |

**Verdict Q3:** Nothing shaped like AWS Lambda/Convex functions exists as a shared marketplace. 0G Tapp is real, active (recent GCP/TDX build scripts added), and technically capable of running arbitrary containers under attestation — but it's a "bring your own confidential VM" toolkit, currently testnet, not officially documented on docs.0g.ai.

---

## Q4 — TEE angle: could a mem0 service run inside a 0G TEE such that plaintext is only ever decrypted in the enclave?

| Question | Finding |
|---|---|
| Is TEE (TeeML) strictly for the inference marketplace? | As shipped and documented on docs.0g.ai: **yes** — TeeML/TDX+H100/H200 requirements are described only in the context of inference providers (`0g-serving-broker` README: "TEE Verification (TeeML) requires: Intel TDX enabled CPU, NVIDIA H100 or H200 GPU with TEE support") |
| Is there ANY documented path to run a *custom, non-inference* workload in a 0G-affiliated TEE? | **Yes, via 0G Tapp** — genuinely general-purpose (any Docker Compose app), with a real "Malicious Deployer" security model: deployer cannot access secrets/memory of the running app once measured and claimed; KMS cluster can hand the app secrets that are only ever decrypted inside the enclave; attestation binds a TEE-derived signer address to the on-chain `TappRegistry` entry | `0g-tapp/README.md` sections "Security Model," "Claiming Ownership," "On-chain Registration" |
| Could dMemo run mem0 there today? | Technically plausible as engineering, but: (1) dMemo must provision and pay for its own TDX/SEV-capable cloud VM (Alibaba confidential ECS or GCP TDX image) — this is infra dMemo operates, not something 0G operates for you; (2) it's testnet-grade tooling with docs on Notion, not GA; (3) it's a separate product from both 0G Storage and 0G Compute (inference) — no integration point exists today that lets a Storage read/write or an inference call transparently route through a Tapp instance |
| Is this "TEE compute marketplace" the same kind of rent-a-provider model as inference? | Not established. `TappRegistry` has staking (`minStakeAmount`, `lockPeriod`) suggesting a multi-operator design is *intended*, but neither the README nor DeepWiki confirms permissionless third-party node operation is live, nor how many (if any) independent node operators exist beyond 0G's own testnet instance |

**Verdict Q4:** TEE is not hard-locked to inference only — 0G Tapp is a genuine, separate path to run custom code (including a memory service) under hardware attestation. But using it means **dMemo operates the enclave**, on testnet-maturity tooling, with no current product integration between Tapp and 0G Storage/Compute.

---

## Q5 — Reality check: what would remote execution mean for dMemo's privacy claims?

| Model | Plaintext memory exposure | Who operates the server | Decentralization impact | Verifiability |
|---|---|---|---|---|
| **Local mem0 (current)** | Never leaves user's machine | Nobody — no server | None to defend (no centralized dependency for compute) | User trusts their own machine |
| **Remote mem0 on a plain server (no TEE)** | Fully exposed in plaintext to whoever operates that server (vector search over ciphertext is not practical with current mem0/pgvector — needs plaintext) | Whoever runs the server — if dMemo runs it, it's dMemo's centralized backend | **Defeats the decentralization claim outright**: dMemo becomes a classic SaaS memory vendor sitting in front of 0G Storage as a cache/DB, no different from any centralized memory API | None — user must trust dMemo's ops security |
| **Remote mem0 inside a 0G Tapp TEE, dMemo-operated** | Decrypted only inside the enclave; dMemo (the deployer/node operator) cannot read plaintext per Tapp's "Malicious Deployer" model, *if* the attestation and KMS flow is used correctly | **dMemo** (provisions the confidential VM, deploys the container) | Centralizes *infrastructure operation* in dMemo (single or few nodes dMemo controls) even though the *trust* model is hardware-enforced rather than dMemo-trusted — a meaningfully weaker centralization claim than "there is no server at all," but strictly better than a plain server, and it is attestable/verifiable by users | Yes — remote attestation lets a user cryptographically verify what code is running before trusting it with decrypted memory |
| **Remote mem0 on 0G's own inference-marketplace TEE providers** | Not available — inference providers only expose an OpenAI chat-completions surface; there is no way to run mem0's vector-search/add/search operations through that interface without abusing it as a "chat" call, which the billing/verification logic isn't designed for | 0G's third-party inference providers | Would be attractive (genuinely decentralized, many operators) if it existed, but it **doesn't** — confirmed in Q1 | N/A |

**Honest assessment:** A Convex-style "runtime lives next to the database, execute at query time" model is not offered by 0G Storage at all, and the closest thing on the compute side (Tapp) still requires dMemo to stand up and operate its own server — the privacy story downgrades from "plaintext never leaves your machine" to "plaintext only decrypted inside a TEE dMemo controls, verifiable by attestation," and the decentralization story downgrades from "no server dependency" to "single/few dMemo-operated enclaves on infra dMemo pays for." That's a real trade-off, not a free upgrade.

---

## Q6 — mem0 self-hosted server (reference only)

| Item | Detail |
|---|---|
| Location | `mem0ai/mem0` repo, `server/` directory |
| Stack | FastAPI (REST API) + Postgres w/ `pgvector` (embeddings) + optional Neo4j (graph/entity relationships) |
| Deployment | `docker-compose up` → API on :8888, Postgres on :8432, Neo4j HTTP on :8474 |
| Requirements | Docker + Docker Compose, an LLM/embedding API key (e.g. `OPENAI_API_KEY`) |
| What running it "remotely" would take | A VPS/cloud host running the compose stack, TLS termination, auth in front of the API, DB backups/ops, key management for the LLM provider — i.e. dMemo (or the user) operating a conventional centralized server. No relation to 0G infrastructure. |

Sources: https://docs.mem0.ai/open-source/setup, https://mem0.ai/blog/self-host-mem0-docker

---

## Verdict

**Is a Convex-like "run mem0 at the storage" model possible on 0G today? — No, not natively, and not without dMemo standing up and operating its own server.**

- 0G Storage: confirmed zero query-time compute (Q2) — there is nothing "next to the database" the way Convex's Postgres + Node functions sit together.
- 0G Compute Network (inference/fine-tuning marketplace): confirmed schema-locked to OpenAI-shaped inference and a fixed fine-tuning pipeline; no path for a third party to register a custom "mem0" service type (Q1).
- The only genuine general-purpose, attestable compute primitive in the 0G ecosystem is **0G Tapp**, and it is a self-operate-your-own-confidential-VM toolkit (testnet, Notion-only docs), not a marketplace that runs your code on someone else's hardware on demand (Q3, Q4).
- ERC-7857/iNFT is ownership/metadata only; it explicitly delegates execution back to the same fixed inference marketplace (Q3).

**Nearest viable alternatives, ranked:**
1. **Stay local (current architecture)** — the only model with zero server dependency and zero new privacy surface. Recommended default.
2. **dMemo-operated mem0 service inside a 0G Tapp TEE, opt-in** — closest thing to the Convex analogy that's technically buildable today. Gives users hardware-attested "dMemo can't read your plaintext" instead of "no server exists at all." Requires dMemo to build and operate real infrastructure (provision a TDX/SEV cloud VM, run `tapp-service`, integrate `tapp-cli`/`TappRegistry` registration, handle KMS-based secret delivery) — this is new infra dMemo would own end-to-end, on tooling that is currently testnet-maturity and not part of 0G's supported developer hub. Should be flagged to users as "opt-in remote mode," never the default, given the maturity level.
3. **mem0 self-hosted server as opt-in (no 0G TEE)** — simplest to build (it's already a Docker Compose app upstream) but is a plain centralized server with full plaintext exposure to whoever runs it; weakest privacy story of the three; only differs from option 2 by lacking the TEE attestation layer.
4. **Wait for 0G to productize a shared TEE compute marketplace** (Tapp reaching mainnet + multi-operator staking actually live + docs.0g.ai coverage) — would turn option 2 into something closer to true decentralization, but this is speculative; no committed timeline was found.

---

## Key decisions and reasons

| Decision | Reason | Reference |
|---|---|---|
| Do not build a "remote mem0 on 0G Compute inference marketplace" | The marketplace's service types are hard-enumerated (`chatbot`, `text-to-image`, `image-editing`, `speech-to-text`) at both the SDK and on-chain contract level; there's no registration path for a custom service | `0g-compute-ts-sdk/src.ts/cli/inference.ts:358-621`, `LedgerManager.ts:29` |
| Do not treat 0G Storage KV as a compute layer | Confirmed (again) it's a self-hosted event-replay daemon with no stored procedures or query-time logic | `0g-storage-kv/README.md` |
| Flag 0G Tapp as "build new infra," not "use native 0G feature" | It requires dMemo to provision/operate its own confidential VM; it is not a service 0G runs on dMemo's behalf, and it's testnet/Notion-doc maturity | `0g-tapp/README.md` |
| Reject "abuse inference chat-completions endpoint to smuggle mem0 calls" | Billing/verification in the broker is tied to token-counted chat semantics; would be unsupported, fragile, and defeat the fee model | `0g-serving-broker/doc/design-doc.md` |

## Open questions

1. Is 0G Tapp's `TappRegistry` staking model actually permissionless for third-party node operators today, or is 0G currently the sole node operator? DeepWiki and the README don't say; would need to ask the 0G team directly or find a live testnet node list.
2. Does 0G have any private roadmap (beyond public docs/GitHub) for a shared TEE-compute marketplace analogous to the inference marketplace but for arbitrary services? Not found in public sources — worth a direct question to 0G Labs/Foundation.
3. If dMemo ever pursued the Tapp route, what's the actual mem0-in-TEE performance/cost profile (embedding + vector search inside a TDX VM with KMS-fetched secrets) — not evaluated here, flagged as future work if option 2 is pursued.
4. Whether 0G Tapp has any mainnet contract deployment yet (all examples found used `evmrpc-testnet.0g.ai`) — needs a direct check against `0gchain-Aristotle` mainnet contract addresses if this path is pursued further.

---

## Decisions (settled)

| # | Decision | Detail |
|---|---|---|
| D12 | **Runtime stays local** — no remote mem0 | 0G has no query-time compute; Compute marketplace is schema-locked (inference/fine-tuning only). 0G Tapp TEE = parked as possible opt-in v2 (testnet-maturity, dMemo-operated infra) |
