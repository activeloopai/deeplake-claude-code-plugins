#!/usr/bin/env node

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve2, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve2(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// dist/src/config.js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
function loadConfig() {
  const home = homedir();
  const credPath = join(home, ".deeplake", "credentials.json");
  let creds = null;
  if (existsSync(credPath)) {
    try {
      creds = JSON.parse(readFileSync(credPath, "utf-8"));
    } catch {
      return null;
    }
  }
  const env = process.env;
  if (!env.HIVEMIND_TOKEN && env.DEEPLAKE_TOKEN) {
    process.stderr.write("[hivemind] DEEPLAKE_* env vars are deprecated; use HIVEMIND_* instead\n");
  }
  const token = env.HIVEMIND_TOKEN ?? env.DEEPLAKE_TOKEN ?? creds?.token;
  const orgId = env.HIVEMIND_ORG_ID ?? env.DEEPLAKE_ORG_ID ?? creds?.orgId;
  if (!token || !orgId)
    return null;
  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: env.HIVEMIND_WORKSPACE_ID ?? env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: env.HIVEMIND_API_URL ?? env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: env.HIVEMIND_TABLE ?? env.DEEPLAKE_TABLE ?? "memory",
    sessionsTableName: env.HIVEMIND_SESSIONS_TABLE ?? env.DEEPLAKE_SESSIONS_TABLE ?? "sessions",
    memoryPath: env.HIVEMIND_MEMORY_PATH ?? env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";
import { tmpdir } from "node:os";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function utcTimestamp(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/utils/sql.js
function sqlStr(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\0/g, "").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function sqlIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

// dist/src/deeplake-api.js
var log2 = (msg) => log("sdk", msg);
var TRACE_SQL = (process.env.HIVEMIND_TRACE_SQL ?? process.env.DEEPLAKE_TRACE_SQL) === "1" || (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var DEBUG_FILE_LOG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
function summarizeSql(sql, maxLen = 220) {
  const compact = sql.replace(/\s+/g, " ").trim();
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}
function traceSql(msg) {
  if (!TRACE_SQL)
    return;
  process.stderr.write(`[deeplake-sql] ${msg}
`);
  if (DEBUG_FILE_LOG)
    log2(msg);
}
var RETRYABLE_CODES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var MAX_RETRIES = 3;
var BASE_DELAY_MS = 500;
var MAX_CONCURRENCY = 5;
var QUERY_TIMEOUT_MS = Number(process.env["HIVEMIND_QUERY_TIMEOUT_MS"] ?? process.env["DEEPLAKE_QUERY_TIMEOUT_MS"] ?? 1e4);
var INDEX_MARKER_TTL_MS = Number(process.env["HIVEMIND_INDEX_MARKER_TTL_MS"] ?? 6 * 60 * 6e4);
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function isTimeoutError(error) {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return name.includes("timeout") || name === "aborterror" || message.includes("timeout") || message.includes("timed out");
}
function isDuplicateIndexError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("duplicate key value violates unique constraint") || message.includes("pg_class_relname_nsp_index") || message.includes("already exists");
}
function getIndexMarkerDir() {
  return process.env["HIVEMIND_INDEX_MARKER_DIR"] ?? join3(tmpdir(), "hivemind-deeplake-indexes");
}
var Semaphore = class {
  max;
  waiting = [];
  active = 0;
  constructor(max) {
    this.max = max;
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve2) => this.waiting.push(resolve2));
  }
  release() {
    this.active--;
    const next = this.waiting.shift();
    if (next) {
      this.active++;
      next();
    }
  }
};
var DeeplakeApi = class {
  token;
  apiUrl;
  orgId;
  workspaceId;
  tableName;
  _pendingRows = [];
  _sem = new Semaphore(MAX_CONCURRENCY);
  _tablesCache = null;
  constructor(token, apiUrl, orgId, workspaceId, tableName) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.orgId = orgId;
    this.workspaceId = workspaceId;
    this.tableName = tableName;
  }
  /** Execute SQL with retry on transient errors and bounded concurrency. */
  async query(sql) {
    const startedAt = Date.now();
    const summary = summarizeSql(sql);
    traceSql(`query start: ${summary}`);
    await this._sem.acquire();
    try {
      const rows = await this._queryWithRetry(sql);
      traceSql(`query ok (${Date.now() - startedAt}ms, rows=${rows.length}): ${summary}`);
      return rows;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      traceSql(`query fail (${Date.now() - startedAt}ms): ${summary} :: ${message}`);
      throw e;
    } finally {
      this._sem.release();
    }
  }
  async _queryWithRetry(sql) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let resp;
      try {
        const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
        resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-Activeloop-Org-Id": this.orgId
          },
          signal,
          body: JSON.stringify({ query: sql })
        });
      } catch (e) {
        if (isTimeoutError(e)) {
          lastError = new Error(`Query timeout after ${QUERY_TIMEOUT_MS}ms`);
          throw lastError;
        }
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
          log2(`query retry ${attempt + 1}/${MAX_RETRIES} (fetch error: ${lastError.message}) in ${delay.toFixed(0)}ms`);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
      if (resp.ok) {
        const raw = await resp.json();
        if (!raw?.rows || !raw?.columns)
          return [];
        return raw.rows.map((row) => Object.fromEntries(raw.columns.map((col, i) => [col, row[i]])));
      }
      const text = await resp.text().catch(() => "");
      if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(resp.status)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
        log2(`query retry ${attempt + 1}/${MAX_RETRIES} (${resp.status}) in ${delay.toFixed(0)}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Query failed: ${resp.status}: ${text.slice(0, 200)}`);
    }
    throw lastError ?? new Error("Query failed: max retries exceeded");
  }
  // ── Writes ──────────────────────────────────────────────────────────────────
  /** Queue rows for writing. Call commit() to flush. */
  appendRows(rows) {
    this._pendingRows.push(...rows);
  }
  /** Flush pending rows via SQL. */
  async commit() {
    if (this._pendingRows.length === 0)
      return;
    const rows = this._pendingRows;
    this._pendingRows = [];
    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map((r) => this.upsertRowSql(r)));
    }
    log2(`commit: ${rows.length} rows`);
  }
  async upsertRowSql(row) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const cd = row.creationDate ?? ts;
    const lud = row.lastUpdateDate ?? ts;
    const exists = await this.query(`SELECT path FROM "${this.tableName}" WHERE path = '${sqlStr(row.path)}' LIMIT 1`);
    if (exists.length > 0) {
      let setClauses = `summary = E'${sqlStr(row.contentText)}', mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
      if (row.project !== void 0)
        setClauses += `, project = '${sqlStr(row.project)}'`;
      if (row.description !== void 0)
        setClauses += `, description = '${sqlStr(row.description)}'`;
      await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`);
    } else {
      const id = randomUUID();
      let cols = "id, path, filename, summary, mime_type, size_bytes, creation_date, last_update_date";
      let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
      if (row.project !== void 0) {
        cols += ", project";
        vals += `, '${sqlStr(row.project)}'`;
      }
      if (row.description !== void 0) {
        cols += ", description";
        vals += `, '${sqlStr(row.description)}'`;
      }
      await this.query(`INSERT INTO "${this.tableName}" (${cols}) VALUES (${vals})`);
    }
  }
  /** Update specific columns on a row by path. */
  async updateColumns(path, columns) {
    const setClauses = Object.entries(columns).map(([col, val]) => typeof val === "number" ? `${col} = ${val}` : `${col} = '${sqlStr(String(val))}'`).join(", ");
    await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(path)}'`);
  }
  // ── Convenience ─────────────────────────────────────────────────────────────
  /** Create a BM25 search index on a column. */
  async createIndex(column) {
    await this.query(`CREATE INDEX IF NOT EXISTS idx_${sqlStr(column)}_bm25 ON "${this.tableName}" USING deeplake_index ("${column}")`);
  }
  buildLookupIndexName(table, suffix) {
    return `idx_${table}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_");
  }
  getLookupIndexMarkerPath(table, suffix) {
    const markerKey = [
      this.workspaceId,
      this.orgId,
      table,
      suffix
    ].join("__").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join3(getIndexMarkerDir(), `${markerKey}.json`);
  }
  hasFreshLookupIndexMarker(table, suffix) {
    const markerPath = this.getLookupIndexMarkerPath(table, suffix);
    if (!existsSync2(markerPath))
      return false;
    try {
      const raw = JSON.parse(readFileSync2(markerPath, "utf-8"));
      const updatedAt = raw.updatedAt ? new Date(raw.updatedAt).getTime() : NaN;
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > INDEX_MARKER_TTL_MS)
        return false;
      return true;
    } catch {
      return false;
    }
  }
  markLookupIndexReady(table, suffix) {
    mkdirSync(getIndexMarkerDir(), { recursive: true });
    writeFileSync(this.getLookupIndexMarkerPath(table, suffix), JSON.stringify({ updatedAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf-8");
  }
  async ensureLookupIndex(table, suffix, columnsSql) {
    if (this.hasFreshLookupIndexMarker(table, suffix))
      return;
    const indexName = this.buildLookupIndexName(table, suffix);
    try {
      await this.query(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" ${columnsSql}`);
      this.markLookupIndexReady(table, suffix);
    } catch (e) {
      if (isDuplicateIndexError(e)) {
        this.markLookupIndexReady(table, suffix);
        return;
      }
      log2(`index "${indexName}" skipped: ${e.message}`);
    }
  }
  /** List all tables in the workspace (with retry). */
  async listTables(forceRefresh = false) {
    if (!forceRefresh && this._tablesCache)
      return [...this._tablesCache];
    const { tables, cacheable } = await this._fetchTables();
    if (cacheable)
      this._tablesCache = [...tables];
    return tables;
  }
  async _fetchTables() {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "X-Activeloop-Org-Id": this.orgId
          }
        });
        if (resp.ok) {
          const data = await resp.json();
          return {
            tables: (data.tables ?? []).map((t) => t.table_name),
            cacheable: true
          };
        }
        if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(resp.status)) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
        return { tables: [], cacheable: false };
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return { tables: [], cacheable: false };
      }
    }
    return { tables: [], cacheable: false };
  }
  /** Create the memory table if it doesn't already exist. Migrate columns on existing tables. */
  async ensureTable(name) {
    const tbl = name ?? this.tableName;
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log2(`table "${tbl}" not found, creating`);
      await this.query(`CREATE TABLE IF NOT EXISTS "${tbl}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'text/plain', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`);
      log2(`table "${tbl}" created`);
      if (!tables.includes(tbl))
        this._tablesCache = [...tables, tbl];
    }
  }
  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name) {
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      log2(`table "${name}" not found, creating`);
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', message JSONB, author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/json', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`);
      log2(`table "${name}" created`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    await this.ensureLookupIndex(name, "path_creation_date", `("path", "creation_date")`);
  }
};

// dist/src/utils/direct-run.js
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry)
    return false;
  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(entry);
  } catch {
    return false;
  }
}

// dist/src/hooks/summary-state.js
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, writeSync, mkdirSync as mkdirSync2, renameSync, existsSync as existsSync3, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
var STATE_DIR = join4(homedir3(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function statePath(sessionId) {
  return join4(STATE_DIR, `${sessionId}.json`);
}
function lockPath(sessionId) {
  return join4(STATE_DIR, `${sessionId}.lock`);
}
function readState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync3(p))
    return null;
  try {
    return JSON.parse(readFileSync3(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(sessionId, state) {
  mkdirSync2(STATE_DIR, { recursive: true });
  const p = statePath(sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync2(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}
function withRmwLock(sessionId, fn) {
  mkdirSync2(STATE_DIR, { recursive: true });
  const rmwLock = statePath(sessionId) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(rmwLock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        try {
          unlinkSync(rmwLock);
        } catch {
        }
        continue;
      }
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(rmwLock);
    } catch {
    }
  }
}
function bumpTotalCount(sessionId) {
  return withRmwLock(sessionId, () => {
    const now = Date.now();
    const existing = readState(sessionId);
    const next = existing ? { ...existing, totalCount: existing.totalCount + 1 } : { lastSummaryAt: now, lastSummaryCount: 0, totalCount: 1 };
    writeState(sessionId, next);
    return next;
  });
}
function loadTriggerConfig() {
  const n = Number(process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS ?? "");
  const h = Number(process.env.HIVEMIND_SUMMARY_EVERY_HOURS ?? "");
  return {
    everyNMessages: Number.isInteger(n) && n > 0 ? n : 50,
    everyHours: Number.isFinite(h) && h > 0 ? h : 2
  };
}
var FIRST_SUMMARY_AT = 10;
function shouldTrigger(state, cfg, now = Date.now()) {
  const msgsSince = state.totalCount - state.lastSummaryCount;
  if (state.lastSummaryCount === 0 && state.totalCount >= FIRST_SUMMARY_AT)
    return true;
  if (msgsSince >= cfg.everyNMessages)
    return true;
  if (msgsSince > 0 && now - state.lastSummaryAt >= cfg.everyHours * 3600 * 1e3)
    return true;
  return false;
}
function tryAcquireLock(sessionId, maxAgeMs = 10 * 60 * 1e3) {
  mkdirSync2(STATE_DIR, { recursive: true });
  const p = lockPath(sessionId);
  if (existsSync3(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync3(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs)
        return false;
    } catch {
    }
    try {
      unlinkSync(p);
    } catch {
      return false;
    }
  }
  try {
    const fd = openSync(p, "wx");
    try {
      writeSync(fd, String(Date.now()));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e.code === "EEXIST")
      return false;
    throw e;
  }
}

// dist/src/hooks/spawn-wiki-worker.js
import { spawn, execSync } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname, join as join5 } from "node:path";
import { writeFileSync as writeFileSync3, mkdirSync as mkdirSync3, appendFileSync as appendFileSync2 } from "node:fs";
import { homedir as homedir4, tmpdir as tmpdir2 } from "node:os";
var HOME = homedir4();
var WIKI_LOG = join5(HOME, ".claude", "hooks", "deeplake-wiki.log");
var WIKI_PROMPT_TEMPLATE = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge \u2014 entities, decisions, relationships, and facts \u2014 into a structured, searchable wiki entry. Think of this as building a knowledge graph, not writing a summary.

SESSION JSONL path: __JSONL__
SUMMARY FILE to write: __SUMMARY__
SESSION ID: __SESSION_ID__
PROJECT: __PROJECT__
PREVIOUS JSONL OFFSET (lines already processed): __PREV_OFFSET__
CURRENT JSONL LINES: __JSONL_LINES__

Steps:
1. Read the session JSONL at the path above.
   - If PREVIOUS JSONL OFFSET > 0, this is a resumed session. Read the existing summary file first,
     then focus on lines AFTER the offset for new content. Merge new facts into the existing summary.
   - If offset is 0, generate from scratch.

2. Write the summary file at the path above with this EXACT format. The header fields (Source, Project) are pre-filled \u2014 copy them VERBATIM, do NOT replace them with paths from the JSONL content:

# Session __SESSION_ID__
- **Source**: __JSONL_SERVER_PATH__
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__
- **JSONL offset**: __JSONL_LINES__

## What Happened
<2-3 dense sentences. What was the goal, what was accomplished, what's left.>

## People
<For each person mentioned: name, role, what they did/said. Format: **Name** \u2014 role \u2014 action>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs.
Format: **entity** (type) \u2014 what was done with it, its current state>

## Decisions & Reasoning
<Every decision made and WHY. Not just "did X" but "did X because Y, considered Z but rejected it because W">

## Key Facts
<Bullet list of atomic facts that could answer future questions. Each fact should stand alone.
Example: "- The memory table uses DELETE+INSERT, not UPDATE (WASM doesn't support upsert)">

## Files Modified
<bullet list: path (new/modified/deleted) \u2014 what changed>

## Open Questions / TODO
<Anything unresolved, blocked, or explicitly deferred>

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact. Future you will search this wiki to answer questions like "who worked on X", "why did we choose Y", "what's the status of Z". If a detail exists in the session, it should be in the wiki.

PRIVACY: Never include absolute filesystem paths (e.g. /home/user/..., /Users/..., C:\\\\...) in the summary. Use only project-relative paths or the project name. The Source and Project fields above are already correct \u2014 do not change them.

LENGTH LIMIT: Keep the total summary under 4000 characters. Be dense and concise \u2014 prioritize facts over prose. If a session is short, the summary should be short too.`;
function wikiLog(msg) {
  try {
    mkdirSync3(join5(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync2(WIKI_LOG, `[${utcTimestamp()}] ${msg}
`);
  } catch {
  }
}
function findClaudeBin() {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join5(HOME, ".claude", "local", "claude");
  }
}
function spawnWikiWorker(opts) {
  const { config, sessionId, cwd, bundleDir, reason } = opts;
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join5(tmpdir2(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync3(tmpDir, { recursive: true });
  const configFile = join5(tmpDir, "config.json");
  writeFileSync3(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    memoryTable: config.tableName,
    sessionsTable: config.sessionsTableName,
    sessionId,
    userName: config.userName,
    project: projectName,
    tmpDir,
    claudeBin: findClaudeBin(),
    wikiLog: WIKI_LOG,
    hooksDir: join5(HOME, ".claude", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE
  }));
  wikiLog(`${reason}: spawning summary worker for ${sessionId}`);
  const workerPath = join5(bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`${reason}: spawned summary worker for ${sessionId}`);
}
function bundleDirFromImportMeta(importMetaUrl) {
  return dirname(fileURLToPath2(importMetaUrl));
}

// dist/src/hooks/session-queue.js
import { appendFileSync as appendFileSync3, existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync4, readdirSync, renameSync as renameSync2, rmSync, statSync, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";
import { homedir as homedir5 } from "node:os";
var DEFAULT_QUEUE_DIR = join6(homedir5(), ".deeplake", "queue");
var DEFAULT_MAX_BATCH_ROWS = 50;
var DEFAULT_STALE_INFLIGHT_MS = 6e4;
var DEFAULT_AUTH_FAILURE_TTL_MS = 5 * 6e4;
var BUSY_WAIT_STEP_MS = 100;
var SessionWriteDisabledError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionWriteDisabledError";
  }
};
function buildSessionPath(config, sessionId) {
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${config.workspaceId}_${sessionId}.jsonl`;
}
function buildQueuedSessionRow(args) {
  return {
    id: crypto.randomUUID(),
    path: args.sessionPath,
    filename: args.sessionPath.split("/").pop() ?? "",
    message: args.line,
    author: args.userName,
    sizeBytes: Buffer.byteLength(args.line, "utf-8"),
    project: args.projectName,
    description: args.description,
    agent: args.agent,
    creationDate: args.timestamp,
    lastUpdateDate: args.timestamp
  };
}
function appendQueuedSessionRow(row, queueDir = DEFAULT_QUEUE_DIR) {
  mkdirSync4(queueDir, { recursive: true });
  const sessionId = extractSessionId(row.path);
  const queuePath = getQueuePath(queueDir, sessionId);
  appendFileSync3(queuePath, `${JSON.stringify(row)}
`);
  return queuePath;
}
function buildSessionInsertSql(sessionsTable, rows) {
  if (rows.length === 0)
    throw new Error("buildSessionInsertSql: rows must not be empty");
  const table = sqlIdent(sessionsTable);
  const values = rows.map((row) => {
    const jsonForSql = sqlStr(coerceJsonbPayload(row.message));
    return `('${sqlStr(row.id)}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', '${jsonForSql}'::jsonb, '${sqlStr(row.author)}', ${row.sizeBytes}, '${sqlStr(row.project)}', '${sqlStr(row.description)}', '${sqlStr(row.agent)}', '${sqlStr(row.creationDate)}', '${sqlStr(row.lastUpdateDate)}')`;
  }).join(", ");
  return `INSERT INTO "${table}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${values}`;
}
function coerceJsonbPayload(message) {
  try {
    return JSON.stringify(JSON.parse(message));
  } catch {
    return JSON.stringify({
      type: "raw_message",
      content: message
    });
  }
}
async function flushSessionQueue(api, opts) {
  const queueDir = opts.queueDir ?? DEFAULT_QUEUE_DIR;
  const maxBatchRows = opts.maxBatchRows ?? DEFAULT_MAX_BATCH_ROWS;
  const staleInflightMs = opts.staleInflightMs ?? DEFAULT_STALE_INFLIGHT_MS;
  const waitIfBusyMs = opts.waitIfBusyMs ?? 0;
  const drainAll = opts.drainAll ?? false;
  mkdirSync4(queueDir, { recursive: true });
  const queuePath = getQueuePath(queueDir, opts.sessionId);
  const inflightPath = getInflightPath(queueDir, opts.sessionId);
  if (isSessionWriteDisabled(opts.sessionsTable, queueDir)) {
    return existsSync4(queuePath) || existsSync4(inflightPath) ? { status: "disabled", rows: 0, batches: 0 } : { status: "empty", rows: 0, batches: 0 };
  }
  let totalRows = 0;
  let totalBatches = 0;
  let flushedAny = false;
  while (true) {
    if (opts.allowStaleInflight)
      recoverStaleInflight(queuePath, inflightPath, staleInflightMs);
    if (existsSync4(inflightPath)) {
      if (waitIfBusyMs > 0) {
        await waitForInflightToClear(inflightPath, waitIfBusyMs);
        if (opts.allowStaleInflight)
          recoverStaleInflight(queuePath, inflightPath, staleInflightMs);
      }
      if (existsSync4(inflightPath)) {
        return flushedAny ? { status: "flushed", rows: totalRows, batches: totalBatches } : { status: "busy", rows: 0, batches: 0 };
      }
    }
    if (!existsSync4(queuePath)) {
      return flushedAny ? { status: "flushed", rows: totalRows, batches: totalBatches } : { status: "empty", rows: 0, batches: 0 };
    }
    try {
      renameSync2(queuePath, inflightPath);
    } catch (e) {
      if (e?.code === "ENOENT") {
        return flushedAny ? { status: "flushed", rows: totalRows, batches: totalBatches } : { status: "empty", rows: 0, batches: 0 };
      }
      throw e;
    }
    try {
      const { rows, batches } = await flushInflightFile(api, opts.sessionsTable, inflightPath, maxBatchRows);
      totalRows += rows;
      totalBatches += batches;
      flushedAny = flushedAny || rows > 0;
    } catch (e) {
      requeueInflight(queuePath, inflightPath);
      if (e instanceof SessionWriteDisabledError) {
        return { status: "disabled", rows: totalRows, batches: totalBatches };
      }
      throw e;
    }
    if (!drainAll) {
      return { status: "flushed", rows: totalRows, batches: totalBatches };
    }
  }
}
function getQueuePath(queueDir, sessionId) {
  return join6(queueDir, `${sessionId}.jsonl`);
}
function getInflightPath(queueDir, sessionId) {
  return join6(queueDir, `${sessionId}.inflight`);
}
function extractSessionId(sessionPath) {
  const filename = sessionPath.split("/").pop() ?? "";
  return filename.replace(/\.jsonl$/, "").split("_").pop() ?? filename;
}
async function flushInflightFile(api, sessionsTable, inflightPath, maxBatchRows) {
  const rows = readQueuedRows(inflightPath);
  if (rows.length === 0) {
    rmSync(inflightPath, { force: true });
    return { rows: 0, batches: 0 };
  }
  let ensured = false;
  let batches = 0;
  const queueDir = dirname2(inflightPath);
  for (let i = 0; i < rows.length; i += maxBatchRows) {
    const chunk = rows.slice(i, i + maxBatchRows);
    const sql = buildSessionInsertSql(sessionsTable, chunk);
    try {
      await api.query(sql);
    } catch (e) {
      if (isSessionWriteAuthError(e)) {
        markSessionWriteDisabled(sessionsTable, errorMessage(e), queueDir);
        throw new SessionWriteDisabledError(errorMessage(e));
      }
      if (!ensured && isEnsureSessionsTableRetryable(e)) {
        try {
          await api.ensureSessionsTable(sessionsTable);
        } catch (ensureError) {
          if (isSessionWriteAuthError(ensureError)) {
            markSessionWriteDisabled(sessionsTable, errorMessage(ensureError), queueDir);
            throw new SessionWriteDisabledError(errorMessage(ensureError));
          }
          throw ensureError;
        }
        ensured = true;
        try {
          await api.query(sql);
        } catch (retryError) {
          if (isSessionWriteAuthError(retryError)) {
            markSessionWriteDisabled(sessionsTable, errorMessage(retryError), queueDir);
            throw new SessionWriteDisabledError(errorMessage(retryError));
          }
          throw retryError;
        }
      } else {
        throw e;
      }
    }
    batches += 1;
  }
  clearSessionWriteDisabled(sessionsTable, queueDir);
  rmSync(inflightPath, { force: true });
  return { rows: rows.length, batches };
}
function readQueuedRows(path) {
  const raw = readFileSync4(path, "utf-8");
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
function requeueInflight(queuePath, inflightPath) {
  if (!existsSync4(inflightPath))
    return;
  const inflight = readFileSync4(inflightPath, "utf-8");
  appendFileSync3(queuePath, inflight);
  rmSync(inflightPath, { force: true });
}
function recoverStaleInflight(queuePath, inflightPath, staleInflightMs) {
  if (!existsSync4(inflightPath) || !isStale(inflightPath, staleInflightMs))
    return;
  requeueInflight(queuePath, inflightPath);
}
function isStale(path, staleInflightMs) {
  return Date.now() - statSync(path).mtimeMs >= staleInflightMs;
}
function isEnsureSessionsTableRetryable(error) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("does not exist") || message.includes("doesn't exist") || message.includes("relation") || message.includes("not found");
}
function isSessionWriteAuthError(error) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("403") || message.includes("401") || message.includes("forbidden") || message.includes("unauthorized");
}
function markSessionWriteDisabled(sessionsTable, reason, queueDir = DEFAULT_QUEUE_DIR) {
  mkdirSync4(queueDir, { recursive: true });
  writeFileSync4(getSessionWriteDisabledPath(queueDir, sessionsTable), JSON.stringify({
    disabledAt: (/* @__PURE__ */ new Date()).toISOString(),
    reason,
    sessionsTable
  }));
}
function clearSessionWriteDisabled(sessionsTable, queueDir = DEFAULT_QUEUE_DIR) {
  rmSync(getSessionWriteDisabledPath(queueDir, sessionsTable), { force: true });
}
function isSessionWriteDisabled(sessionsTable, queueDir = DEFAULT_QUEUE_DIR, ttlMs = DEFAULT_AUTH_FAILURE_TTL_MS) {
  const path = getSessionWriteDisabledPath(queueDir, sessionsTable);
  if (!existsSync4(path))
    return false;
  try {
    const raw = readFileSync4(path, "utf-8");
    const state = JSON.parse(raw);
    const ageMs = Date.now() - new Date(state.disabledAt).getTime();
    if (Number.isNaN(ageMs) || ageMs >= ttlMs) {
      rmSync(path, { force: true });
      return false;
    }
    return true;
  } catch {
    rmSync(path, { force: true });
    return false;
  }
}
function getSessionWriteDisabledPath(queueDir, sessionsTable) {
  return join6(queueDir, `.${sessionsTable}.disabled.json`);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function waitForInflightToClear(inflightPath, waitIfBusyMs) {
  const startedAt = Date.now();
  while (existsSync4(inflightPath) && Date.now() - startedAt < waitIfBusyMs) {
    await sleep2(BUSY_WAIT_STEP_MS);
  }
}
function sleep2(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// dist/src/hooks/query-cache.js
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, rmSync as rmSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join7 } from "node:path";
import { homedir as homedir6 } from "node:os";
var log3 = (msg) => log("query-cache", msg);
var DEFAULT_CACHE_ROOT = join7(homedir6(), ".deeplake", "query-cache");
function getSessionQueryCacheDir(sessionId, deps = {}) {
  const { cacheRoot = DEFAULT_CACHE_ROOT } = deps;
  return join7(cacheRoot, sessionId);
}
function clearSessionQueryCache(sessionId, deps = {}) {
  const { logFn = log3 } = deps;
  try {
    rmSync2(getSessionQueryCacheDir(sessionId, deps), { recursive: true, force: true });
  } catch (e) {
    logFn(`clear failed for session=${sessionId}: ${e.message}`);
  }
}

// dist/src/hooks/capture.js
var log4 = (msg) => log("capture", msg);
var CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";
function buildCaptureEntry(input, timestamp) {
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    hook_event_name: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    timestamp
  };
  if (input.prompt !== void 0) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt
    };
  }
  if (input.tool_name !== void 0) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response)
    };
  }
  if (input.last_assistant_message !== void 0) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "assistant_message",
      content: input.last_assistant_message,
      ...input.agent_transcript_path ? { agent_transcript_path: input.agent_transcript_path } : {}
    };
  }
  return null;
}
function maybeTriggerPeriodicSummary(sessionId, cwd, config, deps = {}) {
  const { bundleDir = bundleDirFromImportMeta(import.meta.url), wikiWorker = process.env.HIVEMIND_WIKI_WORKER === "1", logFn = log4, bumpTotalCountFn = bumpTotalCount, loadTriggerConfigFn = loadTriggerConfig, shouldTriggerFn = shouldTrigger, tryAcquireLockFn = tryAcquireLock, wikiLogFn = wikiLog, spawnWikiWorkerFn = spawnWikiWorker } = deps;
  if (wikiWorker)
    return;
  try {
    const state = bumpTotalCountFn(sessionId);
    const cfg = loadTriggerConfigFn();
    if (!shouldTriggerFn(state, cfg))
      return;
    if (!tryAcquireLockFn(sessionId)) {
      logFn(`periodic trigger suppressed (lock held) session=${sessionId}`);
      return;
    }
    wikiLogFn(`Periodic: threshold hit (total=${state.totalCount}, since=${state.totalCount - state.lastSummaryCount}, N=${cfg.everyNMessages}, hours=${cfg.everyHours})`);
    spawnWikiWorkerFn({
      config,
      sessionId,
      cwd,
      bundleDir,
      reason: "Periodic"
    });
  } catch (e) {
    logFn(`periodic trigger error: ${e.message}`);
  }
}
async function runCaptureHook(input, deps = {}) {
  const { captureEnabled = CAPTURE, config = loadConfig(), now = () => (/* @__PURE__ */ new Date()).toISOString(), createApi = (activeConfig) => new DeeplakeApi(activeConfig.token, activeConfig.apiUrl, activeConfig.orgId, activeConfig.workspaceId, activeConfig.sessionsTableName), appendQueuedSessionRowFn = appendQueuedSessionRow, buildQueuedSessionRowFn = buildQueuedSessionRow, flushSessionQueueFn = flushSessionQueue, clearSessionQueryCacheFn = clearSessionQueryCache, maybeTriggerPeriodicSummaryFn = maybeTriggerPeriodicSummary, logFn = log4 } = deps;
  if (!captureEnabled)
    return { status: "disabled" };
  if (!config) {
    logFn("no config");
    return { status: "no_config" };
  }
  const ts = now();
  const entry = buildCaptureEntry(input, ts);
  if (!entry) {
    logFn("unknown event, skipping");
    return { status: "ignored" };
  }
  if (input.prompt !== void 0)
    logFn(`user session=${input.session_id}`);
  else if (input.tool_name !== void 0)
    logFn(`tool=${input.tool_name} session=${input.session_id}`);
  else
    logFn(`assistant session=${input.session_id}`);
  if (input.hook_event_name === "UserPromptSubmit") {
    clearSessionQueryCacheFn(input.session_id);
  }
  const sessionPath = buildSessionPath(config, input.session_id);
  const line = JSON.stringify(entry);
  const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
  appendQueuedSessionRowFn(buildQueuedSessionRowFn({
    sessionPath,
    line,
    userName: config.userName,
    projectName,
    description: input.hook_event_name ?? "",
    agent: "claude_code",
    timestamp: ts
  }));
  logFn(`queued ${input.hook_event_name ?? "event"} for ${sessionPath}`);
  maybeTriggerPeriodicSummaryFn(input.session_id, input.cwd ?? "", config);
  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    const result = await flushSessionQueueFn(createApi(config), {
      sessionId: input.session_id,
      sessionsTable: config.sessionsTableName,
      drainAll: true
    });
    logFn(`flush ${result.status}: rows=${result.rows} batches=${result.batches}`);
    return { status: "queued", entry, flushStatus: result.status };
  }
  return { status: "queued", entry };
}
async function main() {
  const input = await readStdin();
  await runCaptureHook(input);
}
if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    log4(`fatal: ${e.message}`);
    process.exit(0);
  });
}
export {
  buildCaptureEntry,
  maybeTriggerPeriodicSummary,
  runCaptureHook
};
