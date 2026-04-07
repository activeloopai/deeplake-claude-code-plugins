le# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin that provides persistent, cloud-backed memory for AI agents. It captures session activity (prompts, tool calls, responses) into a Deeplake SQL table and intercepts file operations targeting `~/.deeplake/memory/` through a virtual filesystem backed by Deeplake's API.

## Commands

```bash
npm install           # Install dependencies
npm run build         # TypeScript compile + esbuild bundle (5 ESM outputs into bundle/)
npm run bundle        # esbuild bundle only (skip tsc)
npm run dev           # TypeScript watch mode
npm test              # Run vitest tests
npm run shell         # Interactive virtual shell against Deeplake
DEEPLAKE_DEBUG=1 npm run shell  # Shell with debug logging
```

## Architecture

### Hook Lifecycle

The plugin operates through 5 Claude Code hooks defined in `hooks/hooks.json`. Each hook runs a bundled JS file from `bundle/` as a subprocess:

1. **SessionStart** (`session-start.js`) — Loads credentials, bootstraps the virtual FS cache, injects memory context into Claude's system prompt
2. **UserPromptSubmit** (`capture.js`) — Captures user prompts to session JSONL
3. **PreToolUse** (`pre-tool-use.js`) — Intercepts Read/Write/Edit/Glob/Grep/Bash targeting `~/.deeplake/memory/`, rewrites them to run through the virtual shell. Unsafe commands either pass through to Deeplake CLI (if installed) or show an install prompt
4. **PostToolUse** (`capture.js`, async) — Captures tool name + input + response to session JSONL
5. **Stop** (`capture.js`) — Final capture before session ends

Hooks receive/return JSON via stdin/stdout.

### Key Modules

- **`src/config.ts`** — Credentials from `~/.deeplake/credentials.json` or env vars
- **`src/deeplake-api.ts`** — Two clients: local JSONL appender + HTTP SQL query client against Deeplake API
- **`src/path-match.ts`** — Detects if a tool call targets the memory path
- **`src/shell/deeplake-fs.ts`** — Virtual filesystem (~1000 LOC) implementing `just-bash` IFileSystem. Handles bootstrap from SQL, read/write via SELECT/INSERT+DELETE, BM25 search via `content_text <#> 'pattern'`, batched writes (coalesced every 200ms)
- **`src/shell/grep-interceptor.ts`** — Custom grep using BM25 search instead of regex
- **`src/commands/auth.ts`** — Device authorization flow, org/workspace management

### Build Output

`esbuild.config.mjs` produces 5 ESM bundles in `bundle/`:
- `session-start.js`, `capture.js`, `pre-tool-use.js` (hooks)
- `shell/deeplake-shell.js` (interactive shell)
- `commands/auth-login.js` (auth CLI)

### Security

- SQL injection prevention via `sqlStr()`, `sqlLike()`, `sqlIdent()` in `src/utils/sql.ts`
- Shell commands are checked against an allowlist of ~50 safe builtins before execution
- Shell arguments use POSIX single-quote escaping before `execSync()`

## Testing

Tests are in `tests/` using vitest. They mock the Deeplake API client to verify filesystem behavior:
- `tests/deeplake-fs.test.ts` — Virtual filesystem operations (read/write/list/search)
- `tests/grep-interceptor.test.ts` — BM25 search integration

## Environment Variables

Key config: `DEEPLAKE_TOKEN`, `DEEPLAKE_ORG_ID`, `DEEPLAKE_WORKSPACE_ID` (default: `"default"`), `DEEPLAKE_API_URL`, `DEEPLAKE_TABLE`, `DEEPLAKE_CAPTURE` (set `false` to disable capture), `DEEPLAKE_DEBUG`.
