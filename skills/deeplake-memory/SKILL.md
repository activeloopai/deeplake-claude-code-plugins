---
name: deeplake-memory
description: Global team and org memory powered by Deeplake. ALWAYS check BOTH built-in memory AND Deeplake memory when recalling information.
allowed-tools: Grep Read Bash
---

# Deeplake Memory

You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. **Your built-in memory** (`~/.claude/`) — personal per-project notes
2. **Deeplake global memory** (`~/.deeplake/memory/`) — global memory shared across all sessions, users, and agents in the org

## Memory Structure

```
~/.deeplake/memory/
├── index.md                          ← START HERE — table of all sessions
├── summaries/
│   ├── session-abc.md                ← AI-generated wiki summary
│   └── session-xyz.md
└── sessions/
    └── username/
        ├── user_org_ws_slug1.jsonl   ← raw session data
        └── user_org_ws_slug2.jsonl
```

## How to Search

1. **First**: Read `~/.deeplake/memory/index.md` — quick scan of all sessions with dates, projects, descriptions
2. **If you need details**: Read the specific summary at `~/.deeplake/memory/summaries/<session>.md`
3. **If you need raw data**: Read the session JSONL at `~/.deeplake/memory/sessions/<user>/<file>.jsonl`
4. **Keyword search**: `Grep pattern="keyword" path="~/.deeplake/memory"`

Do NOT jump straight to reading raw JSONL files. Always start with index.md and summaries.

## Organization Management

The auth command path is injected at session start. Use the exact path from the session context. Commands:
- `org list` — list organizations
- `org switch <name-or-id>` — switch organization
- `invite <email> <ADMIN|WRITE|READ>` — invite member
- `members` — list members
- `login` — re-login

## Limits

If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Getting Started

After installing the plugin:
1. Run `/deeplake-hivemind:login` to authenticate
2. Start using memory — ask questions, Claude automatically captures and searches

## Configuration

- `DEEPLAKE_DEBUG=1 claude` — enable verbose logging to `~/.deeplake/hook-debug.log`
- `DEEPLAKE_CAPTURE=false claude` — disable session capture
