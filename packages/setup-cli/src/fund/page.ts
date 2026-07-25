// The page `dmemo fund` serves on loopback.
//
// This exists because `connect` only ever solved ONE funding scenario: you
// already hold native 0G, on 0G, in a browser wallet. Everything else — funds
// on another chain, no funds at all, no wallet at all — hit a dead end. See
// research/0g-pay-funding.md for the rails behind the other two paths.
//
// THE EXTERNAL-REQUEST EXCEPTION. `connect/page.ts:18` states the rule this
// page bends: "No external requests of any kind: no CDN, no fonts, no
// analytics." The card and cross-chain paths are a hosted third-party widget
// (embed.tokenflight.ai) and cannot be anything else — the fiat API is
// origin-allowlisted and refuses 127.0.0.1, so only a page served from an
// allowlisted origin can price a card purchase.
//
// So the exception is scoped as tightly as it can be:
//   - the iframe is NOT created until the user clicks the card/crypto option.
//     A user who funds from a wallet they already have makes zero external
//     requests, exactly as before.
//   - CSP allows exactly one extra origin, for framing only. No script-src,
//     no connect-src, no img-src widening — the widget cannot reach back.
//   - the widget is cross-origin, so it cannot read this page, and this page
//     cannot read it. Completion is detected by watching the CHAIN (balance
//     polling), never by trusting a message from the widget.
//   - every parameter that could redirect funds is locked (see
//     `tokenflightWidgetUrl`), and a "open in a new tab" escape hatch is
//     always offered in case nested-iframe permission delegation breaks
//     Transak's KYC capture.

import { escapeHtml, embedJson as embed } from '../loopback.js';

export interface FundPageOptions {
  token: string;
  address: string;
  network: 'testnet' | 'mainnet';
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  currencySymbol: string;
  balanceLabel: string;
  /** Default amount the "send from a wallet" path offers, in 0G. */
  fundAmountLabel: string;
  fundAmountWeiHex: string;
  /** Absent on testnet — no fiat or cross-chain rail reaches chain 16602. */
  widgetUrl?: string;
  faucetUrl?: string;
  costLow: number;
  costHigh: number;
  /** Human framing for the default buy, e.g. "$25 ≈ 42,000 writes". */
  valueHint?: string;
}

