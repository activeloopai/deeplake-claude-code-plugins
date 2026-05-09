# Hivemind

**Auto-learning, cloud-backed shared brain for OpenClaw.** Install once. Hivemind captures every coding-agent interaction in your org as a structured trace, codifies repeated patterns into reusable skills, and propagates those skills to every Hivemind-connected agent on your team.

> One engineer's agent figures out a tricky migration on Monday. Tuesday, every agent on the team can execute the pattern.

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

- **Auto-capture** — every prompt, tool call, and response is stored as a structured trace in Deeplake.
- **Auto-recall** — relevant traces and codified skills surface automatically before each agent turn.
- **Skill codification** — recurring patterns from your team's recent sessions are auto-codified into reusable skills (`SKILL.md`) and propagated to every agent on your team.
- **Cross-platform** — the same trace store and skills are accessible from Claude Code, Codex, OpenClaw, Cursor, Hermes, and pi.
- **Team-wide** — every user in your Deeplake workspace draws from the same accumulated capability.

## Commands

| Command | What it does |
|---------|--------------|
| `/hivemind_login` | Sign in via device flow |
| `/hivemind_setup` | Add `hivemind` to OpenClaw's tool allowlist (one-time, after install) |
| `/hivemind_capture` | Toggle conversation capture on/off |
| `/hivemind_whoami` | Show current org and workspace |
| `/hivemind_orgs` | List organizations |
| `/hivemind_switch_org <name>` | Switch organization |
| `/hivemind_workspaces` | List workspaces |
| `/hivemind_switch_workspace <id>` | Switch workspace |
| `/hivemind_version` | Show installed version and check ClawHub for a newer one |
| `/hivemind_update` | Show how to install the latest version |
| `/hivemind_autoupdate [on\|off]` | Toggle the agent-facing update nudge (on by default) |

You can also just ask the agent naturally — "switch org to activeloop", "list my orgs", "invite alice@example.com as admin", etc.

## Privacy & data

- **What's captured**: every user prompt, tool call, tool response, and assistant reply, plus codified skills extracted from those traces — all sent to `api.deeplake.ai`. All members of your Deeplake workspace can read this data.
- **Where credentials live**: a long-lived API token at `~/.deeplake/credentials.json` (file permissions 0600).
- **Where it sends data**: `api.deeplake.ai` (trace + skill storage) and `clawhub.ai` (version check on session start and via `/hivemind_version`).
- **How to pause**: run `/hivemind_capture` to stop capture; run it again to resume.
- **How to fully sign out**: delete `~/.deeplake/credentials.json` and revoke the token in the Deeplake dashboard.

### OpenClaw config changes

The plugin modifies `~/.openclaw/openclaw.json` in two places, both triggered by explicit user commands and both with timestamped backups:

- `/hivemind_setup` appends `"hivemind"` to `tools.alsoAllow` so OpenClaw admits the plugin's agent tools. OpenClaw's default `coding` profile only exposes core tools (read/write/exec/etc.) to agents; plugin-registered tools are filtered out unless explicitly allowed.
- `/hivemind_autoupdate [on|off]` sets `plugins.entries.hivemind.config.autoUpdate`. When on, the plugin adds a short line to the system prompt when a newer version is available on ClawHub; the actual install runs through the agent's existing `exec` tool or via `openclaw plugins update hivemind` in a terminal.

The plugin does **not** replace the built-in memory plugin. It runs alongside `memory-core` via lifecycle hooks, so `memory-core`'s dreaming cron and other memory-slot jobs keep working.

## Troubleshooting

**Hivemind feels slow or makes tools hang.**
Check `agents.defaults.model` in `~/.openclaw/openclaw.json`. Hivemind issues many small tool calls per turn; a large reasoning model feels sluggish. Recommended default is `anthropic/claude-haiku-4-5-20251001`.

**Model switch rejected as "not allowed".**
OpenClaw's allowlist wants `<provider>/<exact-dated-id>`. Use `anthropic/claude-haiku-4-5-20251001` or `anthropic/claude-sonnet-4-6`. Bare IDs and `-latest` suffixes are rejected.

**`openclaw model <id>` fails with "plugins.allow excludes model".**
The CLI is disabled by default. Edit `~/.openclaw/openclaw.json` under `agents.defaults.model` and restart the gateway: `systemctl --user restart openclaw-gateway.service`.

**Telegram-triggered `sudo npm i -g openclaw@latest` fails with "elevated is not available".**
`tools.elevated.allowFrom.telegram` isn't set. Run the upgrade in a local shell instead.

## Sharing capability with teammates

Invite teammates to your Deeplake org:

```
invite alice@example.com as admin
```

Their agents draw from your team's traces and codified skills; yours draw from theirs. No setup, no sync, no merge conflicts.

## Source

[github.com/activeloopai/hivemind](https://github.com/activeloopai/hivemind)
