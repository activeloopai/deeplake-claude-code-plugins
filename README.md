<h1 align="center">
  <br>
  <a href="https://github.com/activeloopai/hivemind">
    <img src="https://raw.githubusercontent.com/activeloopai/hivemind/main/docs/public/hivemind-logo.svg" alt="Hivemind" width="120">
  </a>
  <br>
  Hivemind
  <br>
</h1>

<h4 align="center">One brain for all your agents</h4>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg" alt="Node"></a>
  <a href="https://deeplake.ai"><img src="https://img.shields.io/badge/Powered%20by-Deeplake-orange.svg" alt="Deeplake"></a>
</p>

<p align="center">
  Persistent, cloud-backed shared memory for <b>Claude Code • OpenClaw • Codex • Cursor • Hermes • pi</b> agents.<br>
</p>

> One session ends, everything important disappears. 
>
> Hivemind finally fixes the "agent amnesia" problem. 

Hivemind automatically captures every prompt, tool call, decision, and file operation. Then turns them into searchable memory that is instantly available to every agent and teammate across sessions, machines, and time.

- 🧠 **Captures** every session's prompts, tool calls, and responses into a shared SQL table on Deeplake Cloud
- 🔍 **Searches** across all memory with lexical search (falls back to grep when index unavailable)
- 🔗 **Shares** memory across sessions, agents, teammates, and machines in real-time
- 📁 **Intercepts** file operations on `~/.deeplake/memory/` through a virtual filesystem backed by SQL
- 📝 **Summarizes** sessions into AI-generated wiki pages via a background worker at session end

## Quick start

One command, all your agents:

```bash
npm -g install @deeplake/hivemind && hivemind install
```

That's it. The installer detects every supported assistant on your machine (Claude Code, Codex, OpenClaw, Cursor, Hermes Agent, pi), wires up the hooks, and opens a browser once for login. Restart your assistants and they all share the same brain.

**Install for a specific assistant only:**

```bash
npx @deeplake/hivemind@latest install --only claude
npx @deeplake/hivemind@latest claude install    # equivalent
npx @deeplake/hivemind@latest codex install
npx @deeplake/hivemind@latest claw install
npx @deeplake/hivemind@latest cursor install
npx @deeplake/hivemind@latest hermes install
npx @deeplake/hivemind@latest pi install
```

**Check what's wired up:**

```bash
npx @deeplake/hivemind@latest status
```

**Supported assistants:**

| Platform         | Integration                                      | Auto-capture | Auto-recall |
|------------------|--------------------------------------------------|--------------|-------------|
| **Claude Code**  | Marketplace plugin                               | ✅           | ✅          |
| **OpenClaw**     | Native extension                                 | ✅           | ✅          |
| **Codex**        | Hooks (`hooks.json`)                             | ✅           | ✅          |
| **Cursor**       | Hooks (`hooks.json` 1.7+)                        | ✅           | ✅          |
| **Hermes Agent** | Shell hooks (`config.yaml`) + skill + MCP server | ✅           | ✅          |
| **pi**           | Extension API (`pi.on(...)`) + skill + AGENTS.md | ✅           | ✅          |

### Alternative install paths

<details>
  <summary><b>Claude Code plugin marketplace</b></summary>

If you prefer Claude Code's native plugin marketplace:

```
/plugin marketplace add activeloopai/hivemind
/plugin install hivemind
/reload-plugins
/hivemind:login
```

Auto-updates on each session start. Manual update: `/hivemind:update`.
</details>

<details>
  <summary><b>OpenClaw ClawHub</b></summary>

```
openclaw plugins install clawhub:hivemind
```

Then type `/hivemind_login` in chat, click the auth link, and sign in.

#### Commands

| Command | Description |
|---------|-------------|
| `/hivemind_login` | Sign in via device flow |
| `/hivemind_capture` | Toggle capture on/off |
| `/hivemind_whoami` | Show current org and workspace |
| `/hivemind_orgs` | List organizations |
| `/hivemind_switch_org <name>` | Switch organization |
| `/hivemind_workspaces` | List workspaces |
| `/hivemind_switch_workspace <id>` | Switch workspace |
| `/hivemind_update` | Check for plugin updates |

Auto-recall and auto-capture are enabled by default. Data is stored in the same `sessions` table as Claude Code and Codex.

#### Coexistence with `memory-core`

Hivemind runs **alongside** OpenClaw's built-in `memory-core` plugin. It does **not** claim the memory slot, so `memory-core`'s dreaming cron (`"0 3 * * *"`) and other memory-slot-dependent jobs keep working. Hivemind captures session activity and exposes its own commands; `memory-core` keeps owning recall/promotion/dreaming.

