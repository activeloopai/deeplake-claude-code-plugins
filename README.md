<h1 align="center">
  <br>
  <a href="https://github.com/activeloopai/hivemind">
    <img src="https://raw.githubusercontent.com/activeloopai/hivemind/main/docs/public/hivemind-logo.svg" alt="Hivemind" width="120">
  </a>
  <br>
  Hivemind
  <br>
</h1>

<h4 align="center">One brain for every agent on your team.</h4>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg" alt="Node"></a>
  <a href="https://deeplake.ai"><img src="https://img.shields.io/badge/Powered%20by-Deeplake-orange.svg" alt="Deeplake"></a>
</p>

<p align="center">
  Persistent, cloud-backed shared memory for AI agents.<br>
  Captures everything. Recalls anything. Shares across sessions, teammates, and machines.
</p>

---

## What it does

- 🧠 **Captures** every session's prompts, tool calls, and responses into a shared cloud SQL table
- 🔍 **Searches** across all memory with BM25 full-text search (falls back to ILIKE when index unavailable)
- 🔗 **Shares** memory across sessions, agents, teammates, and machines in real-time
- 📁 **Intercepts** file operations on `~/.deeplake/memory/` through a virtual filesystem backed by SQL
- 📝 **Summarizes** sessions into AI-generated wiki pages via a background worker at session end

## Platforms

| Platform       | Status        | Install                                                    |
|----------------|---------------|-------------------------------------------------------------|
| **Claude Code** | ✅ Stable      | See [Quick start](#quick-start-claude-code)                |
| **OpenClaw**    | 🔧 Beta        | See [Quick start](#quick-start-openclaw)                   |
| **Codex**       | 🔜 Coming soon | —                                                           |

## Quick start (Claude Code)

Add the marketplace:

```
/plugin marketplace add activeloopai/hivemind
```

Install the plugin:

```
/plugin install hivemind
```

Reload plugins:

```
/reload-plugins
```

Log in:

```
/hivemind:login
```

That's it. Your agents now share a brain.

### Updating

The plugin auto-updates on each session start. To manually update:

```
/hivemind:update
```

## Quick start (OpenClaw)

Install from ClawHub (Telegram, TUI, WhatsApp):

```
openclaw plugins install hivemind
```

Send a message — the plugin sends you an auth link. Click, sign in, done.

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                     Your AI Agent                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  📥 Capture (every turn)            │
        │  prompts · tool calls · responses   │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  🧠 Hivemind Cloud                  │
        │  SQL tables · BM25 search           │
        │  shared across all agents           │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  🔍 Recall (before each turn)       │
        │  search memory · inject context     │
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

After each session, a background worker generates a wiki summary — key decisions, code changes, next steps. Browse them at `~/.deeplake/memory/summaries/`.

### 👥 Team sharing

Invite teammates to your Deeplake org. Their agents see your memory, your agents see theirs. No setup, no sync, no merge conflicts.

### 🔒 Privacy controls

Disable capture entirely:

```bash
DEEPLAKE_CAPTURE=false claude
```

Enable debug logging:

```bash
DEEPLAKE_DEBUG=1 claude
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
| `DEEPLAKE_TOKEN`          | —                         | API token (auto-set by login)              |
| `DEEPLAKE_ORG_ID`         | —                         | Organization ID (auto-set by login)        |
| `DEEPLAKE_WORKSPACE_ID`   | `default`                 | Workspace name                             |
| `DEEPLAKE_API_URL`        | `https://api.deeplake.ai` | API endpoint                               |
| `DEEPLAKE_TABLE`          | `memory`                  | SQL table for summaries and virtual FS     |
| `DEEPLAKE_SESSIONS_TABLE` | `sessions`                | SQL table for per-event session capture    |
| `DEEPLAKE_MEMORY_PATH`    | `~/.deeplake/memory`      | Path that triggers interception            |
| `DEEPLAKE_CAPTURE`        | `true`                    | Set to `false` to disable capture          |
| `DEEPLAKE_DEBUG`          | —                         | Set to `1` for verbose hook debug logs     |

## Architecture

### Hook lifecycle (Claude Code)

| Hook                | Purpose                                          | Async |
|---------------------|--------------------------------------------------|-------|
| `SessionStart`      | Auth login, inject context, DATA NOTICE          | No    |
| `UserPromptSubmit`  | Capture user message                             | No    |
| `PreToolUse`        | Intercept and rewrite memory-targeting commands   | No    |
| `PostToolUse`       | Capture tool call + response                     | Yes   |
| `Stop`              | Capture assistant response                       | No    |
| `SubagentStop`      | Capture subagent activity                        | Yes   |
| `SessionEnd`        | Spawn wiki-worker for AI summary                 | No    |

### Monorepo structure

```
hivemind/
├── src/                    ← shared core (API client, auth, config, SQL utils)
├── claude-code/            ← Claude Code plugin (hooks, virtual FS, shell)
├── openclaw/               ← OpenClaw plugin (auto-recall, auto-capture)
└── codex/                  ← coming soon
```

## Security

- SQL values escaped with `sqlStr()`, `sqlLike()`, `sqlIdent()`
- ~70 allowlisted builtins run in the virtual FS; unrecognized commands are denied
- Credentials stored with mode `0600`, config dir with mode `0700`
- Device flow login — no tokens in environment or code
- `DEEPLAKE_CAPTURE=false` fully disables data collection

## Development

```bash
git clone https://github.com/activeloopai/hivemind.git
cd hivemind
npm install
npm run build     # tsc + esbuild → claude-code/bundle/ + openclaw/dist/
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