export function renderFundPage(opts: FundPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Fund your dMemo account — dMemo</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e5e7eb;
    --card: #fafafa; --accent: #4f46e5; --accent-fg: #ffffff;
    --ok: #15803d; --err: #b91c1c; --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0f14; --fg: #e8eaed; --muted: #9aa1ac; --line: #262a33;
      --card: #14171f; --accent: #6366f1; --accent-fg: #ffffff;
      --ok: #4ade80; --err: #f87171; --warn: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 34rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .9rem; }
  .panel {
    border: 1px solid var(--line); background: var(--card);
    border-radius: .7rem; padding: 1.1rem;
  }
  .account { margin-bottom: 1rem; }
  .account .label { font-size: .8rem; color: var(--muted); }
  .addr {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .82rem; word-break: break-all; background: var(--bg);
    border: 1px solid var(--line); border-radius: .45rem; padding: .5rem .6rem;
    margin: .4rem 0 .5rem;
  }
  .bal { font-size: .88rem; }
  .bal b { font-variant-numeric: tabular-nums; }
  button {
    font: inherit; cursor: pointer; border-radius: .55rem;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
    padding: .7rem .85rem; display: flex; align-items: center; gap: .65rem;
    width: 100%; text-align: left;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .55; cursor: default; }
  button.primary {
    background: var(--accent); color: var(--accent-fg);
    border-color: var(--accent); justify-content: center; font-weight: 560;
  }
  button img { width: 1.5rem; height: 1.5rem; border-radius: .3rem; flex: 0 0 auto; }
  .options { display: grid; gap: .55rem; }
  .options button { flex-direction: column; align-items: flex-start; gap: .15rem; }
  .options button .t { font-weight: 560; }
  .options button .d { font-size: .82rem; color: var(--muted); font-weight: 400; }
  .panel button + button, .panel .note + button { margin-top: .5rem; }
  .note { font-size: .82rem; color: var(--muted); margin-top: .85rem; }
  .msg { margin-top: 1rem; font-size: .88rem; }
  .msg.err { color: var(--err); }
  .msg.ok { color: var(--ok); }
  .msg.warn { color: var(--warn); }
  .back {
    width: auto; padding: .35rem .6rem; font-size: .82rem; margin-bottom: .75rem;
  }
  iframe {
    width: 100%; height: 34rem; border: 1px solid var(--line);
    border-radius: .6rem; background: var(--bg); display: block;
  }
  .spinner {
    display: inline-block; width: .85rem; height: .85rem; border-radius: 50%;
    border: 2px solid var(--line); border-top-color: var(--accent);
    animation: spin .7s linear infinite; vertical-align: -.1rem; margin-right: .4rem;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Fund your dMemo account</h1>
  <p class="sub">Writing a memory costs a small amount of ${escapeHtml(opts.currencySymbol)}
  (about ${opts.costLow}–${opts.costHigh} per write) on ${escapeHtml(opts.chainName)}.
  This account only ever pays those fees.</p>

  <div class="panel">
    <div class="account">
      <div class="label">Your dMemo account</div>
      <div class="addr" id="addr"></div>
      <div class="bal">Balance: <b id="bal">${escapeHtml(opts.balanceLabel)}</b>
        ${escapeHtml(opts.currencySymbol)} <span id="balnote" class="note" style="margin:0"></span></div>
    </div>
    <div id="body"></div>
  </div>
  <div class="msg" id="msg"></div>
</main>

<script>
(function () {
  "use strict";

  var CFG = ${embed({
    token: opts.token,
    address: opts.address,
    network: opts.network,
    chainIdHex: opts.chainIdHex,
    chainName: opts.chainName,
    rpcUrl: opts.rpcUrl,
    currencySymbol: opts.currencySymbol,
    fundAmountLabel: opts.fundAmountLabel,
    fundAmountWeiHex: opts.fundAmountWeiHex,
    widgetUrl: opts.widgetUrl || null,
    faucetUrl: opts.faucetUrl || null,
    valueHint: opts.valueHint || null,
  })};

  var bodyEl = document.getElementById("body");
  var msgEl = document.getElementById("msg");
  var balEl = document.getElementById("bal");
  var balNoteEl = document.getElementById("balnote");
  document.getElementById("addr").textContent = CFG.address;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function say(text, kind) {
    msgEl.className = "msg" + (kind ? " " + kind : "");
    msgEl.textContent = text || "";
  }

  function busy(text) {
    msgEl.className = "msg";
    msgEl.innerHTML = '<span class="spinner"></span>';
    msgEl.appendChild(document.createTextNode(text));
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dmemo-token": CFG.token },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new Error((json && json.error) || ("request failed (" + res.status + ")"));
        return json;
      });
    });
  }

  function fail(err) {
    var m = (err && (err.message || err.reason)) || String(err);
    if (err && err.code === 4001) m = "Request rejected in your wallet. You can try again.";
    say(m, "err");
    post("/api/error", { message: m }).catch(function () {});
  }

  // ---- balance polling ----------------------------------------------------
  // The ONLY completion signal. We never ask the widget how its order went:
  // it is cross-origin so we could not read it anyway, and a submitted form
  // is not the same fact as money arriving. Watching the chain is both
  // simpler and the thing we actually care about.
  //
  // Node owns the RPC call and caches it, so this poll is cheap regardless of
  // how often it runs.
  var polling = false;
  var done = false;

  function poll() {
    if (done) return;
    fetch("/api/balance", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dmemo-token": CFG.token },
      body: "{}"
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (done || !res || typeof res.balanceLabel !== "string") return;
      balEl.textContent = res.balanceLabel;
      if (res.funded) {
        done = true;
        renderDone(res.balanceLabel);
      }
    }).catch(function () { /* transient; the next tick retries */ });
  }

  function startPolling(note) {
    balNoteEl.textContent = note || "";
    if (polling) return;
    polling = true;
    setInterval(poll, 4000);
    poll();
  }

  // ---- landing: pick a path ----------------------------------------------
  function renderOptions() {
    bodyEl.innerHTML = "";
    var list = el("div", "options");

    function option(title, detail, onClick) {
      var b = el("button");
      b.appendChild(el("span", "t", title));
      b.appendChild(el("span", "d", detail));
      b.onclick = onClick;
      list.appendChild(b);
      return b;
    }

    // Ordered by "least surprising first" for someone who already has crypto,
    // but the card path is the one that works for someone who has nothing.
    option(
      "Send from a wallet I already have",
      "You hold " + CFG.currencySymbol + " on " + CFG.chainName + ". Nothing leaves this machine.",
      renderWalletSend
    );

    if (CFG.widgetUrl) {
      option(
        "Pay by card, Apple Pay, or Google Pay",
        "No wallet or crypto needed" + (CFG.valueHint ? " \\u2014 " + CFG.valueHint : "") + ".",
        function () { renderWidget("card"); }
      );
      option(
        "Use crypto I hold on another chain",
        "ETH, USDC and more on Base, Arbitrum, Optimism, Polygon, BNB\\u2026 converted to " +
          CFG.currencySymbol + " and delivered here.",
        function () { renderWidget("crypto"); }
      );
    } else {
      // Testnet: neither rail reaches chain 16602, so do not pretend.
      list.appendChild(el("div", "note",
        "Card and cross-chain funding are mainnet-only \\u2014 those rails do not " +
        "reach the testnet chain. On testnet, use the faucet below."));
    }

    bodyEl.appendChild(list);

    if (CFG.faucetUrl) {
      var note = el("div", "note", "Testnet faucet (0.1 " + CFG.currencySymbol + "/day): ");
      var a = document.createElement("a");
      a.href = CFG.faucetUrl;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.textContent = CFG.faucetUrl;
      note.appendChild(a);
      bodyEl.appendChild(note);
    }

    var skip = el("button", null, "Skip \\u2014 I will fund it later");
    skip.onclick = function () {
      skip.disabled = true;
      busy("Finishing\\u2026");
      post("/api/complete", { skipped: true }).then(function () {
        done = true;
        bodyEl.innerHTML = "";
        bodyEl.appendChild(el("div", null,
          "Skipped. Run \\u0060dmemo fund\\u0060 whenever you are ready."));
        bodyEl.appendChild(el("div", "note", "You can close this tab."));
        say("");
      }).catch(fail);
    };
    bodyEl.appendChild(skip);

    startPolling("");
    say("");
  }

  function backButton(label) {
    var b = el("button", "back", "\\u2190 " + (label || "Other funding options"));
    b.onclick = renderOptions;
    return b;
  }

  // ---- path A: send from a browser wallet (no external requests) ---------
  // Same EIP-6963 discovery as the connect page: listener attached before the
  // request event is dispatched, deduped by info.uuid.
  var found = [];
  var seen = Object.create(null);

  function onAnnounce(event) {
    var detail = event && event.detail;
    if (!detail || !detail.info || !detail.provider) return;
    var uuid = detail.info.uuid;
    if (!uuid || seen[uuid]) return;
    seen[uuid] = true;
    found.push(detail);
    if (view === "wallet") renderWalletSend();
  }

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  setTimeout(function () {
    if (found.length === 0 && window.ethereum) {
      seen["legacy"] = true;
      found.push({
        info: { uuid: "legacy", name: "Injected wallet", icon: null, rdns: "legacy" },
        provider: window.ethereum,
        legacy: true
      });
      if (view === "wallet") renderWalletSend();
    }
  }, 700);

  var view = "options";

  function renderWalletSend() {
    view = "wallet";
    bodyEl.innerHTML = "";
    bodyEl.appendChild(backButton());

    if (found.length === 0) {
      bodyEl.appendChild(el("div", null, "Looking for browser wallets\\u2026"));
      bodyEl.appendChild(el("div", "note",
        "No wallet extension detected. Install MetaMask, Rabby, or another " +
        "EIP-6963 wallet and reload \\u2014 or go back and pay by card, which " +
        "needs no wallet at all."));
      return;
    }

    bodyEl.appendChild(el("div", "note",
      "Sends " + CFG.fundAmountLabel + " " + CFG.currencySymbol + " to the account above."));

    var list = el("div", "options");
    found.forEach(function (detail) {
      var b = el("button");
      if (detail.info.icon) {
        var img = document.createElement("img");
        img.src = detail.info.icon;
        img.alt = "";
        b.appendChild(img);
      }
      b.appendChild(el("span", "t", detail.info.name || "Wallet"));
      b.onclick = function () { sendFrom(detail); };
      list.appendChild(b);
    });
    bodyEl.appendChild(list);
    say("");
  }

  function sendFrom(detail) {
    var provider = detail.provider;
    busy("Waiting for " + (detail.info.name || "your wallet") + "\\u2026");
    provider.request({ method: "eth_requestAccounts" })
      .then(function (accounts) {
        if (!accounts || !accounts.length) throw new Error("No account returned by the wallet.");
        var from = accounts[0];
        busy("Switching to " + CFG.chainName + "\\u2026");
        return provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CFG.chainIdHex }]
        }).catch(function (err) {
          // 4902 = chain unknown to this wallet. Anything else (including
          // 4001, the user declining) is a real failure.
          var code = err && (err.code != null ? err.code
            : (err.data && err.data.originalError && err.data.originalError.code));
          if (code !== 4902) throw err;
          busy("Adding " + CFG.chainName + " to your wallet\\u2026");
          return provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CFG.chainIdHex,
              chainName: CFG.chainName,
              rpcUrls: [CFG.rpcUrl],
              nativeCurrency: { name: CFG.currencySymbol, symbol: CFG.currencySymbol, decimals: 18 }
            }]
          });
        }).then(function () { return from; });
      })
      .then(function (from) {
        busy("Confirm the transaction in your wallet\\u2026");
        return provider.request({
          method: "eth_sendTransaction",
          params: [{ from: from, to: CFG.address, value: CFG.fundAmountWeiHex }]
        });
      })
      .then(function (txHash) {
        busy("Sent. Waiting for it to land\\u2026");
        startPolling("waiting for the transfer to confirm\\u2026");
        return post("/api/sent", { txHash: txHash });
      })
      .catch(fail);
  }

  // ---- paths B & C: the hosted widget (the one external dependency) ------
  function renderWidget(mode) {
    view = "widget";
    bodyEl.innerHTML = "";
    bodyEl.appendChild(backButton());

    var url = CFG.widgetUrl + "&methods=" + encodeURIComponent(JSON.stringify([mode]));

    var frame = document.createElement("iframe");
    frame.src = url;
    frame.title = "Buy " + CFG.currencySymbol;
    // Payment + camera are delegated for Transak's checkout and KYC capture.
    // Nested delegation can still fail (the widget frames Transak in turn),
    // which is exactly what the new-tab escape hatch below is for.
    frame.setAttribute("allow", "payment; camera; microphone; clipboard-write");
    frame.setAttribute("referrerpolicy", "no-referrer");
    bodyEl.appendChild(frame);

    var note = el("div", "note",
      "Funds are delivered straight to your dMemo account \\u2014 the destination " +
      "is fixed and cannot be edited. Having trouble in this embedded view? ");
    var a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.textContent = "Open it in a new tab";
    note.appendChild(a);
    note.appendChild(document.createTextNode(
      " \\u2014 this page keeps watching for the funds either way."));
    bodyEl.appendChild(note);

    startPolling("watching for your deposit\\u2026");
    say("");
  }

  // ---- done ---------------------------------------------------------------
  function renderDone(balanceLabel) {
    bodyEl.innerHTML = "";
    bodyEl.appendChild(el("div", null,
      "\\u2705 Funded \\u2014 " + balanceLabel + " " + CFG.currencySymbol + "."));
    bodyEl.appendChild(el("div", "note",
      "Return to your terminal for the summary. You can close this tab."));
    balNoteEl.textContent = "";
    say("");
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    post("/api/complete", { funded: true }).catch(function () {});
  }

  renderOptions();
})();
</script>
</body>
</html>
`;
}
