# dmemo-hermes

dMemo memory provider for [Hermes](https://github.com/NousResearch/hermes-agent) — your agent's
memory lives on 0G Storage, encrypted to your own wallet key. No server holds it, no vendor can
read it, and it follows you between machines and between agents.

Same wallet, same memories: a conversation captured here is restored verbatim by the OpenCode,
Claude Code and Codex adapters, and vice versa. The blob format is the contract, not the SDK.

## What it does

At session start it resolves your chain from the 0G Submit log, downloads the head blob,
verifies its Merkle root, decrypts it, and replays it into an in-process mem0 engine. During the
session every completed turn is embedded locally and journaled; the journal is flushed to 0G as
an encrypted delta, with a periodic full checkpoint so restores stay one download deep. Nothing
is sent anywhere in plaintext, and no second LLM ever reads your conversation — turns are stored
verbatim (`infer=false`), not "extracted".

## Install

```bash
pip install dmemo-hermes
dmemo-hermes-install        # copies the plugin into $HERMES_HOME/plugins/dmemo
```

Then set your wallet key and enable the provider:

```bash
npx dmemo connect          # derives the memory key from a wallet signature
```

```yaml
# $HERMES_HOME/config.yaml
memory:
  provider: dmemo
plugins:
  enabled: [dmemo]
```

Optional, in `$HERMES_HOME/dmemo.json`:

```json
{ "network": "testnet", "scope": "hermes:me:main", "user_id": "me" }
```

Node 20+ must be on `PATH` — see "The one seam" below.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DMEMO_PRIVATE_KEY` | — | Wallet key; **also the encryption key**. Required. |
| `DMEMO_NETWORK` | `testnet` | `testnet` or `mainnet`. |
| `DMEMO_SCOPE` | `hermes` | Label recorded in each blob. Not a partition — see below. |
| `DMEMO_CHECKPOINT_K` | `2` | Flushes between full checkpoints. |
| `DMEMO_OBS_LOG` | — | Path to a JSONL file of upload/download/recall events. |

Env wins over `${DMEMO_HOME:-~/.dmemo}/config.json`.

> One wallet is one chain. `scope` is metadata: it tells you which agent wrote a blob, it does
> not give each agent a separate memory. That is deliberate — it is what makes memory portable
> across hosts — but it means every agent on a wallet reads every memory on it.

## Tools

`dmemo_search` (recall), `dmemo_add` (store a fact), `dmemo_delete` (remove one by id). Recall
also happens automatically: the provider prefetches on a background thread when a turn starts
and injects the result, with a 3-second budget. Miss the budget and the turn proceeds without
injection rather than stalling — the search tool is the backstop.

## The one seam

There is no 0G SDK for Python. Rather than reimplement the Merkle chunk scheme, FixedPriceFlow
submission, segment upload, ECIES and Submit-log pointer resolution — four chances to get a
consensus detail subtly wrong, with your memory as the failure mode — storage is a protocol
(`transport.py`) with four calls. Its first implementation is a persistent Node subprocess
speaking line-delimited JSON to `@dmemo/core`'s `StorageClient`, the same client the TypeScript
adapters use in production.

Everything above that seam is real Python: the codec, the journaling vector store, the restore
chain logic, the mem0 engine, the provider. If a 0G Python SDK ever ships, it implements
`StorageTransport` and nothing above it changes.

## Failure behaviour

- **Chain unreadable** → `open()` raises rather than returning an empty store. Starting empty
  would look like a fresh install, and the next checkpoint would write over your real memory.
- **A blob mid-chain won't decode** → restore truncates at that point and keeps everything newer.
- **Anything else fails at runtime** → the provider goes inert (no memory) but the agent keeps
  running. Five consecutive failures open a 120-second circuit breaker.
- **Non-primary agent contexts** (cron, subagents) get a read-only session — their prompts are
  not the user talking.

## Tests

```bash
pip install -e '.[dev]' pytest
pytest
```

The 0G leg is faked (`tests/conftest.py`); everything above it is exercised for real, including
the local embedder. `pytest -m "not slow"` skips the tests that boot a mem0 engine.
