# 0G Pay & Wallet Funding — Onboarding Follow-up (dMemo)

Scope: how a user with **any** starting condition (no wallet, empty wallet, funds on another
chain, no crypto experience at all) gets to a funded dMemo account with the fewest steps.
Prompted by the gap in `packages/setup-cli`: today's flow assumes the user can already produce
0G, and the only funding help it gives is a testnet faucet link (`src/network.ts:35-43`) or
"fund it yourself" on mainnet (`src/setup.ts:132`).

Everything below marked **[live]** was verified by a real HTTP call made during this pass
(2026-07-25), not read from docs. Raw evidence is inline.

---

## 0. The finding that reframes the problem

**0G Pay does not solve dMemo's funding problem.** It is the payment layer for *0G Private
Computer*, and every rail it offers terminates in a **compute balance tied to a Router API key** —
not as spendable 0G in a wallet.

| | 0G Pay (pc.0g.ai) | What dMemo's memory leg needs |
|---|---|---|
| Output | Compute credits on a Router ledger | Native 0G, on 0G chain, **in the account that signs storage txs** |
| Pays for | Inference tokens (`/v1/chat/completions`) | `FixedPriceFlow` storage fee + gas per flush |
| Withdrawable to a wallet | Not documented | n/a |

So 0G Pay covers **leg 2 (inference)** only. It is genuinely useful there — and it is the answer
for the non-crypto-native inference story — but the memory leg still needs on-chain 0G.

The good news: **the machinery underneath 0G Pay solves our problem directly.** 0G Pay is powered
by Khalani / TokenFlight ("Hyperstream"), and that same service will deliver **native 0G to an
arbitrary address on 0G Mainnet**, paid by card. That is the missing piece.

```
        ┌─────────────────────── what the user has ───────────────────────┐
        │                                                                  │
   nothing at all      empty wallet     funds on Base/ETH/…    native 0G   │
   (no wallet)         (has MetaMask)   (any of 20 chains)     already     │
        │                   │                   │                  │       │
        │                   └───────┬───────────┘                  │       │
        ▼                           ▼                              ▼       │
  ┌───────────┐            ┌─────────────────┐            ┌──────────────┐ │
  │ dmemo     │            │ TokenFlight widget           │ dmemo connect│ │
  │ setup     │            │ card | any-token             │ (dust xfer)  │ │
  │ (local key)│           │ → native 0G                  │  ALREADY     │ │
  └─────┬─────┘            └────────┬────────┘            │  BUILT       │ │
        │                           │                     └──────┬───────┘ │
        └───────────┬───────────────┴────────────────────────────┘         │
                    ▼                                                       │
        native 0G in the dMemo account (0G Mainnet, chain 16661)            │
                    │                                                       │
                    ▼                                                       │
        flushes cost ~0.0012–0.003 0G each (TASKS.md D2)                     │
```

---

## 1. Verified capability matrix

| Rail | Endpoint | Origin-gated? | Callable from Node/CLI? | Delivers native 0G to arbitrary address? | Evidence |
|---|---|---|---|---|---|
| **Card / Apple Pay / Google Pay / SEPA** | `fiat.hyperstream.dev/v1/fiat` | **Yes** — allowlist | No (browser only, allowlisted origin) | **Yes** | **[live]** §1.1 |
| **Any token, any of 20 chains** | `api.hyperstream.dev/v1/quotes` | **No** | **Yes** | **Yes** | **[live]** §1.2 |
| **Native 0G from own wallet** | plain `eth_sendTransaction` | n/a | Yes (already shipped) | Yes | `src/connect.ts:171-190` |
| **gas.zip refuel** | `backend.gas.zip` | No | Yes | **Currently NO — no liquidity** | **[live]** §1.3 |
| **Testnet faucet** | `faucet.0g.ai` | n/a | No (captcha) | 0.1 0G/day, testnet only | `src/network.ts:14` |

### 1.1 Card → native 0G **[live]**

`POST https://fiat.hyperstream.dev/v1/fiat/quote`, `Origin: https://embed.tokenflight.ai`:

