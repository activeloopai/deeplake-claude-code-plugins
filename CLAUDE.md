# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What This Is

Hivemind — a monorepo containing plugins for Claude Code and OpenClaw that provide persistent, cloud-backed shared memory for AI agents. Powered by Deeplake.

## Monorepo Structure

```
├── src/                  ← shared TypeScript source (config, API client, virtual FS, auth)
├── claude-code/          ← Claude Code plugin (hooks, skills, bundle)
│   ├── .claude-plugin/
│   ├── bundle/           ← checked into git (no build step for marketplace)
│   ├── hooks/hooks.json
│   └── skills/
├── openclaw/             ← OpenClaw plugin
│   ├── openclaw.plugin.json
│   └── src/
├── .claude-plugin/       ← root marketplace.json
├── esbuild.config.mjs    ← builds both plugins
└── package.json          ← single version for everything
```

## Commands

```bash
npm install           # Install dependencies
npm run build         # TypeScript compile + esbuild bundle
npm test              # Run vitest tests
npm run shell         # Interactive virtual shell against Deeplake
```

## Versioning

**Single version** across the entire monorepo. `package.json` version is the source of truth. The release workflow (`release.yml`) auto-syncs to:
- `claude-code/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `openclaw/openclaw.plugin.json`
- `openclaw/package.json`

Never manually bump versions — merge to main triggers auto-bump.

## Architecture

### Table Schema

The memory table uses these columns (shared between CLI and plugin):
- `id`, `path`, `filename`, `summary` (TEXT), `author`, `mime_type`, `size_bytes`, `project`, `description`, `creation_date`, `last_update_date`

**Important**: Column is `summary` not `content_text`. Column is `creation_date` not `created_at`. No BYTEA `content` column — text stored in `summary`.

### Hook Lifecycle (Claude Code)

7 hooks in `claude-code/hooks/hooks.json`:

1. **SessionStart** — auth login, inject memory context, DATA NOTICE, check for updates
2. **UserPromptSubmit** — capture user message to sessions table
3. **PreToolUse** — intercept commands on `~/.deeplake/memory/`, route through virtual shell or pass through
4. **PostToolUse** (async) — capture tool call + response
5. **Stop** — capture assistant response
6. **SubagentStop** (async) — capture subagent activity
7. **SessionEnd** — generate Karpathy-style wiki summary via `claude -p`

### Key Modules

- **`src/config.ts`** — credentials from `~/.deeplake/credentials.json` or env vars
- **`src/deeplake-api.ts`** — REST API client for Deeplake SQL queries (reads + writes)
- **`src/shell/deeplake-fs.ts`** — virtual filesystem implementing just-bash IFileSystem
- **`src/shell/grep-interceptor.ts`** — BM25 search with in-memory fallback
- **`src/commands/auth.ts`** — device auth flow, org/workspace management

### Memory Structure on Deeplake

```
/sessions/<username>/<user>_<org>_<ws>_<slug>.jsonl   ← raw session data
/summaries/<username>/<sessionId>.md                  ← AI wiki summaries
/index.md                                             ← session index table
```

### PreToolUse Command Routing

- Safe commands (cat, ls, grep, jq, 80+ builtins) → just-bash + DeeplakeFS
- Unsafe + CLI installed → pass through to real bash + FUSE
- Unsafe + no CLI → deny with install prompt
- Deeplake CLI commands (mount, login) → always pass through

## Rules

- `bundle/` is checked into git — marketplace has no build step
- All hooks exit 0 on error — never crash Claude Code
- `async: true` on PostToolUse and SubagentStop — non-blocking
- SQL values escaped via `sqlStr()`, `sqlLike()`, `sqlIdent()` in `src/utils/sql.ts`
- `DEEPLAKE_CAPTURE=false` disables all session capture
- `DEEPLAKE_DEBUG=1` enables verbose logging to `~/.deeplake/hook-debug.log`
- Auth command args must be SEPARATE — `node auth-login.js org switch <name>` not `"org switch"`
- Always ask user which role before inviting members
