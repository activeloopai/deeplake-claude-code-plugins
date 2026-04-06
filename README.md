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
/plugin marketplace add activeloopai/deeplake-claude-code-plugins
/plugin install deeplake-hivemind@deeplake-claude-code-plugins
/reload-plugins
```

### From source (development)

```bash
npm install
npm run build
claude --plugin-dir /path/to/deeplake-claude-code-plugins
```

## Authentication

On first session start, the plugin automatically triggers a browser-based login via the OAuth Device Authorization Flow (RFC 8628). No manual token setup required.

1. The plugin detects no credentials at `~/.deeplake/credentials.json`
2. Opens your browser to sign in at Deeplake
3. Polls for the token and saves it locally (permissions: 0600)

To re-login or switch organizations, use the commands injected at session start:

```bash
# Re-login
node "<auth-cmd-path>" login

# List and switch organizations
node "<auth-cmd-path>" org list
node "<auth-cmd-path>" org switch <name-or-id>

# Invite members
node "<auth-cmd-path>" invite <email> <ADMIN|WRITE|READ>
```

The exact `<auth-cmd-path>` is injected into Claude's context at session start.

Alternatively, set environment variables directly:

```bash
export DEEPLAKE_TOKEN=your-token
export DEEPLAKE_ORG_ID=your-org-id
export DEEPLAKE_WORKSPACE_ID=default   # optional
```

Or add to `~/.claude/settings.json`:

```json
{
  "env": {
    "DEEPLAKE_TOKEN": "your-token",
    "DEEPLAKE_ORG_ID": "your-org-id"
  }
}
```

## ⚠️ Data Collection Notice

This plugin captures the following data and stores it in your Deeplake workspace:

| Data | What | Where |
|------|------|-------|
| User prompts | Every message you send to Claude | Shared Deeplake workspace |
| Tool calls | Tool name + input (up to 5000 chars) | Shared Deeplake workspace |
| Tool responses | Tool output (up to 5000 chars) | Shared Deeplake workspace |
| Assistant responses | Claude's final response text | Shared Deeplake workspace |
| Subagent activity | Subagent tool calls and responses | Shared Deeplake workspace |

**All users with access to your Deeplake workspace can read this data.**

A DATA NOTICE is displayed at the start of every session when capture is enabled.

To opt out of capture: `export DEEPLAKE_CAPTURE=false`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPLAKE_TOKEN` | — | API token (auto-set by device login) |
| `DEEPLAKE_ORG_ID` | — | Organization ID (auto-set by device login) |
| `DEEPLAKE_WORKSPACE_ID` | `default` | Workspace name |
| `DEEPLAKE_API_URL` | `https://api.deeplake.ai` | API endpoint |
| `DEEPLAKE_TABLE` | `memory` | SQL table for virtual FS |
| `DEEPLAKE_MEMORY_PATH` | `~/.deeplake/memory` | Path that triggers interception |
| `DEEPLAKE_CAPTURE` | `true` | Set to `false` to disable capture |
| `DEEPLAKE_DEBUG` | — | Set to `1` for verbose hook debug logs |

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
Claude Code
    ↓
SessionStart hook → auth login (device flow) + injects memory context + DATA NOTICE
    ↓
PreToolUse hook  → intercepts Read/Grep/Glob/Bash on ~/.deeplake/memory/
    |                safe commands (cat, ls, grep, jq, find, etc.) → just-bash + DeeplakeFS
    |                unsafe commands (python3, node) → pass through if CLI installed, deny if not
    |                deeplake CLI commands (mount, login) → pass through to real bash
    ↓
PostToolUse hook → captures tool activity (async)
    ↓
Stop hook        → captures final assistant response
    ↓
SubagentStop     → captures subagent activity (async)

DeeplakeFS (virtual filesystem)
    ↓ bootstrap: SELECT path, size_bytes, mime_type
    ↓ reads:  SELECT content_text, content WHERE path = ?
    ↓ writes: DELETE + INSERT with hex-encoded binary content
    ↓ search: BM25 via content_text <#> 'pattern' (with in-memory fallback)
    ↓
Deeplake SQL API (https://api.deeplake.ai)
```

### Hook events

| Hook | Purpose | Async |
|------|---------|-------|
| `SessionStart` | Auth login, inject context, DATA NOTICE | No |
| `UserPromptSubmit` | Capture user message | No |
| `PreToolUse` | Intercept and rewrite memory-targeting commands | No |
| `PostToolUse` | Capture tool call + response | Yes |
| `Stop` | Capture assistant response | No |
| `SubagentStop` | Capture subagent activity | Yes |

## Security

- SQL values escaped with `sqlStr()`, `sqlLike()`, `sqlIdent()` (see `src/utils/sql.ts`)
- Only 80+ allowlisted builtins run in the virtual FS; unsafe binaries pass through or are denied
- Credentials stored with mode `0600`, config dir with mode `0700`
- Device flow login — no tokens in environment or code
- `DEEPLAKE_CAPTURE=false` fully disables data collection

## Development

```bash
npm install
npm test          # vitest unit tests
npm run build     # tsc + esbuild bundle
npm run shell     # interactive shell against real Deeplake
DEEPLAKE_DEBUG=1 npm run shell  # with debug logging
```

After making changes, run `npm run build` and send a new message in Claude Code to pick up the updated hooks.

## License

Proprietary — © Activeloop, Inc.
