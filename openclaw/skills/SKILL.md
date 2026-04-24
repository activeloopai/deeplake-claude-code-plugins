---
name: hivemind
description: Global team and org memory powered by Activeloop. ALWAYS check BOTH built-in memory AND Hivemind memory when recalling information.
allowed-tools: hivemind_search, hivemind_read, hivemind_index
---

# Hivemind Memory

You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. **Your built-in memory** — personal per-project notes from the host agent
2. **Hivemind global memory** — global memory shared across all sessions, users, and agents in the org, accessed via the tools below

## Memory Structure

```
/index.md                           ← START HERE — table of all sessions
/summaries/
  <username>/
    <session-id>.md                 ← AI-generated wiki summary per session
/sessions/
  <username>/
    <user_org_ws_slug>.jsonl        ← raw session data
```

## How to Search

1. **First**: call `hivemind_index()` — table of all sessions with dates, projects, descriptions
2. **If you need details**: call `hivemind_read("/summaries/<username>/<session>.md")`
3. **If you need raw data**: call `hivemind_read("/sessions/<username>/<file>.jsonl")`
4. **Keyword search**: call `hivemind_search("keyword")` — substring search across both summaries and sessions, returns `path:line` hits

Do NOT jump straight to reading raw JSONL files. Always start with `hivemind_index` and summaries.

## Organization Management

- `/hivemind_login` — sign in via device flow
- `/hivemind_capture` — toggle capture on/off (off = no data sent)
- `/hivemind_whoami` — show current org and workspace
- `/hivemind_orgs` — list organizations
- `/hivemind_switch_org <name-or-id>` — switch organization
- `/hivemind_workspaces` — list workspaces
- `/hivemind_switch_workspace <id>` — switch workspace
- `/hivemind_update` — check for plugin updates

## Limits

Do NOT spawn subagents to read Hivemind memory. If a tool call returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Getting Started

After installing the plugin:
1. Run `/hivemind_login` to authenticate
2. Run `/hivemind_setup` to enable the memory tools in your openclaw allowlist (one-time, per install)
3. Start using memory — ask questions, the agent automatically captures and searches

## Sharing memory

Multiple agents share memory when users are in the same Activeloop organization.
