# dMemo for Claude Code

Private, encrypted, cross-session memory for [Claude Code](https://claude.com/claude-code), backed by [0G Storage](https://0g.ai).

Your conversations are summarized locally, encrypted client-side to your wallet key, and written to 0G Storage. Only that key can decrypt them — nothing readable ever leaves your machine, and there is no dMemo account or server in the path.

This repository is the Claude Code **plugin marketplace** for dMemo. The engine lives in the [main dMemo monorepo](https://github.com/dmemo-ai/dmemo).

## Install

The recommended path is the dMemo setup CLI, which creates or imports a wallet, writes your config, and installs the plugin for every coding agent it finds:

```bash
npx @dmemo/cli setup
```

To install just this plugin, from inside Claude Code:

```
/plugin marketplace add dmemo-ai/claude-dmemo
/plugin install dmemo@dmemo-plugins
```

or equivalently from the CLI:

```bash
claude plugin marketplace add dmemo-ai/claude-dmemo
claude plugin install dmemo@dmemo-plugins
```

## Configuration

The plugin needs one thing: a wallet private key, which is both your identity and your decryption key.

`npx @dmemo/cli setup` writes it to `~/.dmemo/config.json` (mode `0600`) and the plugin reads it from there. Alternatively, set it as the plugin's `privateKey` user config when installing.

**Until a key is configured, the plugin does nothing.** Every hook fails open — no errors, no interruption, no memory. This is deliberate: a memory layer should never be able to break your session.

> Your private key controls the wallet that pays for storage. Use a wallet funded only for this purpose, not one holding significant assets.

## What it does

| Hook | Behavior |
| --- | --- |
| `SessionStart` | Restores prior memory from 0G Storage into the session |
| `UserPromptSubmit` | Surfaces relevant memories for the current prompt |
| `PreToolUse` | Gates recall on `Skill` and `Bash` invocations |
| `Stop` | Captures the turn and flushes to storage |
| `PreCompact` | Persists memory before context is compacted |

It also provides a `/dmemo:status` command (configuration, network, scope, and memory count) and the `dmemo-save` / `dmemo-search` skills for explicit memory operations.

On first run the plugin bootstraps its own native dependencies into a persistent per-plugin data directory. This happens once, is fail-open, and survives plugin updates.

## License

MIT — see [LICENSE](./LICENSE).
