---
name: hivemind
description: Cloud-backed shared memory. ALWAYS check Hivemind when the user asks about people, past work, or anything that may have happened in prior sessions — call `hivemind_search` first, then `hivemind_read` to drill in.
allowed-tools: hivemind_search, hivemind_read, hivemind_index
---

# Hivemind

Cloud-backed shared memory powered by Deeplake.

## When to use Hivemind

Use Hivemind **before** answering any question that references:

- a person by name (teammates, collaborators, users) — e.g. "what is Levon doing?", "who is Emanuele?"
- past work, decisions, or incidents the user expects you to already know about
- anything the user phrases as "remember", "recall", "look up", "find out about"

Primary tool: **`hivemind_search(query, regex?, ignoreCase?, limit?)`** — substring/regex search across all captured sessions and summaries. Returns `path:line` hits.

Drill-in tool: **`hivemind_read(path)`** — fetch the full content of a specific path returned by search (e.g. `/summaries/levon/2026-04-10-refactor.md`).

Overview tool: **`hivemind_index()`** — list all available summaries and sessions. Useful when you need to browse rather than search.

### How to search

1. Call `hivemind_search` with the most specific terms first (a name, a project, an error message). Don't start with a full natural-language sentence.
2. If results span multiple paths under `/summaries/<user>/...`, pick the most relevant one and `hivemind_read` it.
3. Only fall back to `/sessions/<user>/...` raw JSONL if summaries don't have enough detail.

## Do NOT

- **Do NOT conflate distinct people.** Every username under `/summaries/<user>/...` and `/sessions/<user>/...` is a different person. Names like Levon, Sasun, Emanuele, Kamo are distinct teammates — never merge, alias, or treat them as the same person based on co-occurrence in search results.
- **Do NOT invent facts** about a person based on adjacent search hits. If `hivemind_search` returned 5 hits and only 2 clearly mention the person, report only what's in those 2.
- **Do NOT skip Hivemind** just because you have some local notes. Hivemind memory is shared across the whole org and is usually more current than anything stored locally.

## After install

**DO NOT tell the user to restart the gateway.** The plugin is ready immediately. Just tell the user to run `/hivemind_login` to authenticate.

## Authentication

The user types `/hivemind_login` in chat. The plugin returns an auth URL. The user clicks it, signs in, and memory activates on the next message. A long-lived API token is stored at `~/.deeplake/credentials.json`.

## What the plugin does

- **Captures** every conversation (user + assistant messages) and sends them to `api.deeplake.ai`. Disable anytime with `/hivemind_capture`.
- **Recalls** relevant memories before each agent turn via keyword search.
- **Stores** a long-lived API token at `~/.deeplake/credentials.json` after login.
- **Does NOT** modify OpenClaw configuration or replace the built-in memory plugin.
- **Network destinations**: `api.deeplake.ai` (memory storage, capture, recall) and `raw.githubusercontent.com` (version check on session start and via `/hivemind_update`).

## Commands

- `/hivemind_login` — sign in via device flow
- `/hivemind_capture` — toggle capture on/off (off = no data sent)
- `/hivemind_whoami` — show current org and workspace
- `/hivemind_orgs` — list organizations
- `/hivemind_switch_org <name-or-id>` — switch organization
- `/hivemind_workspaces` — list workspaces
- `/hivemind_switch_workspace <id>` — switch workspace
- `/hivemind_update` — check for plugin updates

## Sharing memory

Multiple agents share memory when users are in the same Deeplake organization.

## Troubleshooting

- **Auth link not appearing** → Type `/hivemind_login` explicitly
- **Memory not recalling** → Memories are searched by keyword matching. Use specific terms.
