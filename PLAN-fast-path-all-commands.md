# Plan: Fast-path all Bash commands on ~/.deeplake/memory/

## Context

The Deeplake plugin intercepts tool calls targeting `~/.deeplake/memory/` via the `pre-tool-use` hook. Previously, every intercepted command spawned a Node.js shell process (`deeplake-shell.js`) that bootstrapped by loading ALL file metadata (399+379 rows) before executing the actual command. This caused 2-160s latency per command.

**Goal**: Every read-only command gets a single direct SQL query. Zero shell spawns for reads.

## What was changed

### File: `src/hooks/pre-tool-use.ts`

The fast path section (after `getShellCommand()`) was expanded from handling only `Grep` and `Read` tool to handling ALL common Bash commands:

#### 1. grep (Bash + Grep tool) — already done
Delegates to `handleGrepDirect()` from `src/hooks/grep-direct.ts`.
Single SQL: `SELECT path, summary AS content WHERE summary LIKE '%pattern%' AND path LIKE '/dir/%'`

#### 2. cat (Bash) — NEW
**Parser**: `shellCmd.match(/^cat\s+(\S+)\s*$/)`
**SQL**: `SELECT summary FROM "memory" WHERE path = '<path>' LIMIT 1`
Falls back to sessions table for `/sessions/*` paths.

#### 3. head -N (Bash) — NEW
**Parser**: `shellCmd.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/)`
**SQL**: same as cat, then `lines.slice(0, N)` in-memory.

#### 4. tail -N (Bash) — NEW
**Parser**: `shellCmd.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/)`
**SQL**: same as cat, then `lines.slice(-N)` in-memory.

#### 5. ls [flags] dir (Bash + Glob tool) — NEW
**Parser**: `shellCmd.match(/^ls\s+(?:-([a-zA-Z]+)\s+)?(\S+)?\s*$/)`
**SQL**: `SELECT path, size_bytes FROM "memory" WHERE path LIKE '/dir/%' ORDER BY path`
Extracts immediate children from full paths, supports `-l` long format.

#### 6. wc -l file (Bash) — NEW
**Parser**: `shellCmd.match(/^wc\s+-l\s+(\S+)\s*$/)`
**SQL**: same as cat, then `content.split('\n').length`.

#### 7. find dir -name 'pattern' (Bash) — NEW
**Parser**: `shellCmd.match(/^find\s+(\S+)\s+(?:-type\s+\S+\s+)?-name\s+'([^']+)'/)`
**SQL**: `SELECT path FROM "memory" WHERE path LIKE '/dir/%' AND filename LIKE '%.md' ORDER BY path`
Handles piped `| wc -l` by returning count instead of paths.

### Other files changed
- `src/hooks/grep-direct.ts` — shared grep handler (unchanged in this batch)
- `src/shell/grep-interceptor.ts` — fixed mount="/" bug
- `src/shell/deeplake-fs.ts` — removed `deeplake_sync_table` from bootstrap/flush
- `src/hooks/session-start-setup.ts` — removed `deeplake_sync_table`
- `src/hooks/wiki-worker.ts` — removed `deeplake_sync_table` (3x)
- `src/hooks/codex/pre-tool-use.ts` — grep fast path via shared module
- `src/hooks/codex/session-start-setup.ts` — removed `deeplake_sync_table`
- `src/hooks/codex/wiki-worker.ts` — removed `deeplake_sync_table` (3x)

## TODO

- [ ] Investigate BM25 — the old code tried `summary <#> 'pattern'` but always got a 400 error ("Data type mismatch: argument of WHERE must be type boolean, not type real"). Check if the index exists, if the syntax is wrong, or if BM25 is not supported on this table. If fixable, BM25 would give ranked results instead of LIKE substring match.
- [ ] Port cat/head/tail/ls/wc/find fast paths to `src/hooks/codex/pre-tool-use.ts`
- [ ] Run full e2e benchmark to measure overall improvement
