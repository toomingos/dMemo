---
name: dmemo-search
description: Search your private dMemo memory. Use when the user asks about past work, previous sessions, how something was implemented before, what they worked on earlier, or wants to recall information dMemo may have stored from an earlier session (dMemo already prefetches likely-relevant memory on every prompt — use this skill for a targeted follow-up search when that prefetch wasn't enough, e.g. a different query angle or an older/more specific fact).
allowed-tools: Bash(node:*)
---

# dMemo Search

Search dMemo — your private, encrypted, cross-session memory (backed by 0G Storage) — for
past decisions, facts, and context.

## How to Search

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/search-memory.cjs" "USER_QUERY_HERE"
```

## Examples

- User asks "what did we decide about the auth flow last week":
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/search-memory.cjs" "auth flow decision"
  ```
- User asks "did I already tell you my preferred test runner":
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/search-memory.cjs" "preferred test runner"
  ```

## Present Results

The script prints up to 5 ranked matches, or a note that dMemo has no matching memory (or
isn't configured yet). Present results plainly; offer to search again with different terms if
nothing useful comes back. Never fabricate a memory dMemo didn't return.
