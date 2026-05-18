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

Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Getting Started

After installing the plugin:
1. Authenticate with `node "<AUTH_CMD>" login`
2. Start using memory — ask questions, Codex automatically captures and searches

## Configuration

- `HIVEMIND_DEBUG=1 codex` — enable verbose logging to `~/.deeplake/hook-debug.log`
- `HIVEMIND_CAPTURE=false codex` — disable session capture
