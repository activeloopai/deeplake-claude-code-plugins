# Deeplake Memory — Claude Code Plugin

Persistent, shared memory for [Claude Code](https://claude.ai/code) backed by [Deeplake](https://deeplake.ai). Read, write, and search memory that survives across sessions and is shared across agents in the same workspace.

## Features

- **Persistent memory** — file operations on `~/.deeplake/memory/` are intercepted and routed to Deeplake cloud SQL, no local storage needed
- **Automatic capture** — prompts, tool calls, and responses are logged to a shared Deeplake table (opt-out available)
- **Full-text search** — BM25-powered search across all stored memory via `Grep`
- **Multi-agent sync** — all agents and users in the same workspace share the same memory in real-time
- **Virtual filesystem** — safe shell commands (cat, ls, grep, jq, ...) run against Deeplake-backed storage without a FUSE mount
- **SSO login** — browser-based device flow authentication, org switching, and member management

## Quick start

### Prerequisites

- **Node.js >= 22** — install via [nodejs.org](https://nodejs.org) or a version manager:
  ```bash
  # nvm
  nvm install 22

  # brew
  brew install node
  ```

### 1. Install the plugin

**From the Claude Code marketplace (coming soon):**

```bash
# One-time: add the marketplace
/plugin marketplace add activeloopai/deeplake-claude-code-plugins

# Install the plugin
/plugin install deeplake-hivemind@deeplake-claude-code-plugins
```

**From source (development):**

```bash
git clone <repo-url> deeplake-claude-code-plugins
cd deeplake-claude-code-plugins
npm install && npm run build
claude --plugin-dir .
```

### 2. Authenticate

On first launch, the plugin checks for credentials. If none are found it starts a browser-based device flow:

```
[deeplake] No credentials found — opening browser for login...
[deeplake] Visit: https://app.activeloop.ai/device?code=ABCD-1234
```

Credentials are saved to `~/.deeplake/credentials.json` (mode 0600).

You can also set credentials manually:

```json
{
  "token": "your-deeplake-api-token",
  "orgId": "your-org-id",
  "workspaceId": "default"
}
```

Or via environment variables:

```bash
export DEEPLAKE_TOKEN=your-token
export DEEPLAKE_ORG_ID=your-org-id
```

Get your token at [app.activeloop.ai](https://app.activeloop.ai).

### 3. Use it

Once installed, Claude Code automatically has access to persistent memory. Just ask:

> "Save a note that the auth service uses JWT with RS256"

> "What did we discuss about the database schema last week?"

> "Search memory for authentication"

## Plugin management

```bash
# List installed plugins (inside Claude Code)
/plugin

# Disable without removing
claude plugin disable deeplake

# Re-enable
claude plugin enable deeplake

# Update to latest version
claude plugin update deeplake

# Remove completely
claude plugin uninstall deeplake
```

## Data collection notice

This plugin captures the following data and stores it in your Deeplake workspace:

| Data | What | Where |
|------|------|-------|
| User prompts | Every message you send to Claude | Shared Deeplake workspace |
| Tool calls | Tool name + input (up to 5000 chars) | Shared Deeplake workspace |
| Tool responses | Tool output (up to 5000 chars) | Shared Deeplake workspace |
| File operations | Reads/writes to `~/.deeplake/memory/` | Shared Deeplake workspace |

**All users with access to your Deeplake workspace can read this data.**

To opt out of capture:

```bash
export DEEPLAKE_CAPTURE=false
```

## Usage

### Memory operations (inside Claude Code)

Claude Code can read and write files in `~/.deeplake/memory/` using its normal tools — the plugin intercepts these operations and routes them through the Deeplake virtual filesystem:

```
# Claude uses Read, Write, Grep, Glob as usual — the plugin handles the rest
Read  path="~/.deeplake/memory/notes.md"
Write path="~/.deeplake/memory/notes.md" content="..."
Grep  pattern="authentication" path="~/.deeplake/memory"
```

### Interactive shell

```bash
npm run shell
# ds:/$ ls /
# ds:/$ cat /memory/notes.txt
# ds:/$ echo "todo: fix the bug" > /memory/todo.txt
# ds:/$ grep -r 'keyword' /memory
```

### One-shot commands

```bash
npm run shell -- -c "ls /"
npm run shell -- -c "cat /memory/notes.txt"
npm run shell -- -c "grep -ri 'auth' /memory"
```

### Organization management

Inside Claude Code, use the `/deeplake` skill:

```
# List organizations
deeplake org list

# Switch organization
deeplake org switch <org-id>

# Invite a member
deeplake invite user@example.com

# List members
deeplake members
```

### Optional: FUSE mount

The plugin works out of the box with a virtual filesystem. For full FUSE mount support (needed for Python pipelines, arbitrary shell scripts, etc.):

```bash
curl -fsSL https://deeplake.ai/install.sh | bash
deeplake mount ~/.deeplake/memory
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPLAKE_TOKEN` | — | API token (required unless using device flow) |
| `DEEPLAKE_ORG_ID` | — | Organization ID (required unless using device flow) |
| `DEEPLAKE_WORKSPACE_ID` | `default` | Workspace name |
| `DEEPLAKE_API_URL` | `https://api.deeplake.ai` | API endpoint |
| `DEEPLAKE_TABLE` | `memory` | SQL table for shell / virtual FS |
| `DEEPLAKE_MEMORY_TABLE` | `memory` | SQL table for hook captures |
| `DEEPLAKE_MOUNT` | `/` | Virtual FS mount point |
| `DEEPLAKE_MEMORY_PATH` | `~/.deeplake/memory` | Local memory path |
| `DEEPLAKE_CAPTURE` | `true` | Set to `false` to disable capture |
| `DEEPLAKE_DEBUG` | `false` | Set to `1` for debug logs → `~/.deeplake/hook-debug.log` |

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

- SQL values escaped with `sqlStr()`, `sqlLike()`, `sqlIdent()` — no raw interpolation
- Shell arguments use POSIX single-quote escaping before `execSync()`
- Only allowlisted builtins (cat, ls, grep, find, jq, ...) run in the virtual FS
- Credentials loaded from file (mode 0600) or environment — never hardcoded

## Development

```bash
npm install
npm run build     # tsc + esbuild → bundle/
npm test          # vitest unit tests
npm run shell     # interactive shell against real Deeplake
npm run dev       # tsc watch mode

# Debug mode
DEEPLAKE_DEBUG=1 npm run shell

# Test the plugin locally with Claude Code
claude --plugin-dir .
```

## License

Proprietary — © Activeloop, Inc.
