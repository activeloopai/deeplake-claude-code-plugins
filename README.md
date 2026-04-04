# Deeplake Memory — Claude Code Plugin

Persistent, shared memory for Claude Code backed by [Deeplake](https://deeplake.ai). Captures conversation history, tool calls, and responses across sessions and makes them searchable by any agent or user in the same workspace.

## What it does

- **Captures** every session's prompts, tool calls, and responses into a shared Deeplake table
- **Intercepts** file operations targeting `~/.deeplake/memory/` and routes them through a virtual filesystem backed by Deeplake cloud SQL
- **Provides** BM25 full-text search across all captured memory via `Grep pattern="keyword" path="~/.deeplake/memory"`
- **Upgrades** gracefully: basic mode (just-bash virtual FS) works out of the box; install the Deeplake CLI for full FUSE mount support

## ⚠️ Data Collection Notice

This plugin captures the following data and stores it in your Deeplake workspace:

| Data | What | Where |
|------|------|-------|
| User prompts | Every message you send to Claude | Shared Deeplake workspace |
| Tool calls | Tool name + input (up to 5000 chars) | Shared Deeplake workspace |
| Tool responses | Tool output (up to 5000 chars) | Shared Deeplake workspace |
| File operations | Reads/writes to `~/.deeplake/memory/` | Shared Deeplake workspace |

**All users with access to your Deeplake workspace can read this data.**

To opt out of capture: `export DEEPLAKE_CAPTURE=false`

## Setup

### 1. Credentials

Create `~/.deeplake/credentials.json` (permissions: 0600):

```json
{
  "token": "your-deeplake-api-token",
  "orgId": "your-org-id",
  "workspaceId": "default"
}
```

Or use environment variables:

```bash
export DEEPLAKE_TOKEN=your-token
export DEEPLAKE_ORG_ID=your-org-id
export DEEPLAKE_WORKSPACE_ID=default   # optional, defaults to "default"
export DEEPLAKE_API_URL=https://api.deeplake.ai  # optional
```

Get your token at [app.activeloop.ai](https://app.activeloop.ai).

### 2. Install the plugin

```bash
# In your Claude Code settings, add this plugin directory
# or install via the Claude Code marketplace
```

### 3. Optional: Install Deeplake CLI for FUSE support

The lightweight plugin uses a virtual filesystem (just-bash) for basic operations. For full FUSE mount support (required for Python pipelines, arbitrary shell scripts, etc.):

```bash
curl -fsSL https://deeplake.ai/install.sh | bash
deeplake mount ~/.deeplake/memory
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPLAKE_TOKEN` | — | API token (required) |
| `DEEPLAKE_ORG_ID` | — | Organization ID (required) |
| `DEEPLAKE_WORKSPACE_ID` | `default` | Workspace name |
| `DEEPLAKE_API_URL` | `https://api.deeplake.ai` | API endpoint |
| `DEEPLAKE_TABLE` | `memory` | SQL table for shell/virtual FS |
| `DEEPLAKE_MEMORY_TABLE` | `memory` | SQL table for hook captures |
| `DEEPLAKE_MOUNT` | `/` | Virtual FS mount point |
| `DEEPLAKE_MEMORY_PATH` | `~/.deeplake/memory` | Local memory path |
| `DEEPLAKE_MEMORY_DIR` | `~/.deeplake/memory` | Local capture directory |
| `DEEPLAKE_CAPTURE` | `true` | Set to `false` to disable capture |
| `DEEPLAKE_DEBUG` | `false` | Set to `1` for hook debug logs |

## Usage

### Search memory

```bash
# In Claude Code, ask Claude to search memory:
# "Search for what we discussed about authentication"

# Or use the shell directly:
npm run shell -- -c "grep -r 'authentication' /"
```

### Interactive shell

```bash
npm run shell
# ds:/$ ls /
# ds:/$ cat /memory/notes.txt
# ds:/$ echo "todo: fix the bug" > /memory/todo.txt
```

### One-shot commands

```bash
npm run shell -- -c "ls /"
npm run shell -- -c "cat /CLAUDE.md"
npm run shell -- -c "grep -r 'keyword' /memory"
```

## Architecture

```
Claude Code
    ↓
SessionStart hook → injects memory context + pre-loads bootstrap cache
    ↓
PreToolUse hook  → intercepts Read/Write/Edit/Glob/Grep/Bash on memory path
    |                runs safe commands through just-bash + DeeplakeFS
    |                unsafe commands: check for Deeplake CLI or show install prompt
    ↓
PostToolUse hook → captures tool activity to ~/.deeplake/memory/ JSONL
    ↓
Stop hook        → captures final response, cleans up session cache

DeeplakeFS (virtual filesystem)
    ↓ bootstrap: SELECT path, size_bytes, mime_type (cached from SessionStart)
    ↓ reads:  SELECT content_text, content WHERE path = ?
    ↓ writes: DELETE + INSERT with hex-encoded binary content
    ↓ search: BM25 via content_text <#> 'pattern'
    ↓
Deeplake SQL API (https://api.deeplake.ai)
```

## Security

- SQL values are escaped with `sqlStr()`, `sqlLike()`, `sqlIdent()` (see `src/utils/sql.ts`)
- Shell arguments use POSIX single-quote escaping before `execSync()`
- Only commands using allowlisted builtins (cat, ls, grep, find, etc.) run in the virtual FS
- Credentials are loaded from file or environment — never hardcoded

## Development

```bash
npm install
npm test          # vitest unit tests
npm run build     # tsc + esbuild bundle
npm run shell     # interactive shell against real Deeplake
DEEPLAKE_DEBUG=1 npm run shell  # with debug logging
```

## License

Proprietary — © Activeloop, Inc.
