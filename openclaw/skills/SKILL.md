---
name: deeplake-plugin
description: Cloud-backed shared memory for AI agents powered by DeepLake. Install once, memory persists across sessions, machines, and channels.
allowed-tools: Read
---

# DeepLake Memory

Cloud-backed memory that syncs across all agents via DeepLake REST API.

## Installation

```bash
openclaw plugins install deeplake-plugin
```

After install, send a message. The plugin will send you an authentication link. Click it, sign in, and memory activates on the next message. No CLI needed.

## How it works

The plugin automatically:
- **Captures** every conversation (user + assistant messages) to DeepLake cloud
- **Recalls** relevant memories before each agent turn via keyword search
- All data stored as structured rows in DeepLake — searchable, persistent, shared

## Sharing memory

Multiple agents on different machines share memory when users are in the same DeepLake organization. Invite teammates via the DeepLake dashboard.

## Troubleshooting

- **Auth link not appearing** → Restart the gateway and try again
- **Memory not recalling** → Memories are searched by keyword matching. Use specific terms.
