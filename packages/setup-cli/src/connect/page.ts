// The single self-contained page `dmemo connect` serves on loopback.
//
// WALLET DISCOVERY: EIP-6963, implemented inline rather than by vendoring
// `mipd`. mipd (MIT, wevm, zero deps) is the reference implementation and
// what a bundled dapp should use — but it ships as an npm ESM/CJS package,
// and setup-cli builds with plain `tsc` and no bundler. Pulling in esbuild
// solely to inline ~30 lines of event plumbing is a worse trade than writing
// those 30 lines against the spec. The two details MetaMask's own guidance
// calls out are both honoured below:
//   1. attach the `eip6963:announceProvider` listener BEFORE dispatching
//      `eip6963:requestProvider` (otherwise wallets that answer synchronously
//      are missed), and
//   2. deduplicate announcements by `info.uuid`.
// `window.ethereum` is used only as a last-resort fallback: MetaMask's docs
// warn it "may fail if multiple wallet extensions are active", which is
// exactly the MetaMask-vs-Rabby collision EIP-6963 exists to fix.
//
// No external requests of any kind: no CDN, no fonts, no analytics. Wallet
// icons come from the wallets themselves as data: URIs via EIP-6963.

import { escapeHtml, embedJson as embed } from '../loopback.js';

export interface ConnectPageOptions {
  token: string;
  scope: string;
  network: 'testnet' | 'mainnet';
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  currencySymbol: string;
  fundAmountLabel: string;
  fundAmountWeiHex: string;
  faucetUrl?: string;
}

