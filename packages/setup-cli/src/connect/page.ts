// The single self-contained page `dmemo connect` serves on loopback.
//
// Chrome, colour and type come from `../web/theme.ts`, which mirrors
// dmemo.ai — see that file for why the two CLI pages and the marketing site
// share one design system.
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
// No external requests of any kind: no CDN, no analytics. The one font is
// embedded as a data: URI from this package's own `assets/`, and wallet icons
// come from the wallets themselves as data: URIs via EIP-6963.

import { escapeHtml, embedJson as embed } from '../loopback.js';
import { renderShell, SHARED_SCRIPT } from '../web/theme.js';

export interface ConnectPageOptions {
  token: string;
  scope: string;
  network: 'testnet' | 'mainnet';
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  blockExplorerUrl?: string;
  currencySymbol: string;
  fundAmountLabel: string;
  fundAmountWeiHex: string;
  faucetUrl?: string;
}

export function renderConnectPage(opts: ConnectPageOptions): string {
  const chain = escapeHtml(opts.chainName);
  return renderShell({
    title: 'Connect wallet — dMemo',
    badge: 'dmemo connect',
    heading: 'Connect your wallet',
    sub:
      'dMemo derives your memory encryption key from a wallet signature. ' +
      'Your private key is never shared, typed, or stored.',
    body: `  <ol class="steps" id="steps">
    <li data-step="connect" data-state="active"><span class="n">01</span>Choose a wallet</li>
    <li data-step="chain"><span class="n">02</span>Switch to ${chain}</li>
    <li data-step="sign"><span class="n">03</span>Sign to derive your key</li>
    <li data-step="fund"><span class="n">04</span>Fund your dMemo account</li>
  </ol>

  <div class="panel" id="panel"></div>`,
    script: `(function () {
  "use strict";

  var CFG = ${embed({
    token: opts.token,
    scope: opts.scope,
    network: opts.network,
    chainIdHex: opts.chainIdHex,
    chainName: opts.chainName,
    rpcUrl: opts.rpcUrl,
    blockExplorerUrl: opts.blockExplorerUrl || null,
    currencySymbol: opts.currencySymbol,
    fundAmountLabel: opts.fundAmountLabel,
    fundAmountWeiHex: opts.fundAmountWeiHex,
    faucetUrl: opts.faucetUrl || null,
  })};
${SHARED_SCRIPT}
  var panel = document.getElementById("panel");
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
      if (i < idx) items[i].querySelector(".n").textContent = "\\u2713";
    }
  }

  function allDone() {
    var items = stepsEl.querySelectorAll("li");
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute("data-state", "done");
      items[i].querySelector(".n").textContent = "\\u2713";
    }
    state = "done";
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
      var looking = el("div");
      looking.appendChild(el("span", "cursor"));
      looking.appendChild(document.createTextNode("Looking for browser wallets\\u2026"));
      panel.appendChild(looking);
      panel.appendChild(el("div", "note",
        "No wallet extension detected. Install MetaMask, Rabby, or another " +
        "EIP-6963 wallet and reload this page."));
      return;
    }
    var list = el("div", "stack");
    found.forEach(function (detail) {
      var b = el("button");
      if (detail.info.icon) {
        var img = document.createElement("img");
        img.src = detail.info.icon;
        img.alt = "";
        b.appendChild(img);
      }
      b.appendChild(el("span", null, detail.info.name || "Wallet"));
      b.appendChild(arrow());
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
  var watching = false;

  function connect(detail) {
    provider = detail.provider;
    busy("Waiting for " + (detail.info.name || "your wallet") + "\\u2026");
    provider.request({ method: "eth_requestAccounts" })
      .then(function (accounts) {
        if (!accounts || !accounts.length) throw new Error("No account returned by the wallet.");
        account = accounts[0];
        watch(provider);
        return ensureChain();
      })
      .then(renderSign)
      .catch(fail);
  }

  // A wallet that switches out from under us invalidates everything
  // downstream: a different account derives a DIFFERENT memory key, and a
  // different chain would send the funding transaction to the wrong network.
  // Neither is recoverable by carrying on, so both hard-reset the flow. This
  // used to print a warning and continue, which is the worst of both worlds —
  // the user signs with an account they are no longer looking at.
  function watch(p) {
    if (watching || typeof p.on !== "function") return;
    watching = true;
    p.on("accountsChanged", function () {
      reset("Your wallet switched accounts. Starting over \\u2014 a different " +
            "account derives a different memory key.");
    });
    p.on("chainChanged", function () {
      reset("Your wallet switched networks. Starting over so everything lands " +
            "on " + CFG.chainName + ".");
    });
  }

  function reset(message) {
    // Past the point of no return the key is already derived and persisted by
    // the CLI; tearing the page down then would only confuse.
    if (state === "done") return;
    account = null;
    renderConnect();
    say(message, "warn");
  }

  // Re-read the chain straight from the wallet rather than trusting that the
  // switch in step 2 stuck. Wallets can be switched by the user, by another
  // tab, or by the wallet itself between step 2 and step 4.
  function assertChain() {
    return provider.request({ method: "eth_chainId" }).then(function (id) {
      // Compared numerically on purpose: wallets are inconsistent about
      // zero-padding and hex case, so a string compare raises false alarms.
      if (parseInt(id, 16) !== parseInt(CFG.chainIdHex, 16)) {
        throw new Error("Your wallet is on the wrong network. Switch it to " +
                        CFG.chainName + " and try again.");
      }
    });
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
      var chain = {
        chainId: CFG.chainIdHex,
        chainName: CFG.chainName,
        rpcUrls: [CFG.rpcUrl],
        nativeCurrency: { name: CFG.currencySymbol, symbol: CFG.currencySymbol, decimals: 18 }
      };
      // Optional in EIP-3085, but without it a freshly-added chain renders the
      // funding tx hash as dead text with nothing to click through to.
      if (CFG.blockExplorerUrl) chain.blockExplorerUrls = [CFG.blockExplorerUrl];
      return provider.request({ method: "wallet_addEthereumChain", params: [chain] });
    });
  }

  // ---- step 3: sign twice -------------------------------------------------
  function renderSign() {
    setStep("sign");
    panel.innerHTML = "";
    panel.appendChild(termbox("connected as", account));
    var btn = el("button", "primary", "Sign to derive my memory key");
    btn.style.marginTop = ".85rem";
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
    panel.appendChild(termbox("your dmemo account", res.derivedAddress));

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

    var actions = el("div", "stack tight");
    actions.style.marginTop = ".85rem";

    var btn = el("button", "primary",
      "Send " + CFG.fundAmountLabel + " " + CFG.currencySymbol);
    btn.onclick = function () {
      btn.disabled = true;
      busy("Checking the network\\u2026");
      // Chain check happens HERE and not before signing: the derivation
      // message is deliberately chain-independent (see derive.ts), so a
      // signature is valid whatever network the wallet is on. Money is not.
      assertChain().then(function () {
        busy("Confirm the transaction in your wallet\\u2026");
        return provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: res.derivedAddress, value: CFG.fundAmountWeiHex }]
        });
      }).then(function (txHash) {
        busy("Waiting for the funding transaction to confirm\\u2026");
        return post("/api/complete", { txHash: txHash });
      }).then(renderDone).catch(function (e) { btn.disabled = false; fail(e); });
    };
    actions.appendChild(btn);

    var skip = el("button", "ghost", "Skip \\u2014 I will fund it myself");
    skip.onclick = function () {
      skip.disabled = true;
      busy("Finishing\\u2026");
      post("/api/complete", { txHash: null, skipped: true }).then(renderDone).catch(fail);
    };
    actions.appendChild(skip);
    panel.appendChild(actions);

    if (CFG.faucetUrl) {
      var note = el("div", "note", "Testnet faucet (0.1 " + CFG.currencySymbol + "/day): ");
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
    var head = el("div", "done");
    head.appendChild(el("span", "tick", "\\u2713"));
    head.appendChild(el("span", null, "dMemo is connected."));
    panel.appendChild(head);
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
})();`,
  });
}
