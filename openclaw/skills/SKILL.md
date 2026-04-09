---
name: hivemind
description: Cloud-backed shared memory for AI agents powered by Hivemind. Install once, memory persists across sessions, machines, and channels.
allowed-tools: Read
---

# Hivemind Memory

Cloud-backed memory that syncs across all agents via Hivemind REST API.

## Installation

```bash
openclaw plugins install hivemind
```

After install, send a message. The plugin will send you an authentication link. Click it, sign in, and memory activates on the next message. No CLI needed.

## How it works

The plugin automatically:
- **Captures** every conversation (user + assistant messages) to Hivemind cloud
- **Recalls** relevant memories before each agent turn via keyword search
- All data stored as structured rows in Hivemind — searchable, persistent, shared

## Sharing memory

Multiple agents on different machines share memory when users are in the same Hivemind organization. Invite teammates via the Hivemind dashboard.

## Troubleshooting

- **Auth link not appearing** → Restart the gateway and try again
- **Memory not recalling** → Memories are searched by keyword matching. Use specific terms.