export function renderConnectPage(opts: ConnectPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect wallet — dMemo</title>
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
  main { width: 100%; max-width: 30rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 1.75rem; font-size: .9rem; }
  ol.steps { list-style: none; margin: 0 0 1.5rem; padding: 0; }
  ol.steps li {
    display: flex; gap: .7rem; align-items: flex-start;
    padding: .55rem 0; color: var(--muted); font-size: .9rem;
  }
  ol.steps li .dot {
    flex: 0 0 1.25rem; height: 1.25rem; border-radius: 50%;
    border: 1.5px solid var(--line); display: grid; place-items: center;
    font-size: .7rem; margin-top: .05rem;
  }
  ol.steps li[data-state="active"] { color: var(--fg); font-weight: 550; }
  ol.steps li[data-state="active"] .dot { border-color: var(--accent); color: var(--accent); }
  ol.steps li[data-state="done"] { color: var(--fg); }
  ol.steps li[data-state="done"] .dot {
    background: var(--ok); border-color: var(--ok); color: #fff;
  }
  .panel {
    border: 1px solid var(--line); background: var(--card);
    border-radius: .7rem; padding: 1.1rem;
  }
  .wallets { display: grid; gap: .5rem; }
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
  .panel button + button, .panel .note + button { margin-top: .5rem; }
  .note { font-size: .82rem; color: var(--muted); margin-top: .85rem; }
  .addr {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .82rem; word-break: break-all; background: var(--bg);
    border: 1px solid var(--line); border-radius: .45rem; padding: .5rem .6rem;
    margin: .6rem 0;
  }
  .msg { margin-top: 1rem; font-size: .88rem; }
  .msg.err { color: var(--err); }
  .msg.ok { color: var(--ok); }
  .msg.warn { color: var(--warn); }
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
  <h1>Connect your wallet</h1>
  <p class="sub">dMemo derives your memory encryption key from a wallet
  signature. Your private key is never shared, typed, or stored.</p>

  <ol class="steps" id="steps">
    <li data-step="connect" data-state="active"><span class="dot">1</span><span>Choose a wallet</span></li>
    <li data-step="chain"><span class="dot">2</span><span>Switch to ${escapeHtml(opts.chainName)}</span></li>
    <li data-step="sign"><span class="dot">3</span><span>Sign to derive your memory key</span></li>
    <li data-step="fund"><span class="dot">4</span><span>Fund your dMemo account</span></li>
  </ol>

  <div class="panel" id="panel"></div>
  <div class="msg" id="msg"></div>
</main>

<script>
(function () {
  "use strict";

  var CFG = ${embed({
    token: opts.token,
    scope: opts.scope,
    network: opts.network,
    chainIdHex: opts.chainIdHex,
    chainName: opts.chainName,
    rpcUrl: opts.rpcUrl,
    currencySymbol: opts.currencySymbol,
    fundAmountLabel: opts.fundAmountLabel,
    fundAmountWeiHex: opts.fundAmountWeiHex,
    faucetUrl: opts.faucetUrl || null,
  })};

  var panel = document.getElementById("panel");
  var msgEl = document.getElementById("msg");
  var stepsEl = document.getElementById("steps");

  // ---- EIP-6963 discovery -------------------------------------------------
  // Listener first, dispatch second (MetaMask's documented ordering), dedupe
  // by info.uuid. Wallets may announce at any time, so we never stop listening.
  var found = [];
  var seen = Object.create(null);

  function onAnnounce(event) {
    var detail = event && event.detail;
    if (!detail || !detail.info || !detail.provider) return;
    var uuid = detail.info.uuid;
    if (!uuid || seen[uuid]) return;
    seen[uuid] = true;
    found.push(detail);
    if (state === "connect") renderConnect();
  }

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Last-resort fallback for a wallet that never learned EIP-6963. Delayed so
  // a compliant wallet always wins the list; flagged so we can say so.
  setTimeout(function () {
    if (found.length === 0 && window.ethereum) {
      seen["legacy"] = true;
      found.push({
        info: { uuid: "legacy", name: "Injected wallet", icon: null, rdns: "legacy" },
        provider: window.ethereum,
        legacy: true
      });
    }
    if (state === "connect") renderConnect();
  }, 700);

  // ---- step chrome --------------------------------------------------------
  var ORDER = ["connect", "chain", "sign", "fund"];
  var state = "connect";

  function setStep(name) {
    state = name;
    var idx = ORDER.indexOf(name);
    var items = stepsEl.querySelectorAll("li");
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute(
        "data-state",
        i < idx ? "done" : i === idx ? "active" : ""
      );
      if (i < idx) items[i].querySelector(".dot").textContent = "\\u2713";
    }
  }

  function allDone() {
    var items = stepsEl.querySelectorAll("li");
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute("data-state", "done");
      items[i].querySelector(".dot").textContent = "\\u2713";
    }
    state = "done";
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

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
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

  // ---- step 1: choose a wallet -------------------------------------------
  function renderConnect() {
    setStep("connect");
    panel.innerHTML = "";
    if (found.length === 0) {
      panel.appendChild(el("div", null, "Looking for browser wallets\\u2026"));
      var hint = el("div", "note",
        "No wallet extension detected. Install MetaMask, Rabby, or another " +
        "EIP-6963 wallet and reload this page.");
      panel.appendChild(hint);
      return;
    }
    var list = el("div", "wallets");
    found.forEach(function (detail) {
      var b = el("button");
      if (detail.info.icon) {
        var img = document.createElement("img");
        img.src = detail.info.icon;
        img.alt = "";
        b.appendChild(img);
      }
      b.appendChild(el("span", null, detail.info.name || "Wallet"));
      b.onclick = function () { connect(detail); };
      list.appendChild(b);
    });
    panel.appendChild(list);
    if (found.length === 1 && found[0].legacy) {
      panel.appendChild(el("div", "note",
        "This wallet did not announce itself over EIP-6963, so we fell back to " +
        "the shared window.ethereum provider. If you have more than one wallet " +
        "extension installed, they may be competing for it \\u2014 disable the " +
        "others if the wrong one opens."));
    }
    say("");
  }

  var provider = null;
  var account = null;

  function connect(detail) {
    provider = detail.provider;
    busy("Waiting for " + (detail.info.name || "your wallet") + "\\u2026");
    provider.request({ method: "eth_requestAccounts" })
      .then(function (accounts) {
        if (!accounts || !accounts.length) throw new Error("No account returned by the wallet.");
        account = accounts[0];
        // A wallet switched under us invalidates the derived key, so bail
        // loudly rather than silently signing with a different account.
        if (provider.on) {
          provider.on("accountsChanged", function () {
            say("Account changed in your wallet \\u2014 reload this page to start over.", "warn");
          });
        }
        return ensureChain();
      })
      .then(renderSign)
      .catch(fail);
  }

  // ---- step 2: chain ------------------------------------------------------
  function ensureChain() {
    setStep("chain");
    busy("Switching to " + CFG.chainName + "\\u2026");
    return provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CFG.chainIdHex }]
    }).catch(function (err) {
      // 4902 = chain unknown to the wallet. Anything else is a real failure
      // (including 4001, the user declining).
      var code = err && (err.code != null ? err.code : (err.data && err.data.originalError && err.data.originalError.code));
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
    });
  }

  // ---- step 3: sign twice -------------------------------------------------
  function renderSign() {
    setStep("sign");
    panel.innerHTML = "";
    panel.appendChild(el("div", null, "Connected as"));
    panel.appendChild(el("div", "addr", account));
    var btn = el("button", "primary", "Sign to derive my memory key");
    btn.onclick = function () { btn.disabled = true; doSign().catch(function (e) { btn.disabled = false; fail(e); }); };
    panel.appendChild(btn);
    panel.appendChild(el("div", "note",
      "Your wallet will ask twice for the same signature. That is deliberate: " +
      "we compare the two to confirm your wallet signs deterministically. If it " +
      "does not, your memories could not be recovered on another machine \\u2014 " +
      "better to find out now than after you have written some."));
    say("");
  }

  function hexMessage(text) {
    var bytes = new TextEncoder().encode(text);
    var out = "0x";
    for (var i = 0; i < bytes.length; i++) {
      out += ("0" + bytes[i].toString(16)).slice(-2);
    }
    return out;
  }

  function sign(messageHex) {
    return provider.request({ method: "personal_sign", params: [messageHex, account] });
  }

  function doSign() {
    busy("Preparing\\u2026");
    // The exact text to sign comes from the CLI, not from this page, so the
    // signed bytes have a single source of truth in Node.
    return post("/api/begin", { address: account }).then(function (res) {
      var messageHex = hexMessage(res.message);
      busy("Signature 1 of 2 \\u2014 confirm in your wallet\\u2026");
      return sign(messageHex).then(function (sig1) {
        busy("Signature 2 of 2 \\u2014 confirm the same message again\\u2026");
        return sign(messageHex).then(function (sig2) {
          busy("Deriving your dMemo account\\u2026");
          return post("/api/signature", { address: account, signature: sig1, signatureRepeat: sig2 });
        });
      });
    }).then(renderFund);
  }

  // ---- step 4: fund -------------------------------------------------------
  function renderFund(res) {
    setStep("fund");
    panel.innerHTML = "";
    panel.appendChild(el("div", null, "Your dMemo account"));
    panel.appendChild(el("div", "addr", res.derivedAddress));

    if (!res.needsFunding) {
      panel.appendChild(el("div", "note",
        "Already funded (" + res.balanceLabel + " " + CFG.currencySymbol +
        "). Nothing to send \\u2014 finishing up."));
      busy("Finishing\\u2026");
      post("/api/complete", { txHash: null }).then(renderDone).catch(fail);
      return;
    }

    panel.appendChild(el("div", "note",
      "This account pays for your memory writes (~0.0012\\u20130.003 " +
      CFG.currencySymbol + " each). Send it a little " + CFG.currencySymbol +
      " from your connected wallet."));

    var btn = el("button", "primary",
      "Send " + CFG.fundAmountLabel + " " + CFG.currencySymbol);
    btn.onclick = function () {
      btn.disabled = true;
      busy("Confirm the transaction in your wallet\\u2026");
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: res.derivedAddress, value: CFG.fundAmountWeiHex }]
      }).then(function (txHash) {
        busy("Waiting for the funding transaction to confirm\\u2026");
        return post("/api/complete", { txHash: txHash });
      }).then(renderDone).catch(function (e) { btn.disabled = false; fail(e); });
    };
    panel.appendChild(btn);

    var skip = el("button", null, "Skip \\u2014 I will fund it myself");
    skip.onclick = function () {
      skip.disabled = true;
      busy("Finishing\\u2026");
      post("/api/complete", { txHash: null, skipped: true }).then(renderDone).catch(fail);
    };
    panel.appendChild(skip);

    if (CFG.faucetUrl) {
      var note = el("div", "note", "Testnet faucet: ");
      var a = document.createElement("a");
      a.href = CFG.faucetUrl;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.textContent = CFG.faucetUrl;
      note.appendChild(a);
      panel.appendChild(note);
    }
    say("");
  }

  // ---- done ---------------------------------------------------------------
  function renderDone() {
    allDone();
    panel.innerHTML = "";
    panel.appendChild(el("div", null, "\\u2705 dMemo is connected."));
    panel.appendChild(el("div", "note",
      "Return to your terminal for the summary. You can close this tab."));
    say("");
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }

  function fail(err) {
    var m = (err && (err.message || err.reason)) || String(err);
    // 4001 is the user hitting Reject; not an error worth shouting about.
    if (err && err.code === 4001) m = "Request rejected in your wallet. You can try again.";
    say(m, "err");
    post("/api/error", { message: m }).catch(function () {});
  }

  renderConnect();
})();
</script>
</body>
</html>
`;
}
