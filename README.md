<<<<<<< HEAD
# Deeplake Memory — Claude Code Plugin

Persistent, shared memory for Claude Code backed by [Deeplake](https://deeplake.ai). Captures conversation history, tool calls, and responses across sessions and makes them searchable by any agent or user in the same workspace.

## What it does

- **Captures** every session's prompts, tool calls, and responses into a shared Deeplake table
- **Intercepts** file operations targeting `~/.deeplake/memory/` and routes them through a virtual filesystem backed by Deeplake cloud SQL
- **Provides** full-text search across all captured memory via `Grep pattern="keyword" path="~/.deeplake/memory"`
- **Upgrades** gracefully: basic mode (just-bash virtual FS) works out of the box; install the Deeplake CLI for full FUSE mount support

## Installation

### As a Claude Code plugin

From within Claude Code, run:

```
/plugin marketplace add activeloopai/hivemind
/plugin install hivemind
/reload-plugins
/hivemind:login
```

### Updating

The plugin auto-updates by default — it checks for new versions on each session start and installs them automatically. You'll see a notice when an update is applied; run `/reload-plugins` to activate it.

To manually update:

```
/hivemind:update
```

To toggle auto-updates:

```
autoupdate off   # disable (via org management CLI)
autoupdate on    # re-enable
autoupdate       # check current status
```

### From source (development)

```bash
npm install
npm run build
claude --plugin-dir /path/to/hivemind
/hivemind:login
```

## Authentication

After installing the plugin, run `/hivemind:login` to authenticate. This opens a browser for SSO login via the OAuth Device Authorization Flow (RFC 8628).

1. Run `/hivemind:login` in Claude Code
2. Browser opens — sign in at Deeplake
3. Select your organization
4. Credentials saved to `~/.deeplake/credentials.json` (permissions: 0600)

On subsequent sessions, the plugin detects existing credentials and connects automatically.

To re-login or switch organizations:

```
/hivemind:login
```

Alternatively, set environment variables directly:

```bash
export DEEPLAKE_TOKEN=your-token
export DEEPLAKE_ORG_ID=your-org-id
export DEEPLAKE_WORKSPACE_ID=default   # optional
```
```

## ⚠️ Data Collection Notice

This plugin captures the following data and stores it in your Deeplake workspace:

| Data                  | What                               | Where                     |
|-----------------------|------------------------------------|---------------------------|
| User prompts          | Every message you send to Claude   | Shared Deeplake workspace |
| Tool calls            | Tool name + full input             | Shared Deeplake workspace |
| Tool responses        | Full tool output                   | Shared Deeplake workspace |
| Assistant responses   | Claude's final response text       | Shared Deeplake workspace |
| Subagent activity     | Subagent tool calls and responses  | Shared Deeplake workspace |

**All users with access to your Deeplake workspace can read this data.**

A DATA NOTICE is displayed at the start of every session when capture is enabled.

To opt out of capture: `export DEEPLAKE_CAPTURE=false`

## Configuration

| Variable                 | Default                   | Description                               |
|--------------------------|---------------------------|-------------------------------------------|
| `DEEPLAKE_TOKEN`         | —                         | API token (auto-set by device login)      |
| `DEEPLAKE_ORG_ID`        | —                         | Organization ID (auto-set by device login)|
| `DEEPLAKE_WORKSPACE_ID`  | `default`                 | Workspace name                            |
| `DEEPLAKE_API_URL`       | `https://api.deeplake.ai` | API endpoint                              |
| `DEEPLAKE_TABLE`         | `memory`                  | SQL table for summaries and virtual FS    |
| `DEEPLAKE_SESSIONS_TABLE`| `sessions`                | SQL table for per-event session capture   |
| `DEEPLAKE_MEMORY_PATH`   | `~/.deeplake/memory`      | Path that triggers interception           |
| `DEEPLAKE_CAPTURE`       | `true`                    | Set to `false` to disable capture         |
| `DEEPLAKE_DEBUG`         | —                         | Set to `1` for verbose hook debug logs    |

### Debug mode and capture control

```bash
# Enable debug logging (writes to ~/.deeplake/hook-debug.log)
DEEPLAKE_DEBUG=1 claude

# Disable session capture
DEEPLAKE_CAPTURE=false claude
```

## Usage

### Search memory

In Claude Code, just ask:

```
"What was Emanuele working on?"
"Search deeplake memory for authentication"
"List files in ~/.deeplake/memory/"
```

Claude automatically checks both built-in memory and Deeplake memory when recalling information.

### Interactive shell

```bash
npm run shell
# ds:/$ ls /
# ds:/$ cat /session_abc123.jsonl
# ds:/$ echo "note" > /notes.txt
```

### One-shot commands

```bash
npm run shell -- -c "ls /"
npm run shell -- -c "cat /CLAUDE.md"
npm run shell -- -c "grep -r 'keyword' /"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Claude Code                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  SessionStart                                               │
│  Auth login (device flow) + inject context + DATA NOTICE    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  UserPromptSubmit → capture.js → INSERT row into sessions   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  PreToolUse — intercept commands on ~/.deeplake/memory/     │
│                                                             │
│  ├─ Read/Grep (fast path)       → direct SQL query          │
│  ├─ safe (cat, ls, jq...)       → just-bash + DeeplakeFS    │
│  ├─ unsafe + CLI installed      → real bash + FUSE mount    │
│  ├─ unsafe + no CLI             → deny + install prompt     │
│  └─ deeplake mount/login        → pass through              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  PostToolUse (async) → capture.js → INSERT row into sessions│
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Stop → capture.js → INSERT row into sessions               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  SubagentStop (async) → capture.js → INSERT row into sessions│
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  SessionEnd → spawns wiki-worker.js in background           │
│  → fetches events, runs claude -p, uploads summary          │
│  → /summaries/*.md + /index.md                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   Deeplake REST API                         │
│       sessions table · memory table (summaries, index)      │
└─────────────────────────────────────────────────────────────┘
```

### Hook events

All capture hooks use a single unified `capture.js` bundle — one INSERT per event into the sessions SQL table.

| Hook                | Bundle           | Purpose                                         | Async |
|---------------------|------------------|-------------------------------------------------|-------|
| `SessionStart`      | `session-start`  | Auth login, inject context, DATA NOTICE         |  No   |
| `UserPromptSubmit`  | `capture`        | Capture user message                            |  No   |
| `PreToolUse`        | `pre-tool-use`   | Intercept and rewrite memory-targeting commands |  No   |
| `PostToolUse`       | `capture`        | Capture tool call + response                    |  Yes  |
| `Stop`              | `capture`        | Capture assistant response                      |  No   |
| `SubagentStop`      | `capture`        | Capture subagent activity                       |  Yes  |
| `SessionEnd`        | `session-end`    | Spawn wiki-worker for AI summary                |  No   |

## Security

- SQL values escaped with `sqlStr()`, `sqlLike()`, `sqlIdent()` (see `src/utils/sql.ts`)
- Only 80+ allowlisted builtins run in the virtual FS; unsafe binaries pass through or are denied
- Credentials stored with mode `0600`, config dir with mode `0700`
- Device flow login — no tokens in environment or code
- `DEEPLAKE_CAPTURE=false` fully disables data collection

## Local development

### Prerequisites

- **Node.js >= 22** — install via [nodejs.org](https://nodejs.org) or a version manager:
  ```bash
  # nvm
  nvm install 22

  # brew
  brew install node
  ```

### Setup

```bash
git clone https://github.com/activeloopai/hivemind.git
cd hivemind
npm install
npm run build     # tsc + esbuild → bundle/
```

### Commands

```bash
npm run build     # TypeScript compile + esbuild bundle
npm run bundle    # esbuild bundle only (skip tsc)
npm run dev       # TypeScript watch mode
npm test          # vitest unit tests
npm run shell     # interactive shell against real Deeplake
DEEPLAKE_DEBUG=1 npm run shell  # with debug logging
```

### Test the plugin locally with Claude Code

```bash
claude --plugin-dir .
```

After making changes, run `npm run build` and send a new message in Claude Code to pick up the updated hooks.

## License

Apache License 2.0 — © Activeloop, Inc. See [LICENSE](LICENSE) for details.
=======
>>>>>>> origin/main
