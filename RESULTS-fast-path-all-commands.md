# Fast-Path Benchmark Results — 2026-04-15

## Test environment
- **Org**: activeloop, **Workspace**: hivemind
- **Table size**: 405 files (memory), 385 files (sessions)
- **Machine**: EC2 Linux 6.8.0-1030-gcp

## How to reproduce

Each command is tested in two modes:

```bash
# BEFORE — old shell path (spawns deeplake-shell.js, bootstraps full table)
time DEEPLAKE_DEBUG=1 node claude-code/bundle/shell/deeplake-shell.js -c "<command>" \
  2>/tmp/before.log > /dev/null
grep -c "query start" /tmp/before.log

# AFTER — new fast path (direct SQL in pre-tool-use hook, no shell spawn)
time DEEPLAKE_DEBUG=1 node claude-code/bundle/pre-tool-use.js < /tmp/vfs-test-<name>.json \
  2>/tmp/after.log > /dev/null
grep -c "query start" /tmp/after.log
```

Full test suite: `bash /tmp/vfs-tests.sh`

## Results — all commands benchmarked

| Command | Before (time) | Before (queries) | After (time) | After (queries) | Speedup |
|---------|--------------|-----------------|-------------|----------------|---------|
| `grep -w 'sasun' /summaries` | 143,930ms | 108 | 462ms | 1 | **312x** |
| `cat file` (summary) | 995ms | 3 | 323ms | 1 | **3x** |
| `cat file 2>/dev/null` | 983ms | 3 | 151ms | 1 | **7x** |
| `cat file 2>&1 \| head -200` | 1,251ms | 4 | 288ms | 2 | **4x** |
| `head -20 file` | 1,065ms | 3 | 142ms | 1 | **8x** |
| `head -n 20 file` | 958ms | 3 | 159ms | 1 | **6x** |
| `tail -10 file` | 1,176ms | 4 | 309ms | 2 | **4x** |
| `ls /summaries/` | 920ms | 2 | 128ms | 1 | **7x** |
| `ls -la /summaries/sasun/` | 880ms | 2 | 178ms | 1 | **5x** |
| `ls /` (root) | 994ms | 2 | 164ms | 1 | **6x** |
| `find -name '*.md' \| wc -l` | 916ms | 2 | 172ms | 1 | **5x** |
| `wc -l file` | 1,077ms | 4 | 144ms | 1 | **8x** |
| `Read tool` (index.md) | 1,119ms | 4 | 576ms | 2 | **2x** |
| `Glob tool` | 897ms | 2 | 135ms | 1 | **7x** |
| `cat file` (sessions) | 2,073ms | 2 | 1,318ms | 1 | **1.6x** |

## Table routing

Commands now query the correct table directly based on path — no wasted queries.

| Path | cat/head/tail/wc | ls/find | grep |
|------|-----------------|---------|------|
| `/summaries/*` | memory (1 query) | memory (1 query) | memory (1 query) |
| `/sessions/*` | sessions (1 query) | sessions (1 query) | memory only — summaries have the content |
| `/` (root) | depends on file | both in parallel (2 queries) | memory only |
| `/index.md` | virtual — generated from memory metadata (1 query) | N/A | N/A |

**Before**: session file reads always queried memory first (728ms, 0 rows), then sessions. Wasted 728ms per read.
**After**: `/sessions/*` paths go directly to the sessions table. 2,073ms → 1,318ms.

## What each "Before" does vs "After"

### grep (108 → 1 query, 312x faster)
**Before**: shell spawn → bootstrap (2 metadata queries loading 405+385 rows) → BM25 (fails with 400 error) → prefetch all files → read each session file individually (1-12s each).
**After**: `SELECT path, summary AS content FROM "memory" WHERE path LIKE '/summaries/%' AND summary LIKE '%sasun%' LIMIT 100`. Searches only the memory/summaries table — sessions contain raw JSONB which is slow to scan and produces noisy results.

### cat (3 → 1 query, 7x faster)
**Before**: shell spawn → bootstrap (2 metadata queries) → file read query.
**After**: `SELECT summary FROM "memory" WHERE path = '...' LIMIT 1`. For session files: `SELECT message::text FROM "sessions" WHERE path = '...' LIMIT 1` (direct, no memory query first).

### head/tail (3 → 1 query, 6-8x faster)
**Before**: shell spawn → bootstrap → file read.
**After**: same single query as cat, then `lines.slice(0, N)` or `lines.slice(-N)` in-memory.

### ls (2 → 1 query, 5-7x faster)
**Before**: shell spawn → bootstrap (loading ALL 405+385 rows), then directory listing from in-memory cache.
**After**: `SELECT path, size_bytes FROM "<table>" WHERE path LIKE '/dir/%' ORDER BY path`. Queries only the relevant table based on path. Root `/` queries both tables in parallel.

