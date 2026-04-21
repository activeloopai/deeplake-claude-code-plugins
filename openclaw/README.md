# Hivemind

Cloud-backed shared memory for AI agents. Install once, memory persists across sessions, machines, and channels — and is shared with every teammate in your Deeplake org.

Powered by [Deeplake](https://deeplake.ai/hivemind).

## Install

```bash
openclaw plugins install clawhub:hivemind
```

Then in chat:

```
/hivemind_login
```

Click the auth link, sign in, send another message. That's it.

## What it does

- **Auto-recall** — before each agent turn, relevant memories surface automatically via keyword search.
- **Auto-capture** — after each turn, the conversation is stored to your Deeplake workspace.
- **Cross-platform** — same memory accessible from Claude Code, Codex CLI, and OpenClaw plugins.
- **Team-wide** — every user in your Deeplake org shares the same memory.

## Commands

| Command | What it does |
|---------|--------------|
| `/hivemind_login` | Sign in via device flow |
| `/hivemind_capture` | Toggle conversation capture on/off |
| `/hivemind_whoami` | Show current org and workspace |
| `/hivemind_orgs` | List organizations |
| `/hivemind_switch_org <name>` | Switch organization |
| `/hivemind_workspaces` | List workspaces |
| `/hivemind_switch_workspace <id>` | Switch workspace |
| `/hivemind_update` | Check for plugin updates |

You can also just ask the agent naturally — "switch org to activeloop", "list my orgs", "invite alice@example.com as admin", etc.

## Privacy & data

- **What's captured**: every user message and assistant reply, sent to `api.deeplake.ai`.
- **Where credentials live**: a long-lived API token at `~/.deeplake/credentials.json` (file permissions 0600).
- **Where it sends data**: `api.deeplake.ai` (memory storage) and `raw.githubusercontent.com` (version check, cached for 1h at `~/.deeplake/.version-check.json`).
- **How to pause**: run `/hivemind_capture` to stop capture; run it again to resume.
- **How to fully sign out**: delete `~/.deeplake/credentials.json` and revoke the token in the Deeplake dashboard.

The plugin does **not** modify OpenClaw's configuration or replace the built-in memory plugin. It runs alongside `memory-core` via lifecycle hooks, so `memory-core`'s dreaming cron and other memory-slot jobs keep working.

## Troubleshooting

**Hivemind feels slow or makes tools hang.**
Check `agents.defaults.model` in `~/.openclaw/openclaw.json`. Memory-heavy workflows issue many small tool calls; a large reasoning model feels sluggish. Recommended default is `anthropic/claude-haiku-4-5-20251001`.

**Model switch rejected as "not allowed".**
OpenClaw's allowlist wants `<provider>/<exact-dated-id>`. Use `anthropic/claude-haiku-4-5-20251001` or `anthropic/claude-sonnet-4-6`. Bare IDs and `-latest` suffixes are rejected.

**`openclaw model <id>` fails with "plugins.allow excludes model".**
The CLI is disabled by default. Edit `~/.openclaw/openclaw.json` under `agents.defaults.model` and restart the gateway: `systemctl --user restart openclaw-gateway.service`.

**Telegram-triggered `sudo npm i -g openclaw@latest` fails with "elevated is not available".**
`tools.elevated.allowFrom.telegram` isn't set. Run the upgrade in a local shell instead.

## Sharing memory with teammates

Invite teammates to your Deeplake org:

```
invite alice@example.com as admin
```

Their agents will see your memory; your agents will see theirs.

## Source

[github.com/activeloopai/hivemind](https://github.com/activeloopai/hivemind)