```jsonc
// request
{ "inputMode":"fiat", "fiatCurrency":"USD", "fiatAmount":"25",
  "outputAsset":{"chainId":16661,"address":"0x0000…0000"},   // native 0G
  "recipient":"0x…dEaD",                                      // ARBITRARY address
  "paymentMethod":"credit_debit_card", "endUserIp":"8.8.8.8", "country":"US" }

// response (abridged) — a FIRM quote, not an estimate
{ "kind":"firm", "provider":"transak", "swapStrategy":"jump",
  "fiatAmount":"25.00", "totalFee":"2.21",
  "expectedOutputAmount":"127623776702375537058",   // 127.62 0G
  "minOutputAmount":"123795063401304270946",
  "minFiatAmount":"5", "maxFiatAmount":"3000", "slippageBps":300,
  "paymentMethods":[credit_debit_card, apple_pay, google_pay, sepa_bank_transfer] }
```

- Provider is **Transak**; `GET /v1/fiat/config` **[live]** lists currencies `USD/EUR/GBP` and
  requires `origin` + `endUserIp`.
- `swapStrategy: "jump"` — Transak sells USDC-on-Base (`config.jump.intermediateAsset`
  = `8453 / 0x8335…2913`), Hyperstream bridges it to native 0G. Transak never needs to list 0G.
