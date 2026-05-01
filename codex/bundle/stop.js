#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// dist/src/index-marker-store.js
var index_marker_store_exports = {};
__export(index_marker_store_exports, {
  buildIndexMarkerPath: () => buildIndexMarkerPath,
  getIndexMarkerDir: () => getIndexMarkerDir,
  hasFreshIndexMarker: () => hasFreshIndexMarker,
  writeIndexMarker: () => writeIndexMarker
});
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";
import { tmpdir } from "node:os";
function getIndexMarkerDir() {
  return process.env.HIVEMIND_INDEX_MARKER_DIR ?? join3(tmpdir(), "hivemind-deeplake-indexes");
}
function buildIndexMarkerPath(workspaceId, orgId, table, suffix) {
  const markerKey = [workspaceId, orgId, table, suffix].join("__").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join3(getIndexMarkerDir(), `${markerKey}.json`);
}
function hasFreshIndexMarker(markerPath) {
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
function writeIndexMarker(markerPath) {
  mkdirSync(getIndexMarkerDir(), { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ updatedAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf-8");
}
var INDEX_MARKER_TTL_MS;
var init_index_marker_store = __esm({
  "dist/src/index-marker-store.js"() {
    "use strict";
    INDEX_MARKER_TTL_MS = Number(process.env.HIVEMIND_INDEX_MARKER_TTL_MS ?? 6 * 60 * 6e4);
  }
});

// dist/src/hooks/codex/stop.js
import { readFileSync as readFileSync5, existsSync as existsSync5 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname2, join as join9 } from "node:path";

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
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
  const token = process.env.HIVEMIND_TOKEN ?? creds?.token;
  const orgId = process.env.HIVEMIND_ORG_ID ?? creds?.orgId;
  if (!token || !orgId)
    return null;
  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: process.env.HIVEMIND_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.HIVEMIND_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.HIVEMIND_TABLE ?? "memory",
    sessionsTableName: process.env.HIVEMIND_SESSIONS_TABLE ?? "sessions",
    memoryPath: process.env.HIVEMIND_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = process.env.HIVEMIND_DEBUG === "1";
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

// dist/src/embeddings/columns.js
var SUMMARY_EMBEDDING_COL = "summary_embedding";
var MESSAGE_EMBEDDING_COL = "message_embedding";

// dist/src/utils/client-header.js
var DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
function deeplakeClientValue() {
  return `hivemind/${"0.7.0"}`;
}
function deeplakeClientHeader() {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}

// dist/src/deeplake-api.js
var indexMarkerStorePromise = null;
function getIndexMarkerStore() {
  if (!indexMarkerStorePromise)
    indexMarkerStorePromise = Promise.resolve().then(() => (init_index_marker_store(), index_marker_store_exports));
  return indexMarkerStorePromise;
}
var log2 = (msg) => log("sdk", msg);
function summarizeSql(sql, maxLen = 220) {
  const compact = sql.replace(/\s+/g, " ").trim();
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}
function traceSql(msg) {
  const traceEnabled = process.env.HIVEMIND_TRACE_SQL === "1" || process.env.HIVEMIND_DEBUG === "1";
  if (!traceEnabled)
    return;
  process.stderr.write(`[deeplake-sql] ${msg}
`);
  if (process.env.HIVEMIND_DEBUG === "1")
    log2(msg);
}
var RETRYABLE_CODES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var MAX_RETRIES = 3;
var BASE_DELAY_MS = 500;
var MAX_CONCURRENCY = 5;
var QUERY_TIMEOUT_MS = Number(process.env.HIVEMIND_QUERY_TIMEOUT_MS ?? 1e4);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
function isSessionInsertQuery(sql) {
  return /^\s*insert\s+into\s+"[^"]+"\s*\(\s*id\s*,\s*path\s*,\s*filename\s*,\s*message\s*,/i.test(sql);
}
function isTransientHtml403(text) {
  const body = text.toLowerCase();
  return body.includes("<html") || body.includes("403 forbidden") || body.includes("cloudflare") || body.includes("nginx");
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
    await new Promise((resolve) => this.waiting.push(resolve));
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
            "X-Activeloop-Org-Id": this.orgId,
            ...deeplakeClientHeader()
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
      const retryable403 = isSessionInsertQuery(sql) && (resp.status === 401 || resp.status === 403 && (text.length === 0 || isTransientHtml403(text)));
      const alreadyExists = resp.status === 500 && isDuplicateIndexError(text);
      if (!alreadyExists && attempt < MAX_RETRIES && (RETRYABLE_CODES.has(resp.status) || retryable403)) {
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
      let setClauses = `summary = E'${sqlStr(row.contentText)}', ${SUMMARY_EMBEDDING_COL} = NULL, mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
      if (row.project !== void 0)
        setClauses += `, project = '${sqlStr(row.project)}'`;
      if (row.description !== void 0)
        setClauses += `, description = '${sqlStr(row.description)}'`;
      await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`);
    } else {
      const id = randomUUID();
      let cols = `id, path, filename, summary, ${SUMMARY_EMBEDDING_COL}, mime_type, size_bytes, creation_date, last_update_date`;
      let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'${sqlStr(row.contentText)}', NULL, '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
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
  async ensureLookupIndex(table, suffix, columnsSql) {
    const markers = await getIndexMarkerStore();
    const markerPath = markers.buildIndexMarkerPath(this.workspaceId, this.orgId, table, suffix);
    if (markers.hasFreshIndexMarker(markerPath))
      return;
    const indexName = this.buildLookupIndexName(table, suffix);
    try {
      await this.query(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" ${columnsSql}`);
      markers.writeIndexMarker(markerPath);
    } catch (e) {
      if (isDuplicateIndexError(e)) {
        markers.writeIndexMarker(markerPath);
        return;
      }
      log2(`index "${indexName}" skipped: ${e.message}`);
    }
  }
  /**
   * Ensure a vector column exists on the given table.
   *
   * The previous implementation always issued `ALTER TABLE ADD COLUMN IF NOT
   * EXISTS …` on every SessionStart. On a long-running workspace that's
   * already migrated, every call returns 500 "Column already exists" — noisy
   * in the log and a wasted round-trip. Worse, the very first call after the
   * column is genuinely added triggers Deeplake's post-ALTER `vector::at`
   * window (~30s) during which subsequent INSERTs fail; minimising the
   * number of ALTER calls minimises exposure to that window.
   *
   * New flow:
   *   1. Check the local marker file (mirrors ensureLookupIndex). If fresh,
   *      return — zero network calls.
   *   2. SELECT 1 FROM information_schema.columns WHERE table_name = T AND
   *      column_name = C. Read-only, idempotent, can't tickle the post-ALTER
   *      bug. If the column is present → mark + return.
   *   3. Only if step 2 says the column is missing, fall back to ALTER ADD
   *      COLUMN IF NOT EXISTS. Mark on success, also mark if Deeplake reports
   *      "already exists" (race: another client added it between our SELECT
   *      and ALTER).
   *
   * Marker uses the same dir / TTL as ensureLookupIndex so both schema
   * caches share an opt-out (HIVEMIND_INDEX_MARKER_DIR) and a TTL knob.
   */
  async ensureEmbeddingColumn(table, column) {
    const markers = await getIndexMarkerStore();
    const markerPath = markers.buildIndexMarkerPath(this.workspaceId, this.orgId, table, `col_${column}`);
    if (markers.hasFreshIndexMarker(markerPath))
      return;
    const colCheck = `SELECT 1 FROM information_schema.columns WHERE table_name = '${sqlStr(table)}' AND column_name = '${sqlStr(column)}' LIMIT 1`;
    const rows = await this.query(colCheck);
    if (rows.length > 0) {
      markers.writeIndexMarker(markerPath);
      return;
    }
    try {
      await this.query(`ALTER TABLE "${table}" ADD COLUMN ${column} FLOAT4[]`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg))
        throw e;
      const recheck = await this.query(colCheck);
      if (recheck.length === 0)
        throw e;
    }
    markers.writeIndexMarker(markerPath);
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
            "X-Activeloop-Org-Id": this.orgId,
            ...deeplakeClientHeader()
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
  /**
   * Run a `CREATE TABLE` with an extra outer retry budget. The base
   * `query()` already retries 3 times on fetch errors (~3.5s total), but a
   * failed CREATE is permanent corruption — every subsequent SELECT against
   * the missing table fails. Wrapping in an outer loop with longer backoff
   * (2s, 5s, then 10s) gives us ~17s of reach across transient network
   * blips before giving up. Failures still propagate; getApi() resets its
   * cache on init failure (openclaw plugin) so the next call retries the
   * whole init flow.
   */
  async createTableWithRetry(sql, label) {
    const OUTER_BACKOFFS_MS = [2e3, 5e3, 1e4];
    let lastErr = null;
    for (let attempt = 0; attempt <= OUTER_BACKOFFS_MS.length; attempt++) {
      try {
        await this.query(sql);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        log2(`CREATE TABLE "${label}" attempt ${attempt + 1}/${OUTER_BACKOFFS_MS.length + 1} failed: ${msg}`);
        if (attempt < OUTER_BACKOFFS_MS.length) {
          await sleep(OUTER_BACKOFFS_MS[attempt]);
        }
      }
    }
    throw lastErr;
  }
  /** Create the memory table if it doesn't already exist. Migrate columns on existing tables. */
  async ensureTable(name) {
    const tbl = name ?? this.tableName;
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log2(`table "${tbl}" not found, creating`);
      await this.createTableWithRetry(`CREATE TABLE IF NOT EXISTS "${tbl}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', summary_embedding FLOAT4[], author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'text/plain', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`, tbl);
      log2(`table "${tbl}" created`);
      if (!tables.includes(tbl))
        this._tablesCache = [...tables, tbl];
    }
    await this.ensureEmbeddingColumn(tbl, SUMMARY_EMBEDDING_COL);
  }
  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name) {
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      log2(`table "${name}" not found, creating`);
      await this.createTableWithRetry(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', message JSONB, message_embedding FLOAT4[], author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/json', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`, name);
      log2(`table "${name}" created`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    await this.ensureEmbeddingColumn(name, MESSAGE_EMBEDDING_COL);
    await this.ensureLookupIndex(name, "path_creation_date", `("path", "creation_date")`);
  }
};

// dist/src/hooks/codex/spawn-wiki-worker.js
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as join5 } from "node:path";
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync3 } from "node:fs";
import { homedir as homedir3, tmpdir as tmpdir2 } from "node:os";

// dist/src/utils/wiki-log.js
import { mkdirSync as mkdirSync2, appendFileSync as appendFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
function makeWikiLogger(hooksDir, filename = "deeplake-wiki.log") {
  const path = join4(hooksDir, filename);
  return {
    path,
    log(msg) {
      try {
        mkdirSync2(hooksDir, { recursive: true });
        appendFileSync2(path, `[${utcTimestamp()}] ${msg}
`);
      } catch {
      }
    }
  };
}

// dist/src/hooks/codex/spawn-wiki-worker.js
var HOME = homedir3();
var wikiLogger = makeWikiLogger(join5(HOME, ".codex", "hooks"));
var WIKI_LOG = wikiLogger.path;
var WIKI_PROMPT_TEMPLATE = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge \u2014 entities, decisions, relationships, and facts \u2014 into a structured, searchable wiki entry.

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

2. Write the summary file at the path above with this EXACT format:

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
<Every decision made and WHY.>

## Key Facts
<Bullet list of atomic facts that could answer future questions.>

## Files Modified
<bullet list: path (new/modified/deleted) \u2014 what changed>

## Open Questions / TODO
<Anything unresolved, blocked, or explicitly deferred>

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact.
PRIVACY: Never include absolute filesystem paths in the summary.
LENGTH LIMIT: Keep the total summary under 4000 characters.`;
var wikiLog = wikiLogger.log;
function findCodexBin() {
  try {
    return execSync("which codex 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return "codex";
  }
}
function spawnCodexWikiWorker(opts) {
  const { config, sessionId, cwd, bundleDir, reason } = opts;
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join5(tmpdir2(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync3(tmpDir, { recursive: true });
  const configFile = join5(tmpDir, "config.json");
  writeFileSync2(configFile, JSON.stringify({
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
    codexBin: findCodexBin(),
    wikiLog: WIKI_LOG,
    hooksDir: join5(HOME, ".codex", "hooks"),
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
  return dirname(fileURLToPath(importMetaUrl));
}

// dist/src/hooks/summary-state.js
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, writeSync, mkdirSync as mkdirSync4, renameSync, existsSync as existsSync3, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join6 } from "node:path";
var dlog = (msg) => log("summary-state", msg);
var STATE_DIR = join6(homedir4(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function lockPath(sessionId) {
  return join6(STATE_DIR, `${sessionId}.lock`);
}
function tryAcquireLock(sessionId, maxAgeMs = 10 * 60 * 1e3) {
  mkdirSync4(STATE_DIR, { recursive: true });
  const p = lockPath(sessionId);
  if (existsSync3(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync3(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs)
        return false;
    } catch (readErr) {
      dlog(`lock file unreadable for ${sessionId}, treating as stale: ${readErr.message}`);
    }
    try {
      unlinkSync(p);
    } catch (unlinkErr) {
      dlog(`could not unlink stale lock for ${sessionId}: ${unlinkErr.message}`);
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
function releaseLock(sessionId) {
  try {
    unlinkSync(lockPath(sessionId));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      dlog(`releaseLock unlink failed for ${sessionId}: ${e.message}`);
    }
  }
}

// dist/src/utils/session-path.js
function buildSessionPath(config, sessionId) {
  const workspace = config.workspaceId ?? "default";
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${workspace}_${sessionId}.jsonl`;
}

// dist/src/embeddings/client.js
import { connect } from "node:net";
import { spawn as spawn2 } from "node:child_process";
import { openSync as openSync2, closeSync as closeSync2, writeSync as writeSync2, unlinkSync as unlinkSync2, existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join7 } from "node:path";

// dist/src/embeddings/protocol.js
var DEFAULT_SOCKET_DIR = "/tmp";
var DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1e3;
var DEFAULT_CLIENT_TIMEOUT_MS = 2e3;
function socketPathFor(uid, dir = DEFAULT_SOCKET_DIR) {
  return `${dir}/hivemind-embed-${uid}.sock`;
}
function pidPathFor(uid, dir = DEFAULT_SOCKET_DIR) {
  return `${dir}/hivemind-embed-${uid}.pid`;
}

// dist/src/embeddings/client.js
var SHARED_DAEMON_PATH = join7(homedir5(), ".hivemind", "embed-deps", "embed-daemon.js");
var log3 = (m) => log("embed-client", m);
function getUid() {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid !== void 0 ? String(uid) : process.env.USER ?? "default";
}
var EmbedClient = class {
  socketPath;
  pidPath;
  timeoutMs;
  daemonEntry;
  autoSpawn;
  spawnWaitMs;
  nextId = 0;
  constructor(opts = {}) {
    const uid = getUid();
    const dir = opts.socketDir ?? "/tmp";
    this.socketPath = socketPathFor(uid, dir);
    this.pidPath = pidPathFor(uid, dir);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.daemonEntry = opts.daemonEntry ?? process.env.HIVEMIND_EMBED_DAEMON ?? (existsSync4(SHARED_DAEMON_PATH) ? SHARED_DAEMON_PATH : void 0);
    this.autoSpawn = opts.autoSpawn ?? true;
    this.spawnWaitMs = opts.spawnWaitMs ?? 5e3;
  }
  /**
   * Returns an embedding vector, or null on timeout/failure. Hooks MUST treat
   * null as "skip embedding column" — never block the write path on us.
   *
   * Fire-and-forget spawn on miss: if the daemon isn't up, this call returns
   * null AND kicks off a background spawn. The next call finds a ready daemon.
   */
  async embed(text, kind = "document") {
    let sock;
    try {
      sock = await this.connectOnce();
    } catch {
      if (this.autoSpawn)
        this.trySpawnDaemon();
      return null;
    }
    try {
      const id = String(++this.nextId);
      const req = { op: "embed", id, kind, text };
      const resp = await this.sendAndWait(sock, req);
      if (resp.error || !("embedding" in resp) || !resp.embedding) {
        log3(`embed err: ${resp.error ?? "no embedding"}`);
        return null;
      }
      return resp.embedding;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log3(`embed failed: ${err}`);
      return null;
    } finally {
      try {
        sock.end();
      } catch {
      }
    }
  }
  /**
   * Wait up to spawnWaitMs for the daemon to accept connections, spawning if
   * necessary. Meant for SessionStart / long-running batches — not the hot path.
   */
  async warmup() {
    try {
      const s = await this.connectOnce();
      s.end();
      return true;
    } catch {
      if (!this.autoSpawn)
        return false;
      this.trySpawnDaemon();
      try {
        const s = await this.waitForSocket();
        s.end();
        return true;
      } catch {
        return false;
      }
    }
  }
  connectOnce() {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("connect timeout"));
      }, this.timeoutMs);
      sock.once("connect", () => {
        clearTimeout(to);
        resolve(sock);
      });
      sock.once("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
    });
  }
  trySpawnDaemon() {
    let fd;
    try {
      fd = openSync2(this.pidPath, "wx", 384);
      writeSync2(fd, String(process.pid));
    } catch (e) {
      if (this.isPidFileStale()) {
        try {
          unlinkSync2(this.pidPath);
        } catch {
        }
        try {
          fd = openSync2(this.pidPath, "wx", 384);
          writeSync2(fd, String(process.pid));
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    if (!this.daemonEntry || !existsSync4(this.daemonEntry)) {
      log3(`daemonEntry not configured or missing: ${this.daemonEntry}`);
      try {
        closeSync2(fd);
        unlinkSync2(this.pidPath);
      } catch {
      }
      return;
    }
    try {
      const child = spawn2(process.execPath, [this.daemonEntry], {
        detached: true,
        stdio: "ignore",
        env: process.env
      });
      child.unref();
      log3(`spawned daemon pid=${child.pid}`);
    } finally {
      closeSync2(fd);
    }
  }
  isPidFileStale() {
    try {
      const raw = readFileSync4(this.pidPath, "utf-8").trim();
      const pid = Number(raw);
      if (!pid || Number.isNaN(pid))
        return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }
  async waitForSocket() {
    const deadline = Date.now() + this.spawnWaitMs;
    let delay = 30;
    while (Date.now() < deadline) {
      await sleep2(delay);
      delay = Math.min(delay * 1.5, 300);
      if (!existsSync4(this.socketPath))
        continue;
      try {
        return await this.connectOnce();
      } catch {
      }
    }
    throw new Error("daemon did not become ready within spawnWaitMs");
  }
  sendAndWait(sock, req) {
    return new Promise((resolve, reject) => {
      let buf = "";
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("request timeout"));
      }, this.timeoutMs);
      sock.setEncoding("utf-8");
      sock.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1)
          return;
        const line = buf.slice(0, nl);
        clearTimeout(to);
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      });
      sock.on("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
      sock.write(JSON.stringify(req) + "\n");
    });
  }
};
function sleep2(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// dist/src/embeddings/sql.js
function embeddingSqlLiteral(vec) {
  if (!vec || vec.length === 0)
    return "NULL";
  const parts = [];
  for (const v of vec) {
    if (!Number.isFinite(v))
      return "NULL";
    parts.push(String(v));
  }
  return `ARRAY[${parts.join(",")}]::float4[]`;
}

// dist/src/embeddings/disable.js
import { createRequire } from "node:module";
import { homedir as homedir6 } from "node:os";
import { join as join8 } from "node:path";
import { pathToFileURL } from "node:url";
var cachedStatus = null;
function defaultResolveTransformers() {
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    return;
  } catch {
  }
  const sharedDir = join8(homedir6(), ".hivemind", "embed-deps");
  createRequire(pathToFileURL(`${sharedDir}/`).href).resolve("@huggingface/transformers");
}
var _resolve = defaultResolveTransformers;
function detectStatus() {
  if (process.env.HIVEMIND_EMBEDDINGS === "false")
    return "env-disabled";
  try {
    _resolve();
    return "enabled";
  } catch {
    return "no-transformers";
  }
}
function embeddingsStatus() {
  if (cachedStatus !== null)
    return cachedStatus;
  cachedStatus = detectStatus();
  return cachedStatus;
}
function embeddingsDisabled() {
  return embeddingsStatus() !== "enabled";
}

// dist/src/hooks/codex/stop.js
var log4 = (msg) => log("codex-stop", msg);
function resolveEmbedDaemonPath() {
  return join9(dirname2(fileURLToPath2(import.meta.url)), "embeddings", "embed-daemon.js");
}
var CAPTURE = process.env.HIVEMIND_CAPTURE !== "false";
async function main() {
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  const input = await readStdin();
  const sessionId = input.session_id;
  if (!sessionId)
    return;
  const config = loadConfig();
  if (!config) {
    log4("no config");
    return;
  }
  if (CAPTURE) {
    try {
      const sessionsTable = config.sessionsTableName;
      const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, sessionsTable);
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      let lastAssistantMessage = "";
      if (input.transcript_path) {
        try {
          const transcriptPath = input.transcript_path;
          if (existsSync5(transcriptPath)) {
            const transcript = readFileSync5(transcriptPath, "utf-8");
            const lines = transcript.trim().split("\n").reverse();
            for (const line2 of lines) {
              try {
                const entry2 = JSON.parse(line2);
                const msg = entry2.payload ?? entry2;
                if (msg.role === "assistant" && msg.content) {
                  const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((b) => b.type === "output_text" || b.type === "text").map((b) => b.text).join("\n") : "";
                  if (content) {
                    lastAssistantMessage = content.slice(0, 4e3);
                    break;
                  }
                }
              } catch {
              }
            }
            if (lastAssistantMessage)
              log4(`extracted assistant message from transcript (${lastAssistantMessage.length} chars)`);
          }
        } catch (e) {
          log4(`transcript read failed: ${e.message}`);
        }
      }
      const entry = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        transcript_path: input.transcript_path,
        cwd: input.cwd,
        hook_event_name: input.hook_event_name,
        model: input.model,
        timestamp: ts,
        type: lastAssistantMessage ? "assistant_message" : "assistant_stop",
        content: lastAssistantMessage
      };
      const line = JSON.stringify(entry);
      const sessionPath = buildSessionPath(config, sessionId);
      const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
      const filename = sessionPath.split("/").pop() ?? "";
      const jsonForSql = line.replace(/'/g, "''");
      const embedding = embeddingsDisabled() ? null : await new EmbedClient({ daemonEntry: resolveEmbedDaemonPath() }).embed(line, "document");
      const embeddingSql = embeddingSqlLiteral(embedding);
      const insertSql = `INSERT INTO "${sessionsTable}" (id, path, filename, message, message_embedding, author, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, ${embeddingSql}, '${sqlStr(config.userName)}', ${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', 'Stop', 'codex', '${ts}', '${ts}')`;
      await api.query(insertSql);
      log4("stop event captured");
    } catch (e) {
      log4(`capture failed: ${e.message}`);
    }
  }
  if (!CAPTURE)
    return;
  if (!tryAcquireLock(sessionId)) {
    wikiLog(`Stop: periodic worker already running for ${sessionId}, skipping`);
    return;
  }
  wikiLog(`Stop: triggering summary for ${sessionId}`);
  try {
    spawnCodexWikiWorker({
      config,
      sessionId,
      cwd: input.cwd ?? "",
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "Stop"
    });
  } catch (e) {
    log4(`spawn failed: ${e.message}`);
    try {
      releaseLock(sessionId);
    } catch (releaseErr) {
      log4(`releaseLock after spawn failure also failed: ${releaseErr.message}`);
    }
    throw e;
  }
}
main().catch((e) => {
  log4(`fatal: ${e.message}`);
  process.exit(0);
});