#### Troubleshooting

- **Hivemind seems slow or unresponsive.** Check the agent model in `~/.openclaw/openclaw.json` under `agents.defaults.model`. Hivemind makes many small tool calls per turn; a large reasoning model like Opus will feel sluggish. Recommended default: `anthropic/claude-haiku-4-5-20251001`.
- **`openclaw model <id>` says "plugins.allow excludes model".** The `model` plugin CLI is disabled by default. Edit `~/.openclaw/openclaw.json` directly (key `agents.defaults.model`) and restart the gateway: `systemctl --user restart openclaw-gateway.service`.
- **Model switch rejected as "not allowed".** Use the exact dated provider-prefixed ID (`anthropic/claude-haiku-4-5-20251001`, `anthropic/claude-sonnet-4-6`). Legacy IDs like `claude-3-5-haiku-latest` and unprefixed bare IDs are not on OpenClaw's allowlist.
- **Self-update via Telegram fails with "elevated is not available".** `tools.elevated.allowFrom` must include `telegram` before elevated commands work from that channel. Safer alternative: run the upgrade in a local shell with `openclaw plugins update hivemind`.
- **`npm error EACCES` during self-update.** OpenClaw was installed under a root-owned npm prefix (e.g. `/usr/lib/node_modules/openclaw`). Reinstall under a user-writable prefix, or run the update with appropriate privileges locally — not via a channel.
</details>

<details>
  <summary><b>Codex (manual)</b></summary>

Tell Codex to fetch and follow the install instructions:

```
Fetch and follow instructions from https://raw.githubusercontent.com/activeloopai/hivemind/main/codex/INSTALL.md
```

Or run the installer script directly:

```bash
git clone https://github.com/activeloopai/hivemind.git ~/.codex/hivemind
~/.codex/hivemind/codex/install.sh
```

Restart Codex to activate.
</details>

<details>
  <summary><b>Cursor (1.7+)</b></summary>

The unified installer wires six lifecycle events in `~/.cursor/hooks.json` — sessionStart, beforeSubmitPrompt, postToolUse, afterAgentResponse, stop, sessionEnd. Hooks fork a Node bundle at `~/.cursor/hivemind/bundle/` per event. Restart Cursor after install to load.

```bash
npx @deeplake/hivemind@latest cursor install
```

Auto-capture is enabled the same way as Claude Code / Codex / OpenClaw.
</details>

<details>
  <summary><b>Hermes Agent</b></summary>

Drops an `agentskills.io`-compatible skill at `~/.hermes/skills/hivemind-memory/`. Recall is via direct grep on `~/.deeplake/memory/`. Auto-capture is not yet supported (Hermes' lifecycle-hook surface isn't documented at the time of writing).

```bash
npx @deeplake/hivemind@latest hermes install
```
</details>

<details>
  <summary><b>pi (badlogic/pi-mono coding-agent)</b></summary>

Drops `~/.pi/agent/AGENTS.md` (idempotent BEGIN/END marker block) plus a skill at `~/.pi/agent/skills/hivemind-memory/`. Recall is via direct grep on `~/.deeplake/memory/`.

```bash
npx @deeplake/hivemind@latest pi install
```
</details>


### Uninstall

```bash
npx @deeplake/hivemind@latest uninstall              # remove from every detected assistant
npx @deeplake/hivemind@latest codex uninstall        # remove from one
```

## How it works

```
┌─────────────────────────────────────────────────────┐
│                   Your Coding Agent                 │
└──────────────────────────┬──────────────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  📥 Capture (every turn)            │
        │  prompts · tool calls · responses   │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  🧠 Hivemind                        │
        │  SQL tables · Virtual File System   │
        │  Search Memory · inject context     │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  🌊 Deeplake                        │
        │   Shared across all agents          │
        │   Postgres · S3                     │
        └─────────────────────────────────────┘
```

Every session is captured. Every agent can recall. Teammates in the same org see the same memory.

## Features

### 🔍 Natural search

Just ask Claude naturally:

```
"What was Emanuele working on?"
"Search memory for authentication bugs"
"What did we decide about the API design?"
```

### 📝 AI-generated session summaries

After each session, a background worker generates a wiki summary: key decisions, code changes, next steps. Browse them at `~/.deeplake/memory/summaries/`.

### 👥 Team sharing

Invite teammates to your Deeplake org. Their agents see your memory, your agents see theirs. No setup, no sync, no merge conflicts.

### 🔒 Privacy controls

Disable capture entirely:

