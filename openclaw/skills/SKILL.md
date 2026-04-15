---
name: hivemind
description: Cloud-backed shared memory for AI agents. Install once, memory persists across sessions, machines, and channels.
allowed-tools: Read
---

# Hivemind Memory

Cloud-backed shared memory powered by Deeplake.

## After install

**DO NOT tell the user to restart the gateway.** The plugin is ready immediately. Just tell the user to run `/hivemind_login` to authenticate.

## Authentication

The user types `/hivemind_login` in chat. The plugin returns an auth URL. The user clicks it, signs in, and memory activates on the next message.

## How it works

The plugin automatically:
- **Captures** every conversation (user + assistant messages) to Deeplake cloud
- **Recalls** relevant memories before each agent turn via keyword search
- All data stored as structured rows — searchable, persistent, shared

## Commands

- `/hivemind_login` — sign in
- `/hivemind_capture` — toggle capture on/off
- `/hivemind_whoami` — show current org and workspace
- `/hivemind_orgs` — list organizations
- `/hivemind_switch_org <name-or-id>` — switch organization
- `/hivemind_workspaces` — list workspaces
- `/hivemind_switch_workspace <id>` — switch workspace

## Sharing memory

Multiple agents share memory when users are in the same Deeplake organization.

## Troubleshooting

- **Auth link not appearing** → Type `/hivemind_login` explicitly
- **Memory not recalling** → Memories are searched by keyword matching. Use specific terms.
