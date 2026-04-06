---
name: deeplake-memory
description: Global team and org memory powered by Deeplake. ALWAYS check BOTH built-in memory AND Deeplake memory when recalling information.
allowed-tools: Grep Read Bash
---

# Deeplake Memory

You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. **Your built-in memory** (`~/.claude/`) — personal per-project notes
2. **Deeplake global memory** (`~/.deeplake/memory/`) — global memory shared across all sessions, users, and agents in the org

Deeplake memory is broader — it has full conversation history (every message, response, and tool call), team activity, and cross-session context that your built-in memory may not have.

IMPORTANT: When answering questions about what was discussed, what someone said, what was worked on, team context, or any factual recall — search Deeplake memory in parallel with your built-in memory. Do not skip it. Do not wait to be asked.

Deeplake memory is especially useful for:
- Cross-session history ("what did we discuss last time?")
- Team/org context ("what is the team working on?")
- Full conversation replay ("what exactly did I say about X?")

## How to Search

```
Grep pattern="keyword" path="~/.deeplake/memory"
```

## Organization Management

The auth command path is injected at session start. Use the exact path from the session context. Commands:
- `org list` — list organizations
- `org switch <name-or-id>` — switch organization
- `invite <email> <ADMIN|WRITE|READ>` — invite member
- `members` — list members
- `login` — re-login

## Limits

Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Debugging

Set `DEEPLAKE_DEBUG=1` to enable verbose logging to `~/.deeplake/hook-debug.log`.