```bash
HIVEMIND_CAPTURE=false claude
```

Enable debug logging:

```bash
HIVEMIND_DEBUG=1 claude
```

## ⚠️ Data collection notice

This plugin captures session activity and stores it in your Deeplake workspace:

| Data                  | What's captured                    |
|-----------------------|------------------------------------|
| User prompts          | Every message you send             |
| Tool calls            | Tool name + full input             |
| Tool responses        | Full tool output                   |
| Assistant responses   | Claude's final response            |
| Subagent activity     | Subagent tool calls and responses  |

**All users in your Deeplake workspace can read this data.** A DATA NOTICE is displayed at the start of every session.

## Configuration

| Variable                  | Default                   | Description                                |
|---------------------------|---------------------------|--------------------------------------------|
| `HIVEMIND_TOKEN`          | —                         | API token (auto-set by login)              |
| `HIVEMIND_ORG_ID`         | —                         | Organization ID (auto-set by login)        |
| `HIVEMIND_WORKSPACE_ID`   | `default`                 | Workspace name                             |
| `HIVEMIND_API_URL`        | `https://api.deeplake.ai` | API endpoint                               |
| `HIVEMIND_TABLE`          | `memory`                  | SQL table for summaries and virtual FS     |
| `HIVEMIND_SESSIONS_TABLE` | `sessions`                | SQL table for per-event session capture    |
| `HIVEMIND_MEMORY_PATH`    | `~/.deeplake/memory`      | Path that triggers interception            |
| `HIVEMIND_CAPTURE`        | `true`                    | Set to `false` to disable capture          |
| `HIVEMIND_DEBUG`          | —                         | Set to `1` for verbose hook debug logs     |

## Architecture

### Integration model per agent

| Agent             | Mechanism                          | Hooks/tools wired                                                                       |
|-------------------|------------------------------------|-----------------------------------------------------------------------------------------|
| **Claude Code**   | Marketplace plugin                 | `SessionStart` · `UserPromptSubmit` · `PreToolUse` · `PostToolUse` · `Stop` · `SubagentStop` · `SessionEnd` |
| **Codex**         | `~/.codex/hooks.json`              | `SessionStart` · `UserPromptSubmit` · `PreToolUse(Bash)` · `PostToolUse` · `Stop`        |
| **OpenClaw**      | Native extension at `~/.openclaw/extensions/hivemind/` | `agent_end` capture · `before_agent_start` recall · contracted tools (`hivemind_search`/`read`/`index`) |
| **Cursor (1.7+)** | `~/.cursor/hooks.json`             | `sessionStart` · `beforeSubmitPrompt` · `postToolUse` · `afterAgentResponse` · `stop` · `sessionEnd` |
| **Hermes**        | Skill at `~/.hermes/skills/hivemind-memory/` | recall via grep on `~/.deeplake/memory/`                                                |
| **pi**            | `~/.pi/agent/AGENTS.md` + skill    | recall via grep on `~/.deeplake/memory/`                                                |

### Monorepo structure

```
hivemind/
├── src/                    ← shared core (API client, auth, config, SQL utils)
│   ├── hooks/              ← Claude Code hooks
│   ├── hooks/codex/        ← Codex hooks
│   ├── hooks/cursor/       ← Cursor hooks
│   ├── mcp/                ← MCP server (used by Hermes; available to any future MCP-aware client)
│   └── cli/                ← unified `hivemind install` CLI + per-agent installers
├── claude-code/            ← Claude Code plugin source (marketplace-distributed)
├── openclaw/               ← OpenClaw plugin source
├── codex/                  ← Codex plugin source
├── cursor/                 ← Cursor plugin source
└── mcp/                    ← MCP server build output
```

## Security

- SQL values escaped with `sqlStr()`, `sqlLike()`, `sqlIdent()`
- ~70 allowlisted builtins run in the virtual FS; unrecognized commands are denied
- Credentials stored with mode `0600`, config dir with mode `0700`
- Device flow login: no tokens in environment or code
- `HIVEMIND_CAPTURE=false` fully disables data collection

## Development

```bash
git clone https://github.com/activeloopai/hivemind.git
cd hivemind
npm install
npm run build     # tsc + esbuild → claude-code/bundle/ + codex/bundle/ + cursor/bundle/ + openclaw/dist/ + mcp/bundle/ + bundle/cli.js
npm test          # vitest
```

Test locally with Claude Code:

```bash
claude --plugin-dir claude-code
```

Interactive shell against Deeplake:

```bash
npm run shell
```

## License

Apache License 2.0 — © Activeloop, Inc. See [LICENSE](LICENSE) for details.

