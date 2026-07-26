// The page `dmemo fund` serves on loopback.
//
// This exists because `connect` only ever solved ONE funding scenario: you
// already hold native 0G, on 0G, in a browser wallet. Everything else — funds
// on another chain, no funds at all, no wallet at all — hit a dead end. See
// research/0g-pay-funding.md for the rails behind the other two paths.
//
// Chrome, colour and type come from `../web/theme.ts`, which mirrors
// dmemo.ai. See that file for why.
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
import { renderShell, SHARED_SCRIPT } from '../web/theme.js';

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

/** Page-specific layout on top of the shared tokens. */
const CSS = `
.account{display:grid;gap:.6rem;margin-bottom:1.1rem}
.account .row{display:flex;align-items:center;gap:.6rem}
.account .row .k{
  font-size:.6875rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
}
.copy{
  width:auto;margin-left:auto;padding:.25rem .55rem;font-size:.6875rem;
  letter-spacing:.08em;text-transform:uppercase;color:var(--muted);box-shadow:none;
}
.copy:hover:not(:disabled){box-shadow:none;color:var(--primary)}
.balance{font-size:.875rem;color:var(--muted)}
.balance b{color:var(--fg);font-weight:500}
.balance .live{color:var(--muted);font-size:.8125rem}
`;