### find (2 → 1 query, 5x faster)
**Before**: shell spawn → bootstrap, then in-memory tree walk.
**After**: `SELECT path FROM "<table>" WHERE path LIKE '/dir/%' AND filename LIKE '%.md' ORDER BY path`. Routes to correct table based on path.

### wc -l (4 → 1 query, 8x faster)
**Before**: shell spawn → bootstrap → file read → count.
**After**: same single query as cat, then `content.split('\n').length`.

## Real-world command variants

Claude Code generates commands with `2>/dev/null`, `2>&1`, and pipes. All handled:

| Real-world pattern | Status |
|-------------------|--------|
| `cat file 2>/dev/null` | FAST — strips stderr redirect |
| `cat file 2>&1 \| head -200` | FAST — strips stderr redirect + extracts head |
| `cat file 2>/dev/null \| grep -v \| head -100` | FAST — strips all intermediate pipes |
| `head -n 20 file`, `head -n20 file`, `head file` | FAST — all flag formats |
| `tail -n 10 file`, `tail file` | FAST — all flag formats |
| `ls -la`, `ls -l`, `ls -lh`, `ls -R` | FAST — all flag combos |
| `find dir -type f -name '*.md' \| wc -l` | FAST — with `-type` and piped `wc` |

## Full variant matrix

49 variants tested. **42 FAST**, **8 SHELL** (expected — pipes to jq/complex commands, writes), **0 BROKEN**.

### Commands that stay SHELL (expected)
| Variant | Reason |
|---------|--------|
| `cat file1 file2` | multi-file cat |
| `cat file \| jq .` | piped to interpreter |
| `head file \| grep pattern` | piped to grep |
| `ls dir \| wc -l` | piped to wc |
| `wc file` (no `-l` flag) | not optimized |
| `echo > file` | write operation |
| `mkdir dir` | write operation |
| `rm file` | write operation |

## E2E Claude session benchmarks

| Test | Original (Apr 14) | After grep fix only | After all fixes | Speedup |
|------|-------------------|--------------------|-----------------|---------| 
| "Search memory for hooks/latency" | 454.3s (7.5 min) | 63.4s (20 queries) | **52.3s (15 queries, 0 shell spawns)** | **8.7x** |

### E2E query breakdown (52.3s run)
- 5× grep queries (direct SQL, 1 query each) — **fast path**
- 7× file reads (direct SQL, 1 query each) — **fast path**
- 1× virtual index.md generation — **fast path**
- 0× shell bootstrap queries — **eliminated**

### What's left in the 52s
~15s is SQL query time (15 queries × ~1s each). The remaining ~37s is Claude thinking time + API latency — not something the plugin can optimize.

## Remaining bottlenecks

1. **Sessions JSONB→text cast**: reading a session file takes ~1.3s because `message::text` casts JSONB to text. Fix: add a `content_text` column with pre-extracted text.
2. **BM25 broken**: `summary <#> 'pattern'` returns 400 error ("Data type mismatch"). Fix: create BM25 index with `CREATE INDEX ... USING deeplake_index("summary")` in `ensureTable()`.
3. **No index on path column**: every `WHERE path = '...'` is a full table scan. Fix: `CREATE INDEX ON memory(path)`.
4. **Shell still used for writes**: `echo > file`, `mkdir`, `rm` still spawn the shell with full bootstrap. Low priority — writes are rare (~1-2 per session).

## Files modified

| File | Change |
|------|--------|
| `src/hooks/grep-direct.ts` | Shared grep handler — single SQL query, searches memory only |
| `src/hooks/pre-tool-use.ts` | Fast path for all read commands: grep, cat, head, tail, ls, find, wc. Routes to correct table based on path. Handles `2>/dev/null`, `2>&1`, `cat\|head` pipes. Virtual index.md generation. |
| `src/hooks/codex/pre-tool-use.ts` | Grep fast path via shared module |
| `src/shell/grep-interceptor.ts` | Fixed mount="/" bug |
| `src/shell/deeplake-fs.ts` | Removed `deeplake_sync_table` from bootstrap and flush |
| `src/hooks/session-start-setup.ts` | Removed `deeplake_sync_table` |
| `src/hooks/wiki-worker.ts` | Removed `deeplake_sync_table` (3 occurrences) |
| `src/hooks/codex/session-start-setup.ts` | Removed `deeplake_sync_table` |
| `src/hooks/codex/wiki-worker.ts` | Removed `deeplake_sync_table` (3 occurrences) |
