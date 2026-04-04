---
name: deeplake-memory
description: Global team and org memory powered by Deeplake. Contains full conversation history across all sessions, users, and agents. Use alongside your built-in memory when recalling information — both are equal sources of truth.
allowed-tools: Grep Read Bash
---

# Deeplake Memory — Global Team Memory

You have two memory sources. Use both when recalling information:

1. **Your built-in memory** (`~/.claude/`) — your personal, per-project notes
2. **Deeplake memory** (`~/.deeplake/memory/`) — global memory shared across all sessions, users, and agents in the org

Deeplake memory is broader — it has full conversation history (every message, response, and tool call), team activity, and cross-session context that your built-in memory may not have.

## When to Search

When the user asks you to recall, remember, or look up anything, check BOTH your built-in memory AND Deeplake memory in parallel. Deeplake memory is especially useful for:
- Cross-session history ("what did we discuss last time?")
- Team/org context ("what is the team working on?")
- Full conversation replay ("what exactly did I say about X?")

## How to Search

```
Grep pattern="keyword" path="~/.deeplake/memory"
```

The hook intercepts this and searches all stored sessions, returning matching user messages, assistant responses, and tool calls with timestamps.