- KYC applies (Transak's, country-dependent), per the 0G Pay blog post.

**Fee curve [live]** — fee is large at small size, so default the amount sensibly:

| Buy | Fee | You receive | ≈ flushes @0.003 0G |
|---|---|---|---|
| $5 (minimum) | $1.24 (**24.8%**) | 20.99 0G | ~7,000 |
| $25 | $2.21 (8.8%) | 127.62 0G | ~42,000 |
| $100 | $5.85 (5.9%) | 527.65 0G | ~175,000 |

Even the $5 floor buys thousands of memory writes. **$25 is the right default** — the fee curve
flattens there and it is a rounding error per write.

### 1.2 Any token on any chain → native 0G **[live]**

`POST https://api.hyperstream.dev/v1/quotes` — **no origin header sent, and it worked**:

```jsonc
// 5 USDC on Base → native 0G, arbitrary recipient
{ "quoteId":"ca9f2c32-…",
  "routes":[{"routeId":"Hyperstream","type":"native-filler","depositMethods":["TRANSFER"],
             "quote":{"amountIn":"5000000","amountOut":"28173500115721630317",  // 28.17 0G
                      "expectedDurationSeconds":10}}] }
```

Supported chains **[live]** `GET /v1/chains` → 20 chains, and **`16661 "0G Mainnet"` is one of
them** (alongside Ethereum, Base, Arbitrum, OP, Polygon, BNB, Avalanche, Linea, Monad, Berachain,
Mantle, ZKsync, Unichain, Katana…). **16602 (Galileo testnet) is not** — see §3.

Because this rail is un-gated and has a `POST /v1/deposit/build` + `/v1/deposit/submit` pair
(`@tokenflight/api` `dist/hyperstream-api.d.ts:49-91`), the CLI could quote and build the deposit
transaction itself and hand the browser only a signature request. `referrer` / `referrerFeeBps`
fields exist on `QuoteRequest` — dMemo should send neither (or 0).

### 1.3 gas.zip is listed but dead for 0G **[live]**

`GET backend.gas.zip/v2/chains` returns 0G with `{"chain":16661,"short":508,"inbound":true,
"maxOutbound":2000,"bal":"711064994989183686488"}` — but every quote fails:

```
GET /v2/quotes/8453/200000000000000/508
→ {"quotes":[{"chain":508,"error":"Quote: Insufficent Liquidity"}]}   // also from chain 1, all sizes
```

Refueler balance is ~711 0G (≈$125). **Do not build on this rail.** Recorded so nobody re-derives it.

---

## 2. The integration unlock: the hosted widget is fully URL-configurable

The card rail's origin allowlist looked like a blocker — `http://127.0.0.1:7777`,
`https://dmemo.ai`, `https://hub.0g.ai` all return **[live]** `{"message":"origin is not allowed"}`.
Only `https://embed.tokenflight.ai` priced the request.

The way around it is not partner registration. **TokenFlight's hosted widget reads its entire
configuration from query parameters**, so an `<iframe>` (or a plain browser tab) pointed at
`https://embed.tokenflight.ai/widget/?…` runs the fiat calls from *its own* allowlisted origin.

Param parser, verbatim from `@tokenflight/swap@0.4.5` `dist/iframe-entry.js`
(`new URLSearchParams(location.search)`), full accepted set:

```
api-endpoint  fiat-api-endpoint  integrator-id  theme  locale
from-token  to-token  trade-type  quote-card  amount  recipient  methods
title-text  hide-title  hide-powered-by  transfer  transfer-config-url
lock-from-token  lock-to-token  refund-to  recipient-editable  refund-to-editable
```

Which means the whole funding UI for dMemo is one URL — **no npm dependency, no bundler, no
Reown project id, no partner onboarding**:

```
https://embed.tokenflight.ai/widget/
  ?to-token=eip155:16661:0x0000000000000000000000000000000000000000
  &lock-to-token=true
  &recipient=<the dMemo account>
  &recipient-editable=false
  &methods=["crypto","card"]
  &amount=25&trade-type=EXACT_INPUT
  &title-text=Fund+your+dMemo+account&theme=dark
```

That matters a lot given the constraint recorded in `src/connect/page.ts:1-20`: the loopback page
is hand-written, bundler-free, and makes **no external requests**. An iframe is the only shape of
this that respects that decision — we embed a URL, we don't vendor a toolchain.

> **Not verified:** the widget *rendering* correctly with these params. Three attempts to
> screenshot it in Chrome failed (`Page still loading` / `Frame with ID 0 was removed`) — the
> widget's live quote-streaming appears to keep the page from ever reaching `document_idle`.
> The parameter names come from reading the shipped parser and the quotes come from the live API,
> so the contract is solid, but **someone should eyeball the rendered widget before we ship it.**
> This also means the iframe embed brings dMemo's first external network dependency — a change to
> the "no external requests" rule that should be a deliberate, disclosed decision, not a side effect.

---

## 3. Testnet has no funding rail at all

TokenFlight's chain list **[live]** contains 16661 only. There is no fiat or crosschain path to
Galileo (16602), and there never will be — nobody sells testnet tokens.

| Network | Funding options |
|---|---|
| Testnet 16602 | `faucet.0g.ai` only: 0.1 0G/day, captcha + cooldown, some mirrors gate on holding ≥0.005 mainnet ETH |
| Mainnet 16661 | card, 20-chain crypto, native 0G, CEX withdrawal ("0G Chain"/"0G Mainnet" network), XSwap/CCIP `xswap.link/bridge?toChain=16661`, `hub.0g.ai/khalani/transfer` |

dMemo currently defaults to `testnet` (`src/setup.ts:95`). **The funding work described here is
inherently a mainnet feature.** Anyone we onboard onto testnet still hits the captcha faucet, and
0.1 0G/day is ~33–80 flushes/day. That is fine for evaluation, not for daily use — which makes
"when does the default flip to mainnet?" a product question this research surfaces but can't answer.

---

## 4. The non-crypto-native user

Two separate stories, and only one of them was ever a real problem.

**Memory leg — already solved, and better than expected.** `dmemo setup` generates a local key
(`src/wallet.ts:15-18`); its address is just an address. TokenFlight will deliver card-bought 0G to
*any* address. So the no-wallet user needs **no wallet software, no seed phrase, no extension, no
exchange account** — they run `dmemo setup`, we open a funding URL with their address baked in,
they pay with Apple Pay, and they're done. The wallet-connect flow (`dmemo connect`) stays the
*power-user* path — it exists to make the account reproducible across machines
(`src/connect.ts:22-25`), which is a different benefit from "getting funds in".

**Inference leg — this is where 0G Pay is the answer.** `pc.0g.ai` signs in with Google, X,
Discord or TikTok and **provisions an embedded Privy wallet** (docs.0g.ai Router FAQ), then 0G Pay
tops up the compute balance by card. A user with no crypto whatsoever can obtain an `sk-` Router
key. That directly retires the "interactive web step, cannot be scripted" caveat in
`src/setup.ts:60-76` — it's still interactive, but it no longer requires *owning crypto*, which is
the part that actually blocked people. The instructions should say so.

---

## 5. Key decisions

| # | Decision | Why | Reference |
|---|---|---|---|
| **D19** | Treat 0G Pay as the **inference-leg** answer only; never as a way to fund storage | Every 0G Pay rail terminates in a Router compute balance, not a wallet; storage txs are signed by the dMemo account and paid in on-chain 0G | 0g.ai/blog/0g-pay-credit-cards; docs.0g.ai Router FAQ; TASKS.md D2 |
| **D20** | Fund the memory leg through the **hosted TokenFlight widget by URL**, embedded as an iframe — not the npm package, not a partner-registered dMemo origin | Package needs a bundler + Reown id, which `page.ts:1-20` deliberately refuses; a self-hosted origin is rejected by the fiat allowlist **[live]**; the hosted widget takes full config via query params | `iframe-entry.js` param parser; **[live]** origin-allowlist probes |
| **D21** | Offer **card and crosschain in one widget**, with `to-token` locked to native 0G and `recipient` locked to the dMemo account | One UI covers "no funds", "funds elsewhere" and "wrong network"; locking removes the two things a user can get catastrophically wrong (send to the wrong address, buy the wrong asset) | `lock-to-token` / `recipient-editable=false` **[live]** in param set |
| **D22** | Default the purchase to **$25**, floor $5 | Fee is 24.8% at $5 but 8.8% at $25 and 5.9% at $100; $25 ≈ 42,000 flushes | fee curve **[live]** §1.1 |
| **D23** | **Do not** build on gas.zip | Listed for 0G but returns `Insufficent Liquidity` for every route and size tested | **[live]** §1.3 |
| **D24** | Keep `dmemo setup`'s locally-generated key as the **default** onboarding path; `dmemo connect` stays opt-in | A generated address can receive card-bought 0G with no wallet software at all; connect's value is cross-machine reproducibility, not funding | `src/wallet.ts:15-18`; `src/connect.ts:22-25` |

---

## 6. Open questions

| # | Question | Status |
|---|---|---|
| 1 | **When does dMemo default to mainnet?** Every rail here is mainnet-only. | **Resolved** — mainnet is now the default (`setup.ts`, `connect.ts`); testnet is `--network testnet`. |
| 2 | **Does the widget render correctly with our params?** | **Still open** — see below. |
| 3 | **Does the iframe survive a `127.0.0.1` parent?** | **Resolved** — no `X-Frame-Options`, no `frame-ancestors` on `embed.tokenflight.ai`. Framing is permitted. A new-tab escape hatch ships anyway, for nested permission delegation (Transak's KYC camera capture). |
| 4 | **Post-funding detection.** | **Resolved** — implemented as balance polling, exactly as proposed. The order API is never called; the widget is cross-origin and its order id is unreachable, and money landing on chain is the fact we actually care about. |
| 5 | **`integrator-id`** | **Open, non-blocking** — worth asking Khalani whether registering one gets better fees or support. Nothing requires it. |

### On #2 — the visual check is still owed, and the earlier diagnosis was wrong

The research draft blamed the failed screenshots on the widget's live quote-streaming keeping the
page from reaching `document_idle`. That was wrong. dMemo's **own** fund page — static, local,
and with the balance poll stripped out entirely — fails the same way in the same tooling. So the
failure says nothing about TokenFlight; it is the browser automation in this environment.

Consequence: the widget's rendered appearance under our exact parameters remains **unverified**,
and cannot be verified this way. The parameter contract is solid (parser read from the shipped
bundle, quotes taken live from the API), and the tests pin every fund-safety property that does
not require pixels — destination locked, CSP widened by `frame-src` alone, no iframe in the
served markup. What is left is genuinely a human "does this look right", one tab, one minute:

```
npx @dmemo/cli fund --usd 25        # then click "Pay by card"
```

---

## 7. What shipped

| Piece | File |
|---|---|
| Shared loopback transport (extracted so `connect` and `fund` cannot drift) | `src/loopback.ts` |
| Widget URL builder, fiat bounds, cost constants | `src/network.ts` |
| Funding page — wallet / card / cross-chain, iframe lazy-loaded | `src/fund/page.ts` |
| Fund loopback server, `FUND_CSP`, cached balance reads | `src/fund/server.ts` |
| `runFund()` orchestrator | `src/fund.ts` |
| Tests (12 new) | `src/fund/server.test.ts` |

Two properties worth restating because they are the ones a future change is most likely to break:

1. **The iframe is not created until the user clicks a card/crypto option.** A user funding from a
   wallet they already have makes zero external requests, which keeps `connect/page.ts:18`'s "no
   external requests" rule true for everyone who isn't opting into the payment rail. `fund/server.test.ts`
   asserts no `<iframe>` appears in the served markup.
2. **"Funded" is read off the chain, never asserted by the page.** `/api/complete` re-reads the
   balance and ignores a `funded: true` the browser claims — there is a test that sends exactly
   that lie and requires the result to come back `funded: false`.