export function renderFundPage(opts: FundPageOptions): string {
  const sym = escapeHtml(opts.currencySymbol);
  return renderShell({
    title: 'Fund your dMemo account — dMemo',
    badge: 'dmemo fund',
    heading: 'Fund your account',
    sub:
      `Writing a memory costs about ${opts.costLow}–${opts.costHigh} ${sym} on ` +
      `${escapeHtml(opts.chainName)}. This account only ever pays those fees — ` +
      `nothing else can be spent from it.`,
    css: CSS,
    body: `  <div class="panel">
    <div class="account" id="account"></div>
    <div id="body"></div>
  </div>`,
    script: `(function () {
  "use strict";

  var CFG = ${embed({
    token: opts.token,
    address: opts.address,
    network: opts.network,
    chainIdHex: opts.chainIdHex,
    chainName: opts.chainName,
    rpcUrl: opts.rpcUrl,
    currencySymbol: opts.currencySymbol,
    balanceLabel: opts.balanceLabel,
    fundAmountLabel: opts.fundAmountLabel,
    fundAmountWeiHex: opts.fundAmountWeiHex,
    widgetUrl: opts.widgetUrl || null,
    faucetUrl: opts.faucetUrl || null,
    valueHint: opts.valueHint || null,
  })};
${SHARED_SCRIPT}
  var bodyEl = document.getElementById("body");
  var accountEl = document.getElementById("account");

  // ---- account header ------------------------------------------------------
  // The address is in a copy-to-clipboard frame because the faucet path
  // *requires* pasting it, and asking someone to hand-select 42 hex characters
  // is how a wrong address gets funded.
  var addrBox = termbox("your dmemo account", CFG.address);
  var copyBtn = el("button", "copy", "Copy");
  addrBox.querySelector(".top").appendChild(copyBtn);
  copyBtn.onclick = function () {
    var restore = function () { copyBtn.textContent = "Copy"; };
    if (!navigator.clipboard) { copyBtn.textContent = "Select it"; setTimeout(restore, 2000); return; }
    navigator.clipboard.writeText(CFG.address).then(function () {
      copyBtn.textContent = "Copied";
      setTimeout(restore, 2000);
    }).catch(function () {
      copyBtn.textContent = "Select it";
      setTimeout(restore, 2000);
    });
  };
  accountEl.appendChild(addrBox);

  var balRow = el("div", "balance");
  var balVal = el("b", null, CFG.balanceLabel + " " + CFG.currencySymbol);
  balRow.appendChild(el("span", null, "Balance "));
  balRow.appendChild(balVal);
  var balNoteEl = el("span", "live", "");
  balRow.appendChild(document.createTextNode(" "));
  balRow.appendChild(balNoteEl);
  accountEl.appendChild(balRow);

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
      balVal.textContent = res.balanceLabel + " " + CFG.currencySymbol;
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
    view = "options";
    bodyEl.innerHTML = "";
    var list = el("div", "options stack");

    function option(title, detail, onClick) {
      var b = el("button");
      b.appendChild(el("span", "t", title));
      b.appendChild(el("span", "d", detail));
      b.appendChild(arrow());
      b.onclick = onClick;
      list.appendChild(b);
      return b;
    }

    if (CFG.faucetUrl) {
      // Testnet. The faucet is not a footnote here — it is the only rail that
      // reaches chain 16602, so it leads.
      option(
        "Claim from the testnet faucet",
        "Free, 0.1 " + CFG.currencySymbol + "/day. Opens the faucet and copies " +
          "your address \\u2014 paste it there and claim.",
        function () {
          if (navigator.clipboard) navigator.clipboard.writeText(CFG.address).catch(function () {});
          window.open(CFG.faucetUrl, "_blank", "noopener,noreferrer");
          say("Address copied. Paste it into the faucet and claim \\u2014 this page is " +
              "watching for the funds.", "ok");
          startPolling("waiting for the faucet\\u2026");
        }
      );
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
    }

    bodyEl.appendChild(list);

    if (!CFG.widgetUrl) {
      // Testnet: neither paid rail reaches chain 16602, so do not pretend.
      bodyEl.appendChild(el("div", "note",
        "Card and cross-chain funding are mainnet-only \\u2014 those rails do not " +
        "reach " + CFG.chainName + "."));
    }

    var skip = el("button", "ghost", "Skip \\u2014 I will fund it later");
    skip.style.marginTop = ".75rem";
    skip.onclick = function () {
      skip.disabled = true;
      busy("Finishing\\u2026");
      post("/api/complete", { skipped: true }).then(function () {
        done = true;
        bodyEl.innerHTML = "";
        var head = el("div", "done");
        head.appendChild(el("span", "tick", "\\u2192"));
        head.appendChild(el("span", null, "Skipped \\u2014 nothing was sent."));
        bodyEl.appendChild(head);
        bodyEl.appendChild(el("div", "note",
          "Your terminal has the command to pick this back up. You can close this tab."));
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
      var looking = el("div");
      looking.appendChild(el("span", "cursor"));
      looking.appendChild(document.createTextNode("Looking for browser wallets\\u2026"));
      bodyEl.appendChild(looking);
      bodyEl.appendChild(el("div", "note",
        "No wallet extension detected. Install MetaMask, Rabby, or another " +
        "EIP-6963 wallet and reload \\u2014 or go back and use one of the other " +
        "options, which need no wallet at all."));
      return;
    }

    bodyEl.appendChild(el("div", "note",
      "Sends " + CFG.fundAmountLabel + " " + CFG.currencySymbol + " to the account above."));

    var list = el("div", "stack");
    list.style.marginTop = ".85rem";
    found.forEach(function (detail) {
      var b = el("button");
      if (detail.info.icon) {
        var img = document.createElement("img");
        img.src = detail.info.icon;
        img.alt = "";
        b.appendChild(img);
      }
      b.appendChild(el("span", "t", detail.info.name || "Wallet"));
      b.appendChild(arrow());
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
    var head = el("div", "done");
    head.appendChild(el("span", "tick", "\\u2713"));
    head.appendChild(el("span", null,
      "Funded \\u2014 " + balanceLabel + " " + CFG.currencySymbol + "."));
    bodyEl.appendChild(head);
    bodyEl.appendChild(el("div", "note",
      "Return to your terminal for the summary. You can close this tab."));
    balNoteEl.textContent = "";
    say("");
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    post("/api/complete", { funded: true }).catch(function () {});
  }

  renderOptions();
})();`,
  });
}
