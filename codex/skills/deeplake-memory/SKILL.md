---
name: hivemind-memory
description: Global team and org memory powered by Activeloop. ALWAYS check BOTH built-in memory AND Hivemind memory when recalling information.
allowed-tools: Bash
---

# Hivemind Memory

You have persistent memory at `~/.deeplake/memory/` — global memory shared across all sessions, users, and agents in the org.

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
4. **Keyword search**: `grep -r "keyword" ~/.deeplake/memory/`

Do NOT jump straight to reading raw JSONL files. Always start with index.md and summaries.

## Organization Management

Each argument is separate — do NOT quote subcommands together. The auth command is at `$CODEX_PLUGIN_ROOT/bundle/commands/auth-login.js` (or check the session context for the resolved path):
- `node "<path>/auth-login.js" login` — SSO login
- `node "<path>/auth-login.js" whoami` — show current user/org
- `node "<path>/auth-login.js" org list` — list organizations
- `node "<path>/auth-login.js" org switch <name-or-id>` — switch organization
- `node "<path>/auth-login.js" workspaces` — list workspaces
- `node "<path>/auth-login.js" workspace <id>` — switch workspace
- `node "<path>/auth-login.js" invite <email> <ADMIN|WRITE|READ>` — invite member (ALWAYS ask user which role first)
- `node "<path>/auth-login.js" members` — list members
- `node "<path>/auth-login.js" remove <user-id>` — remove member
- `node "<path>/auth-login.js" --help` — show all commands

## Limits

Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Getting Started

After installing the plugin:
1. Authenticate with `node "<AUTH_CMD>" login`
2. Start using memory — ask questions, Codex automatically captures and searches

## Configuration

- `DEEPLAKE_DEBUG=1 codex` — enable verbose logging to `~/.deeplake/hook-debug.log`
- `DEEPLAKE_CAPTURE=false codex` — disable session capture
