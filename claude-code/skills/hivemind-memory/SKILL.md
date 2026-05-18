---
name: hivemind-memory
description: Global team and org memory powered by Activeloop. ALWAYS check BOTH built-in memory AND Hivemind memory when recalling information.
allowed-tools: Grep Read Bash
---

# Hivemind Memory

You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. **Your built-in memory** (`~/.claude/`) — personal per-project notes
2. **Hivemind global memory** (`~/.deeplake/memory/`) — global memory shared across all sessions, users, and agents in the org

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

The auth command path is injected at session start. Use the exact path from the session context. Each argument is separate — do NOT quote subcommands together:
- `node "<AUTH_CMD>" login` — SSO login
- `node "<AUTH_CMD>" whoami` — show current user/org
- `node "<AUTH_CMD>" org list` — list organizations
- `node "<AUTH_CMD>" org switch <name-or-id>` — switch organization
- `node "<AUTH_CMD>" workspaces` — list workspaces
- `node "<AUTH_CMD>" workspace <id>` — switch workspace
- `node "<AUTH_CMD>" invite <email> <ADMIN|WRITE|READ>` — invite member (ALWAYS ask user which role first)
- `node "<AUTH_CMD>" members` — list members
- `node "<AUTH_CMD>" remove <user-id>` — remove member
- `node "<AUTH_CMD>" --help` — show all commands

## Skill Management (skillify)

Hivemind can mine reusable skills from agent session logs and share them across your team. Each argument is separate — do NOT quote subcommands together.

- `hivemind skillify` — show current scope, team, install location, per-project state
- `hivemind skillify pull` — sync project skills from the org table to local FS
- `hivemind skillify pull --user <email>` — only skills authored by that user
- `hivemind skillify pull --users <a,b,c>` — multiple authors (CSV)
- `hivemind skillify pull --all-users` — explicit "no author filter" (default)
- `hivemind skillify pull --to <project|global>` — install location (project=cwd/.claude/skills, global=~/.claude/skills)
- `hivemind skillify pull --dry-run` — preview without touching disk
- `hivemind skillify pull --force` — overwrite local files even if up-to-date (creates .bak)
- `hivemind skillify pull <skill-name>` — pull only that one skill (combines with --user)
- `hivemind skillify unpull` — remove every skill previously installed by pull
- `hivemind skillify unpull --user <email>` — remove only that author's pulls
- `hivemind skillify unpull --not-mine` — remove all pulls except your own
- `hivemind skillify unpull --dry-run` — preview without touching disk
- `hivemind skillify scope <me|team>` — sharing scope for newly mined skills
- `hivemind skillify install <project|global>` — default install location for new skills
- `hivemind skillify promote <skill-name>` — move a project skill to the global location
- `hivemind skillify team add|remove|list <username>` — manage team member list
- `hivemind skillify mine-local` — one-shot: mine skills from local sessions, no auth needed

## Embeddings (semantic memory search)

Opt-in, persisted in `~/.deeplake/config.json`.

- `hivemind embeddings install` — download deps (~600MB), symlink agents, set enabled:true
- `hivemind embeddings enable` — flip enabled:true (run install first if deps missing)
- `hivemind embeddings disable` — flip enabled:false + SIGTERM daemon (deps stay on disk)
- `hivemind embeddings uninstall [--prune]` — remove agent symlinks + disable; --prune wipes deps too
- `hivemind embeddings status` — show config + deps + per-agent link state

## Important: Bash Only

Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with `~/.deeplake/memory/`. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash tools (e.g., `cat file.json | jq 'keys | length'`).

## Limits

If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Getting Started

After installing the plugin:
1. Run `/hivemind:login` to authenticate
2. Start using memory — ask questions, Claude automatically captures and searches

## Configuration

- `HIVEMIND_DEBUG=1 claude` — enable verbose logging to `~/.deeplake/hook-debug.log`
- `HIVEMIND_CAPTURE=false claude` — disable session capture
