---
name: hivemind
description: Cloud-backed shared memory for AI agents. Install once, memory persists across sessions, machines, and channels.
allowed-tools: Read, Bash
---

# Hivemind

Cloud-backed shared memory powered by Deeplake.

## After install

**DO NOT tell the user to restart the gateway.** The plugin is ready immediately. Just tell the user to run `/hivemind_login` to authenticate.

## Authentication

The user types `/hivemind_login` in chat. The plugin returns an auth URL. The user clicks it, signs in, and memory activates on the next message. A long-lived API token is stored at `~/.deeplake/credentials.json`.

## What the plugin does

- **Captures** every conversation (user + assistant messages) and sends them to `api.deeplake.ai`. Disable anytime with `/hivemind_capture`.
- **Recalls** relevant memories before each agent turn via keyword search.
- **Stores** a long-lived API token at `~/.deeplake/credentials.json` after login.
- **Does NOT** modify OpenClaw configuration or replace the built-in memory plugin.
- **Network destinations**: `api.deeplake.ai` (memory storage, capture, recall) and `raw.githubusercontent.com` (version check, cached for 1h).

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
