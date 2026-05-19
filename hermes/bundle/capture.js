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
    skillsTableName: process.env.HIVEMIND_SKILLS_TABLE ?? "skills",
    memoryPath: process.env.HIVEMIND_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function isDebug() {
  return process.env.HIVEMIND_DEBUG === "1";
}
function utcTimestamp(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function log(tag, msg) {
  if (!isDebug())
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

// dist/src/embeddings/columns.js
var SUMMARY_EMBEDDING_COL = "summary_embedding";
var MESSAGE_EMBEDDING_COL = "message_embedding";

// dist/src/utils/client-header.js
var DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
function deeplakeClientValue() {
  return "hivemind";
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
function getQueryTimeoutMs() {
  return Number(process.env.HIVEMIND_QUERY_TIMEOUT_MS ?? 1e4);
}
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
      const timeoutMs = getQueryTimeoutMs();
      try {
        const signal = AbortSignal.timeout(timeoutMs);
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
          lastError = new Error(`Query timeout after ${timeoutMs}ms`);
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
    await this.ensureColumn(table, column, "FLOAT4[]");
  }
  /**
   * Generic marker-gated column migration. Same SELECT-then-ALTER flow as
   * ensureEmbeddingColumn, parameterized by SQL type so it can patch up any
   * column that was added to the schema after the table was originally
   * created. Used today for `summary_embedding`, `message_embedding`, and
   * the `agent` column (added 2026-04-11) — the latter has no fallback if
   * a user upgraded over a pre-2026-04-11 table, so every INSERT fails
   * with `column "agent" does not exist`.
   */
  async ensureColumn(table, column, sqlType) {
    const markers = await getIndexMarkerStore();
    const markerPath = markers.buildIndexMarkerPath(this.workspaceId, this.orgId, table, `col_${column}`);
    if (markers.hasFreshIndexMarker(markerPath))
      return;
    const colCheck = `SELECT 1 FROM information_schema.columns WHERE table_name = '${sqlStr(table)}' AND column_name = '${sqlStr(column)}' AND table_schema = '${sqlStr(this.workspaceId)}' LIMIT 1`;
    const rows = await this.query(colCheck);
    if (rows.length > 0) {
      markers.writeIndexMarker(markerPath);
      return;
    }
    try {
      await this.query(`ALTER TABLE "${table}" ADD COLUMN ${column} ${sqlType}`);
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
    const tbl = sqlIdent(name ?? this.tableName);
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log2(`table "${tbl}" not found, creating`);
      await this.createTableWithRetry(`CREATE TABLE IF NOT EXISTS "${tbl}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', summary_embedding FLOAT4[], author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'text/plain', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', plugin_version TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`, tbl);
      log2(`table "${tbl}" created`);
      if (!tables.includes(tbl))
        this._tablesCache = [...tables, tbl];
    }
    await this.ensureEmbeddingColumn(tbl, SUMMARY_EMBEDDING_COL);
    await this.ensureColumn(tbl, "agent", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn(tbl, "plugin_version", "TEXT NOT NULL DEFAULT ''");
  }
  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log2(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(`CREATE TABLE IF NOT EXISTS "${safe}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', message JSONB, message_embedding FLOAT4[], author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/json', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', plugin_version TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`, safe);
      log2(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.ensureEmbeddingColumn(safe, MESSAGE_EMBEDDING_COL);
    await this.ensureColumn(safe, "agent", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn(safe, "plugin_version", "TEXT NOT NULL DEFAULT ''");
    await this.ensureLookupIndex(safe, "path_creation_date", `("path", "creation_date")`);
  }
  /**
   * Create the skills table.
   *
   * One row per skill version. Workers INSERT a fresh row on every KEEP /
   * MERGE rather than UPDATE-ing in place, so the full version history is
   * recoverable. Uniqueness in the *current* state is by (project_key, name)
   * — newer rows shadow older ones at read time (ORDER BY version DESC).
   * This sidesteps the Deeplake UPDATE-coalescing quirk that bit the wiki
   * worker.
   */
  async ensureSkillsTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log2(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(`CREATE TABLE IF NOT EXISTS "${safe}" (id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', project_key TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '', install TEXT NOT NULL DEFAULT 'project', source_sessions TEXT NOT NULL DEFAULT '[]', source_agent TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'me', author TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', trigger_text TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', version BIGINT NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '') USING deeplake`, safe);
      log2(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.ensureLookupIndex(safe, "project_key_name", `("project_key", "name")`);
  }
};

// dist/src/utils/session-path.js
function buildSessionPath(config, sessionId) {
  const workspace = config.workspaceId ?? "default";
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${workspace}_${sessionId}.jsonl`;
}

// dist/src/embeddings/client.js
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { openSync as openSync2, closeSync as closeSync2, writeSync, unlinkSync as unlinkSync2, existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
import { homedir as homedir6 } from "node:os";
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

// dist/src/notifications/queue.js
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, renameSync, mkdirSync as mkdirSync2, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { join as join4, resolve } from "node:path";
import { homedir as homedir3 } from "node:os";
import { setTimeout as sleep2 } from "node:timers/promises";
var log3 = (msg) => log("notifications-queue", msg);
var LOCK_RETRY_MAX = 50;
var LOCK_RETRY_BASE_MS = 5;
var LOCK_STALE_MS = 5e3;
function queuePath() {
  return join4(homedir3(), ".deeplake", "notifications-queue.json");
}
function lockPath() {
  return `${queuePath()}.lock`;
}
function readQueue() {
  try {
    const raw = readFileSync3(queuePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.queue)) {
      log3(`queue malformed \u2192 treating as empty`);
      return { queue: [] };
    }
    return { queue: parsed.queue };
  } catch {
    return { queue: [] };
  }
}
function _isQueuePathInsideHome(path, home) {
  const r = resolve(path);
  const h = resolve(home);
  return r.startsWith(h + "/") || r === h;
}
function writeQueue(q) {
  const path = queuePath();
  const home = resolve(homedir3());
  if (!_isQueuePathInsideHome(path, home)) {
    throw new Error(`notifications-queue write blocked: ${path} is outside ${home}`);
  }
  mkdirSync2(join4(home, ".deeplake"), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync2(tmp, JSON.stringify(q, null, 2), { mode: 384 });
  renameSync(tmp, path);
}
async function withQueueLock(fn) {
  const path = lockPath();
  mkdirSync2(join4(homedir3(), ".deeplake"), { recursive: true, mode: 448 });
  let fd = null;
  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    try {
      fd = openSync(path, "wx", 384);
      break;
    } catch (e) {
      const code = e.code;
      if (code !== "EEXIST")
        throw e;
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > LOCK_STALE_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {
      }
      const delay = LOCK_RETRY_BASE_MS * (attempt + 1);
      await sleep2(delay);
    }
  }
  if (fd === null) {
    log3(`lock acquisition gave up after ${LOCK_RETRY_MAX} attempts \u2014 proceeding unlocked (last-writer-wins)`);
    return fn();
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
    try {
      unlinkSync(path);
    } catch {
    }
  }
}
function sameDedupKey(a, b) {
  if (a.id !== b.id)
    return false;
  return JSON.stringify(a.dedupKey) === JSON.stringify(b.dedupKey);
}
async function enqueueNotification(n) {
  await withQueueLock(() => {
    const q = readQueue();
    if (q.queue.some((existing) => sameDedupKey(existing, n))) {
      return;
    }
    q.queue.push(n);
    writeQueue(q);
  });
}

// dist/src/embeddings/disable.js
import { createRequire } from "node:module";
import { homedir as homedir5 } from "node:os";
import { join as join6 } from "node:path";
import { pathToFileURL } from "node:url";

// dist/src/user-config.js
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync4, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname, join as join5 } from "node:path";
var _configPath = () => process.env.HIVEMIND_CONFIG_PATH ?? join5(homedir4(), ".deeplake", "config.json");
var _cache = null;
var _migrated = false;
function readUserConfig() {
  if (_cache !== null)
    return _cache;
  const path = _configPath();
  if (!existsSync3(path)) {
    _cache = {};
    return _cache;
  }
  try {
    const raw = readFileSync4(path, "utf-8");
    const parsed = JSON.parse(raw);
    _cache = isPlainObject(parsed) ? parsed : {};
  } catch {
    _cache = {};
  }
  return _cache;
}
function writeUserConfig(patch) {
  const current = readUserConfig();
  const merged = deepMerge(current, patch);
  const path = _configPath();
  const dir = dirname(path);
  if (!existsSync3(dir))
    mkdirSync3(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync3(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  renameSync2(tmp, path);
  _cache = merged;
  return merged;
}
function getEmbeddingsEnabled() {
  const cfg = readUserConfig();
  if (cfg.embeddings && typeof cfg.embeddings.enabled === "boolean") {
    return cfg.embeddings.enabled;
  }
  if (_migrated) {
    return migrationValueFromEnv();
  }
  _migrated = true;
  const enabled = migrationValueFromEnv();
  try {
    writeUserConfig({ embeddings: { enabled } });
  } catch {
    _cache = { ...cfg ?? {}, embeddings: { ...cfg?.embeddings ?? {}, enabled } };
  }
  return enabled;
}
function migrationValueFromEnv() {
  const raw = process.env.HIVEMIND_EMBEDDINGS;
  if (raw === void 0)
    return false;
  if (raw === "false")
    return false;
  return true;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    const baseVal = base[key];
    if (isPlainObject(patchVal) && isPlainObject(baseVal)) {
      out[key] = { ...baseVal, ...patchVal };
    } else if (patchVal !== void 0) {
      out[key] = patchVal;
    }
  }
  return out;
}

// dist/src/embeddings/disable.js
var cachedStatus = null;
function defaultResolveTransformers() {
  const sharedDir = join6(homedir5(), ".hivemind", "embed-deps");
  try {
    createRequire(pathToFileURL(`${sharedDir}/`).href).resolve("@huggingface/transformers");
    return;
  } catch {
  }
  createRequire(import.meta.url).resolve("@huggingface/transformers");
}
var _resolve = defaultResolveTransformers;
var _readEnabled = getEmbeddingsEnabled;
function detectStatus() {
  if (!_readEnabled())
    return "user-disabled";
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

// dist/src/embeddings/client.js
var SHARED_DAEMON_PATH = join7(homedir6(), ".hivemind", "embed-deps", "embed-daemon.js");
var log4 = (m) => log("embed-client", m);
function getUid() {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid !== void 0 ? String(uid) : process.env.USER ?? "default";
}
var _signalledMissingDeps = false;
var _recycledStuckDaemon = false;
var EmbedClient = class {
  socketPath;
  pidPath;
  timeoutMs;
  daemonEntry;
  autoSpawn;
  spawnWaitMs;
  nextId = 0;
  helloVerified = false;
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
   *
   * Stuck-daemon recycle: if the daemon returns a transformers-missing
   * error (typical after a marketplace upgrade left an older daemon process
   * alive but with no node_modules accessible from its bundle path), we
   * SIGTERM it and clear its sock/pid so the very next call spawns a fresh
   * daemon from the current bundle. Without this, the stuck daemon would
   * keep poisoning every session until its 10-minute idle-out fires.
   */
  async embed(text, kind = "document") {
    const v = await this.embedAttempt(text, kind);
    if (v !== "recycled")
      return v;
    if (!this.autoSpawn)
      return null;
    this.trySpawnDaemon();
    await this.waitForDaemonReady();
    const retry = await this.embedAttempt(text, kind);
    return retry === "recycled" ? null : retry;
  }
  /**
   * One round-trip: connect → verify → embed. Returns:
   *  - number[]  : embedding vector (happy path)
   *  - null      : timeout / daemon error / transformers-missing
   *  - "recycled": verifyDaemonOnce killed the daemon mid-call;
   *                caller should respawn and retry once.
   */
  async embedAttempt(text, kind) {
    let sock;
    try {
      sock = await this.connectOnce();
    } catch {
      if (this.autoSpawn)
        this.trySpawnDaemon();
      return null;
    }
    try {
      const recycled = await this.verifyDaemonOnce(sock);
      if (recycled) {
        return "recycled";
      }
      const id = String(++this.nextId);
      const req = { op: "embed", id, kind, text };
      const resp = await this.sendAndWait(sock, req);
      if (resp.error || !("embedding" in resp) || !resp.embedding) {
        const err = resp.error ?? "no embedding";
        log4(`embed err: ${err}`);
        if (isTransformersMissingError(err)) {
          this.handleTransformersMissing(err);
        }
        return null;
      }
      return resp.embedding;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log4(`embed failed: ${err}`);
      return null;
    } finally {
      try {
        sock.end();
      } catch {
      }
    }
  }
  /**
   * Poll for the sock file to come back after `trySpawnDaemon` — used by
   * the recycle retry path. Best-effort: caps at `spawnWaitMs` and
   * returns regardless so the retry attempt can run.
   */
  async waitForDaemonReady() {
    const deadline = Date.now() + this.spawnWaitMs;
    while (Date.now() < deadline) {
      if (existsSync4(this.socketPath))
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /**
   * Send a `hello` on first successful connect per EmbedClient instance.
   * If the daemon answers with a path that doesn't match our configured
   * daemonEntry — typical after a marketplace upgrade replaced the bundle
   * — SIGTERM the daemon + clear sock/pid so the next call spawns from the
   * current bundle.
   *
   * `helloVerified` is set ONLY after we've seen a compatible response,
   * so a transient probe failure or a recycle-triggering mismatch leaves
   * the flag false; the next reconnect re-runs verification against
   * whatever daemon is then live (typically the fresh spawn).
   */
  async verifyDaemonOnce(sock) {
    if (this.helloVerified)
      return false;
    if (!this.daemonEntry) {
      this.helloVerified = true;
      return false;
    }
    const id = String(++this.nextId);
    const req = { op: "hello", id };
    let resp;
    try {
      resp = await this.sendAndWait(sock, req);
    } catch (e) {
      log4(`hello probe failed (inconclusive, will retry next connect): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const hello = resp;
    if (_recycledStuckDaemon) {
      return false;
    }
    if (!hello.daemonPath) {
      _recycledStuckDaemon = true;
      log4(`daemon does not implement hello (older protocol); recycling`);
      this.recycleDaemon(hello.pid);
      return true;
    }
    if (hello.daemonPath !== this.daemonEntry && !existsSync4(hello.daemonPath)) {
      _recycledStuckDaemon = true;
      log4(`daemon path no longer on disk \u2014 running=${hello.daemonPath} (gone) expected=${this.daemonEntry}; recycling`);
      this.recycleDaemon(hello.pid);
      return true;
    }
    this.helloVerified = true;
    return false;
  }
  /**
   * On a transformers-missing error from the daemon, SIGTERM the stuck
   * daemon (the bundle daemon that can't find its deps) and clear
   * sock/pid so the next call spawns fresh. Also enqueue a one-time
   * notification telling the user to run `hivemind embeddings install`
   * — but only when the user has opted in. Suppressed when
   * embeddingsStatus() === "user-disabled" so we don't nag users who
   * explicitly chose to turn embeddings off.
   */
  handleTransformersMissing(detail) {
    if (!_recycledStuckDaemon) {
      _recycledStuckDaemon = true;
      this.recycleDaemon(null);
    }
    if (_signalledMissingDeps)
      return;
    _signalledMissingDeps = true;
    let status;
    try {
      status = embeddingsStatus();
    } catch {
      status = "enabled";
    }
    if (status === "user-disabled")
      return;
    enqueueNotification({
      id: "embed-deps-missing",
      severity: "warn",
      title: "Hivemind embeddings disabled \u2014 deps missing",
      body: `Semantic memory search is off because @huggingface/transformers is not installed where the daemon can find it. Run \`hivemind embeddings install\` to enable.`,
      dedupKey: { reason: "transformers-missing", detail: detail.slice(0, 200) }
    }).catch((e) => {
      log4(`enqueue embed-deps-missing failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  /**
   * Best-effort SIGTERM + sock/pid cleanup. Tolerant of every missing-file
   * combination and dead-PID cases.
   *
   * Identity check: gate the SIGTERM on the daemon's socket file still
   * existing. We know the daemon was alive moments ago (we either just
   * got a hello response or the caller saw a transformers-missing error
   * the daemon emitted), but if the socket file is gone by the time we
   * try to kill, the daemon process is also gone and the PID we
   * captured may already have been recycled by the OS to an unrelated
   * user process. Mirrors the gate added to `killEmbedDaemon` in the
   * CLI — same failure mode, rarer trigger.
   */
  recycleDaemon(reportedPid) {
    let pid = reportedPid;
    if (pid === null) {
      try {
        pid = Number.parseInt(readFileSync5(this.pidPath, "utf-8").trim(), 10);
      } catch {
      }
    }
    if (Number.isFinite(pid) && pid !== null && pid > 0 && existsSync4(this.socketPath)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    } else if (pid !== null) {
      log4(`recycle: socket gone, skipping SIGTERM on possibly-stale pid ${pid}`);
    }
    try {
      unlinkSync2(this.socketPath);
    } catch {
    }
    try {
      unlinkSync2(this.pidPath);
    } catch {
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
    return new Promise((resolve2, reject) => {
      const sock = connect(this.socketPath);
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("connect timeout"));
      }, this.timeoutMs);
      sock.once("connect", () => {
        clearTimeout(to);
        resolve2(sock);
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
      writeSync(fd, String(process.pid));
    } catch (e) {
      if (this.isPidFileStale()) {
        try {
          unlinkSync2(this.pidPath);
        } catch {
        }
        try {
          fd = openSync2(this.pidPath, "wx", 384);
          writeSync(fd, String(process.pid));
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    if (!this.daemonEntry || !existsSync4(this.daemonEntry)) {
      log4(`daemonEntry not configured or missing: ${this.daemonEntry}`);
      try {
        closeSync2(fd);
        unlinkSync2(this.pidPath);
      } catch {
      }
      return;
    }
    try {
      const child = spawn(process.execPath, [this.daemonEntry], {
        detached: true,
        stdio: "ignore",
        env: process.env
      });
      child.unref();
      log4(`spawned daemon pid=${child.pid}`);
    } finally {
      closeSync2(fd);
    }
  }
  isPidFileStale() {
    try {
      const raw = readFileSync5(this.pidPath, "utf-8").trim();
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
      await sleep3(delay);
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
    return new Promise((resolve2, reject) => {
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
          resolve2(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      });
      sock.on("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
      sock.on("end", () => {
        clearTimeout(to);
        reject(new Error("connection closed without response"));
      });
      sock.write(JSON.stringify(req) + "\n");
    });
  }
};
function sleep3(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isTransformersMissingError(err) {
  if (/hivemind embeddings install/i.test(err))
    return true;
  return /@huggingface\/transformers/i.test(err);
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

// dist/src/embeddings/self-heal.js
import { existsSync as existsSync5, lstatSync, mkdirSync as mkdirSync4, readlinkSync, renameSync as renameSync3, rmSync, symlinkSync, statSync as statSync2 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { basename, dirname as dirname2, join as join8 } from "node:path";
function ensurePluginNodeModulesLink(opts) {
  if (basename(opts.bundleDir) !== "bundle") {
    return { kind: "not-bundle-layout", bundleDir: opts.bundleDir };
  }
  const target = opts.sharedNodeModules ?? join8(homedir7(), ".hivemind", "embed-deps", "node_modules");
  const pluginDir = dirname2(opts.bundleDir);
  const link = join8(pluginDir, "node_modules");
  if (!existsSync5(target)) {
    return { kind: "shared-deps-missing", target };
  }
  let linkStat;
  try {
    linkStat = lstatSync(link);
  } catch {
    return createSymlinkAtomic(target, link);
  }
  if (linkStat.isSymbolicLink()) {
    let existingTarget;
    try {
      existingTarget = readlinkSync(link);
    } catch (e) {
      return { kind: "error", detail: `readlink failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (existingTarget === target) {
      return { kind: "already-linked", target, link };
    }
    try {
      statSync2(link);
      return { kind: "linked-elsewhere", link, existingTarget };
    } catch {
      try {
        rmSync(link);
      } catch {
      }
      const recreated = createSymlinkAtomic(target, link);
      if (recreated.kind === "linked") {
        return { kind: "stale-link-removed", link, danglingTarget: existingTarget };
      }
      return recreated;
    }
  }
  return { kind: "plugin-owns-node-modules", link };
}
function createSymlinkAtomic(target, link) {
  try {
    const parent = dirname2(link);
    if (!existsSync5(parent))
      mkdirSync4(parent, { recursive: true });
    const tmp = `${link}.tmp.${process.pid}`;
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    symlinkSync(target, tmp);
    renameSync3(tmp, link);
    return { kind: "linked", target, link };
  } catch (e) {
    return { kind: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

// dist/src/hooks/hermes/capture.js
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { dirname as dirname7, join as join19 } from "node:path";

// dist/src/hooks/summary-state.js
import { readFileSync as readFileSync6, writeFileSync as writeFileSync4, writeSync as writeSync2, mkdirSync as mkdirSync5, renameSync as renameSync4, existsSync as existsSync6, unlinkSync as unlinkSync3, openSync as openSync3, closeSync as closeSync3 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as join9 } from "node:path";
var dlog = (msg) => log("summary-state", msg);
var STATE_DIR = join9(homedir8(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function statePath(sessionId) {
  return join9(STATE_DIR, `${sessionId}.json`);
}
function lockPath2(sessionId) {
  return join9(STATE_DIR, `${sessionId}.lock`);
}
function readState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync6(p))
    return null;
  try {
    return JSON.parse(readFileSync6(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(sessionId, state) {
  mkdirSync5(STATE_DIR, { recursive: true });
  const p = statePath(sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync4(tmp, JSON.stringify(state));
  renameSync4(tmp, p);
}
function withRmwLock(sessionId, fn) {
  mkdirSync5(STATE_DIR, { recursive: true });
  const rmwLock = statePath(sessionId) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync3(rmwLock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        dlog(`rmw lock deadline exceeded for ${sessionId}, reclaiming stale lock`);
        try {
          unlinkSync3(rmwLock);
        } catch (unlinkErr) {
          dlog(`stale rmw lock unlink failed for ${sessionId}: ${unlinkErr.message}`);
        }
        continue;
      }
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync3(fd);
    try {
      unlinkSync3(rmwLock);
    } catch (unlinkErr) {
      dlog(`rmw lock cleanup failed for ${sessionId}: ${unlinkErr.message}`);
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
  mkdirSync5(STATE_DIR, { recursive: true });
  const p = lockPath2(sessionId);
  if (existsSync6(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync6(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs)
        return false;
    } catch (readErr) {
      dlog(`lock file unreadable for ${sessionId}, treating as stale: ${readErr.message}`);
    }
    try {
      unlinkSync3(p);
    } catch (unlinkErr) {
      dlog(`could not unlink stale lock for ${sessionId}: ${unlinkErr.message}`);
      return false;
    }
  }
  try {
    const fd = openSync3(p, "wx");
    try {
      writeSync2(fd, String(Date.now()));
    } finally {
      closeSync3(fd);
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
    unlinkSync3(lockPath2(sessionId));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      dlog(`releaseLock unlink failed for ${sessionId}: ${e.message}`);
    }
  }
}

// dist/src/hooks/hermes/spawn-wiki-worker.js
import { spawn as spawn2, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as dirname4, join as join12 } from "node:path";
import { writeFileSync as writeFileSync5, mkdirSync as mkdirSync7 } from "node:fs";
import { homedir as homedir9, tmpdir as tmpdir2 } from "node:os";

// dist/src/utils/wiki-log.js
import { mkdirSync as mkdirSync6, appendFileSync as appendFileSync2 } from "node:fs";
import { join as join10 } from "node:path";
function makeWikiLogger(hooksDir, filename = "deeplake-wiki.log") {
  const path = join10(hooksDir, filename);
  return {
    path,
    log(msg) {
      try {
        mkdirSync6(hooksDir, { recursive: true });
        appendFileSync2(path, `[${utcTimestamp()}] ${msg}
`);
      } catch {
      }
    }
  };
}

// dist/src/utils/version-check.js
import { readFileSync as readFileSync7 } from "node:fs";
import { dirname as dirname3, join as join11 } from "node:path";
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join11(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync7(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  try {
    const stamp = readFileSync7(join11(bundleDir, "..", ".hivemind_version"), "utf-8").trim();
    if (stamp)
      return stamp;
  } catch {
  }
  const HIVEMIND_PKG_NAMES = /* @__PURE__ */ new Set([
    "hivemind",
    "hivemind-codex",
    "@deeplake/hivemind",
    "@deeplake/hivemind-codex",
    "@activeloop/hivemind",
    "@activeloop/hivemind-codex"
  ]);
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join11(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync7(candidate, "utf-8"));
      if (HIVEMIND_PKG_NAMES.has(pkg.name) && pkg.version)
        return pkg.version;
    } catch {
    }
    const parent = dirname3(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}

// dist/src/hooks/hermes/spawn-wiki-worker.js
var HOME = homedir9();
var wikiLogger = makeWikiLogger(join12(HOME, ".hermes", "hooks"));
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
function findHermesBin() {
  try {
    return execSync("which hermes 2>/dev/null", { encoding: "utf-8" }).trim() || "hermes";
  } catch {
    return "hermes";
  }
}
function spawnHermesWikiWorker(opts) {
  const { config, sessionId, cwd, bundleDir, reason } = opts;
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join12(tmpdir2(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync7(tmpDir, { recursive: true });
  const pluginVersion = getInstalledVersion(bundleDir, ".claude-plugin") ?? "";
  const configFile = join12(tmpDir, "config.json");
  writeFileSync5(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    memoryTable: config.tableName,
    sessionsTable: config.sessionsTableName,
    sessionId,
    userName: config.userName,
    project: projectName,
    pluginVersion,
    tmpDir,
    hermesBin: findHermesBin(),
    hermesProvider: process.env.HIVEMIND_HERMES_PROVIDER ?? "openrouter",
    hermesModel: process.env.HIVEMIND_HERMES_MODEL ?? "anthropic/claude-haiku-4-5",
    wikiLog: WIKI_LOG,
    hooksDir: join12(HOME, ".hermes", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE
  }));
  wikiLog(`${reason}: spawning summary worker for ${sessionId}`);
  const workerPath = join12(bundleDir, "wiki-worker.js");
  spawn2("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`${reason}: spawned summary worker for ${sessionId}`);
}
function bundleDirFromImportMeta(importMetaUrl) {
  return dirname4(fileURLToPath(importMetaUrl));
}

// dist/src/skillify/spawn-skillify-worker.js
import { spawn as spawn3 } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname5, join as join14 } from "node:path";
import { writeFileSync as writeFileSync6, mkdirSync as mkdirSync8, appendFileSync as appendFileSync3, chmodSync } from "node:fs";
import { homedir as homedir11, tmpdir as tmpdir3 } from "node:os";

// dist/src/skillify/gate-runner.js
import { existsSync as existsSync7 } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { homedir as homedir10 } from "node:os";
import { join as join13 } from "node:path";
var requireForCp = createRequire2(import.meta.url);
var { execFileSync: runChildProcess } = requireForCp("node:child_process");
var inheritedEnv = process;
function firstExistingPath(candidates) {
  for (const c of candidates) {
    if (existsSync7(c))
      return c;
  }
  return null;
}
function findAgentBin(agent) {
  const home = homedir10();
  switch (agent) {
    // /usr/bin/<name> is included in every candidate list — that's the
    // common Linux package-manager install path (apt, dnf, pacman). Old
    // code used `which` which always checked it; the static-scan fix
    // dropped `which`, so /usr/bin needs to be explicit. CodeRabbit on
    // #170 caught the gap.
    case "claude_code":
      return firstExistingPath([
        join13(home, ".claude", "local", "claude"),
        "/usr/local/bin/claude",
        "/usr/bin/claude",
        join13(home, ".npm-global", "bin", "claude"),
        join13(home, ".local", "bin", "claude"),
        "/opt/homebrew/bin/claude"
      ]) ?? join13(home, ".claude", "local", "claude");
    case "codex":
      return firstExistingPath([
        "/usr/local/bin/codex",
        "/usr/bin/codex",
        join13(home, ".npm-global", "bin", "codex"),
        join13(home, ".local", "bin", "codex"),
        "/opt/homebrew/bin/codex"
      ]) ?? "/usr/local/bin/codex";
    case "cursor":
      return firstExistingPath([
        "/usr/local/bin/cursor-agent",
        "/usr/bin/cursor-agent",
        join13(home, ".npm-global", "bin", "cursor-agent"),
        join13(home, ".local", "bin", "cursor-agent"),
        "/opt/homebrew/bin/cursor-agent"
      ]) ?? "/usr/local/bin/cursor-agent";
    case "hermes":
      return firstExistingPath([
        join13(home, ".local", "bin", "hermes"),
        "/usr/local/bin/hermes",
        "/usr/bin/hermes",
        join13(home, ".npm-global", "bin", "hermes"),
        "/opt/homebrew/bin/hermes"
      ]) ?? join13(home, ".local", "bin", "hermes");
    case "pi":
      return firstExistingPath([
        join13(home, ".local", "bin", "pi"),
        "/usr/local/bin/pi",
        "/usr/bin/pi",
        join13(home, ".npm-global", "bin", "pi"),
        "/opt/homebrew/bin/pi"
      ]) ?? join13(home, ".local", "bin", "pi");
  }
}

// dist/src/skillify/spawn-skillify-worker.js
var HOME2 = homedir11();
var SKILLIFY_LOG = join14(HOME2, ".claude", "hooks", "skillify.log");
function skillifyLog(msg) {
  try {
    mkdirSync8(dirname5(SKILLIFY_LOG), { recursive: true });
    appendFileSync3(SKILLIFY_LOG, `[${utcTimestamp()}] ${msg}
`);
  } catch {
  }
}
function spawnSkillifyWorker(opts) {
  const { config, cwd, projectKey, project, bundleDir, agent, scopeConfig, currentSessionId, reason } = opts;
  const tmpDir = join14(tmpdir3(), `deeplake-skillify-${projectKey}-${Date.now()}`);
  mkdirSync8(tmpDir, { recursive: true, mode: 448 });
  const gateBin = findAgentBin(agent);
  const configFile = join14(tmpDir, "config.json");
  writeFileSync6(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    sessionsTable: config.sessionsTableName,
    skillsTable: config.skillsTableName,
    userName: config.userName,
    cwd,
    projectKey,
    project,
    agent,
    scope: scopeConfig.scope,
    team: scopeConfig.team,
    install: scopeConfig.install,
    tmpDir,
    gateBin,
    cursorModel: process.env.HIVEMIND_CURSOR_MODEL,
    hermesProvider: process.env.HIVEMIND_HERMES_PROVIDER,
    hermesModel: process.env.HIVEMIND_HERMES_MODEL,
    piProvider: process.env.HIVEMIND_PI_PROVIDER,
    piModel: process.env.HIVEMIND_PI_MODEL,
    skillifyLog: SKILLIFY_LOG,
    currentSessionId
  }), { mode: 384 });
  try {
    chmodSync(configFile, 384);
  } catch {
  }
  skillifyLog(`${reason}: spawning skillify worker for project=${project} key=${projectKey}`);
  const workerPath = join14(bundleDir, "skillify-worker.js");
  spawn3("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  skillifyLog(`${reason}: spawned skillify worker for ${projectKey}`);
}

// dist/src/skillify/state.js
import { readFileSync as readFileSync8, writeFileSync as writeFileSync7, writeSync as writeSync3, mkdirSync as mkdirSync9, renameSync as renameSync6, rmdirSync, existsSync as existsSync9, lstatSync as lstatSync2, unlinkSync as unlinkSync4, openSync as openSync4, closeSync as closeSync4 } from "node:fs";
import { execSync as execSync2 } from "node:child_process";
import { createHash } from "node:crypto";
import { join as join17, basename as basename2 } from "node:path";

// dist/src/skillify/legacy-migration.js
import { existsSync as existsSync8, renameSync as renameSync5 } from "node:fs";
import { dirname as dirname6, join as join16 } from "node:path";

// dist/src/skillify/state-dir.js
import { homedir as homedir12 } from "node:os";
import { join as join15 } from "node:path";
function getStateDir() {
  const override = process.env.HIVEMIND_STATE_DIR?.trim();
  return override && override.length > 0 ? override : join15(homedir12(), ".deeplake", "state", "skillify");
}

// dist/src/skillify/legacy-migration.js
var dlog2 = (msg) => log("skillify-migrate", msg);
var attemptedFor = /* @__PURE__ */ new Set();
function migrateLegacyStateDir() {
  if (process.env.HIVEMIND_STATE_DIR?.trim())
    return;
  const current = getStateDir();
  if (attemptedFor.has(current))
    return;
  attemptedFor.add(current);
  const legacy = join16(dirname6(current), "skilify");
  if (!existsSync8(legacy))
    return;
  if (existsSync8(current))
    return;
  try {
    renameSync5(legacy, current);
    dlog2(`migrated ${legacy} -> ${current}`);
  } catch (err) {
    const code = err.code;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      dlog2(`migration skipped (${code}); legacy dir left as-is or another process handled it`);
      return;
    }
    throw err;
  }
}

// dist/src/skillify/state.js
var dlog3 = (msg) => log("skillify-state", msg);
var YIELD_BUF2 = new Int32Array(new SharedArrayBuffer(4));
var TRIGGER_THRESHOLD = (() => {
  const n = Number(process.env.HIVEMIND_SKILLIFY_EVERY_N_TURNS ?? "");
  return Number.isInteger(n) && n > 0 ? n : 20;
})();
function statePath2(projectKey) {
  return join17(getStateDir(), `${projectKey}.json`);
}
function lockPath3(projectKey) {
  return join17(getStateDir(), `${projectKey}.lock`);
}
var DEFAULT_PORTS = {
  http: "80",
  https: "443",
  ssh: "22",
  git: "9418"
};
function normalizeGitRemoteUrl(url) {
  let s = url.trim();
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  if (schemeMatch)
    s = s.slice(schemeMatch[0].length);
  if (!scheme) {
    const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp)
      s = `${scp[1]}/${scp[2]}`;
  }
  s = s.replace(/^[^@/]+@/, "");
  if (scheme && DEFAULT_PORTS[scheme]) {
    s = s.replace(new RegExp(`^([^/]+):${DEFAULT_PORTS[scheme]}(/|$)`), "$1$2");
  }
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}
function deriveProjectKey(cwd) {
  const project = basename2(cwd) || "unknown";
  let signature = null;
  try {
    const raw = execSync2("git config --get remote.origin.url", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    signature = raw ? normalizeGitRemoteUrl(raw) : null;
  } catch {
  }
  const input = signature ?? cwd;
  const key = createHash("sha1").update(input).digest("hex").slice(0, 16);
  return { key, project };
}
function readState2(projectKey) {
  migrateLegacyStateDir();
  const p = statePath2(projectKey);
  if (!existsSync9(p))
    return null;
  try {
    return JSON.parse(readFileSync8(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState2(projectKey, state) {
  migrateLegacyStateDir();
  mkdirSync9(getStateDir(), { recursive: true });
  const p = statePath2(projectKey);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync7(tmp, JSON.stringify(state, null, 2));
  renameSync6(tmp, p);
}
function withRmwLock2(projectKey, fn) {
  migrateLegacyStateDir();
  mkdirSync9(getStateDir(), { recursive: true });
  const rmw = lockPath3(projectKey) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync4(rmw, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        dlog3(`rmw lock deadline exceeded for ${projectKey}, reclaiming stale lock`);
        try {
          unlinkSync4(rmw);
        } catch (unlinkErr) {
          dlog3(`stale rmw lock unlink failed for ${projectKey}: ${unlinkErr.message}`);
        }
        continue;
      }
      Atomics.wait(YIELD_BUF2, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync4(fd);
    try {
      unlinkSync4(rmw);
    } catch (unlinkErr) {
      dlog3(`rmw lock cleanup failed for ${projectKey}: ${unlinkErr.message}`);
    }
  }
}
function bumpStopCounter(cwd) {
  const { key, project } = deriveProjectKey(cwd);
  return withRmwLock2(key, () => {
    const existing = readState2(key);
    const next = existing ? { ...existing, counter: existing.counter + 1, updatedAt: Date.now() } : {
      project,
      projectKey: key,
      counter: 1,
      lastUuid: null,
      lastDate: null,
      skillsGenerated: [],
      updatedAt: Date.now()
    };
    writeState2(key, next);
    return next;
  });
}
function resetCounter(projectKey) {
  withRmwLock2(projectKey, () => {
    const s = readState2(projectKey);
    if (!s)
      return;
    writeState2(projectKey, { ...s, counter: 0, updatedAt: Date.now() });
  });
}
function tryAcquireWorkerLock(projectKey, maxAgeMs = 10 * 60 * 1e3) {
  migrateLegacyStateDir();
  mkdirSync9(getStateDir(), { recursive: true });
  const p = lockPath3(projectKey);
  if (existsSync9(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync8(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs)
        return false;
    } catch (readErr) {
      dlog3(`worker lock unreadable for ${projectKey}, treating as stale: ${readErr.message}`);
    }
    try {
      unlinkSync4(p);
    } catch (unlinkErr) {
      if (unlinkErr?.code !== "EISDIR" && unlinkErr?.code !== "EPERM" && unlinkErr?.code !== "ENOENT") {
        dlog3(`could not unlink stale worker lock for ${projectKey}: ${unlinkErr.message}`);
        return false;
      }
      let isDir = false;
      try {
        isDir = lstatSync2(p).isDirectory();
      } catch {
      }
      if (isDir) {
        try {
          rmdirSync(p);
        } catch (rmErr) {
          dlog3(`rmdir stale lock skipped for ${projectKey}: ${rmErr.message}`);
        }
      }
    }
  }
  try {
    const fd = openSync4(p, "wx");
    try {
      writeSync3(fd, String(Date.now()));
    } finally {
      closeSync4(fd);
    }
    return true;
  } catch {
    return false;
  }
}
function releaseWorkerLock(projectKey) {
  const p = lockPath3(projectKey);
  try {
    unlinkSync4(p);
  } catch {
  }
}

// dist/src/skillify/scope-config.js
import { existsSync as existsSync10, mkdirSync as mkdirSync10, readFileSync as readFileSync9, writeFileSync as writeFileSync8 } from "node:fs";
import { join as join18 } from "node:path";
function configPath() {
  return join18(getStateDir(), "config.json");
}
var DEFAULT = { scope: "me", team: [], install: "project" };
function loadScopeConfig() {
  migrateLegacyStateDir();
  const CONFIG_PATH = configPath();
  if (!existsSync10(CONFIG_PATH))
    return DEFAULT;
  try {
    const raw = JSON.parse(readFileSync9(CONFIG_PATH, "utf-8"));
    const scope = raw.scope === "team" ? "team" : raw.scope === "org" ? "team" : "me";
    const team = Array.isArray(raw.team) ? raw.team.filter((s) => typeof s === "string") : [];
    const install = raw.install === "global" ? "global" : "project";
    return { scope, team, install };
  } catch {
    return DEFAULT;
  }
}

// dist/src/skillify/triggers.js
function tryStopCounterTrigger(opts) {
  if (process.env.HIVEMIND_SKILLIFY_WORKER === "1")
    return;
  if (!opts.cwd)
    return;
  try {
    const state = bumpStopCounter(opts.cwd);
    if (state.counter < TRIGGER_THRESHOLD)
      return;
    if (!tryAcquireWorkerLock(state.projectKey)) {
      skillifyLog(`Stop: trigger suppressed (worker lock held) project=${state.project}`);
      return;
    }
    skillifyLog(`Stop: threshold hit (counter=${state.counter}, N=${TRIGGER_THRESHOLD}) project=${state.project} agent=${opts.agent}`);
    resetCounter(state.projectKey);
    try {
      spawnSkillifyWorker({
        config: opts.config,
        cwd: opts.cwd,
        projectKey: state.projectKey,
        project: state.project,
        bundleDir: opts.bundleDir,
        agent: opts.agent,
        scopeConfig: loadScopeConfig(),
        currentSessionId: opts.sessionId,
        reason: "Stop"
      });
    } catch (e) {
      skillifyLog(`Stop spawn failed: ${e?.message ?? e}`);
      try {
        releaseWorkerLock(state.projectKey);
      } catch {
      }
    }
  } catch (e) {
    skillifyLog(`Stop trigger error: ${e?.message ?? e}`);
  }
}

// dist/src/hooks/hermes/capture.js
var log5 = (msg) => log("hermes-capture", msg);
function resolveEmbedDaemonPath() {
  return join19(dirname7(fileURLToPath3(import.meta.url)), "embeddings", "embed-daemon.js");
}
var __bundleDir = dirname7(fileURLToPath3(import.meta.url));
var PLUGIN_VERSION = getInstalledVersion(__bundleDir, ".claude-plugin") ?? "";
if (!embeddingsDisabled()) {
  try {
    ensurePluginNodeModulesLink({ bundleDir: __bundleDir });
  } catch {
  }
}
var CAPTURE = process.env.HIVEMIND_CAPTURE !== "false";
function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0)
      return c;
  }
  return void 0;
}
async function main() {
  if (!CAPTURE)
    return;
  const input = await readStdin();
  const config = loadConfig();
  if (!config) {
    log5("no config");
    return;
  }
  const sessionId = input.session_id ?? `hermes-${Date.now()}`;
  const event = input.hook_event_name ?? "";
  const cwd = input.cwd ?? "";
  const extra = input.extra ?? {};
  const sessionsTable = config.sessionsTableName;
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, sessionsTable);
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const meta = {
    session_id: sessionId,
    cwd,
    hook_event_name: event,
    timestamp: ts
  };
  let entry = null;
  if (event === "pre_llm_call") {
    const prompt = pickString(extra.prompt, extra.user_message, extra.message?.content);
    if (!prompt) {
      log5(`pre_llm_call: no prompt found in extra`);
      return;
    }
    log5(`user session=${sessionId}`);
    entry = { id: crypto.randomUUID(), ...meta, type: "user_message", content: prompt };
  } else if (event === "post_tool_call" && typeof input.tool_name === "string") {
    const toolResponse = extra.tool_result ?? extra.tool_output ?? extra.result ?? extra.output;
    log5(`tool=${input.tool_name} session=${sessionId}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse ?? null)
    };
  } else if (event === "post_llm_call") {
    const text = pickString(extra.response, extra.assistant_message, extra.message?.content);
    if (!text) {
      log5(`post_llm_call: no response found in extra`);
      return;
    }
    log5(`assistant session=${sessionId}`);
    entry = { id: crypto.randomUUID(), ...meta, type: "assistant_message", content: text };
  } else {
    log5(`unknown/unhandled event: ${event}, skipping`);
    return;
  }
  const sessionPath = buildSessionPath(config, sessionId);
  const line = JSON.stringify(entry);
  log5(`writing to ${sessionPath}`);
  const projectName = cwd.split("/").pop() || "unknown";
  const filename = sessionPath.split("/").pop() ?? "";
  const jsonForSql = line.replace(/'/g, "''");
  const embedding = embeddingsDisabled() ? null : await new EmbedClient({ daemonEntry: resolveEmbedDaemonPath() }).embed(line, "document");
  const embeddingSql = embeddingSqlLiteral(embedding);
  const insertSql = `INSERT INTO "${sessionsTable}" (id, path, filename, message, message_embedding, author, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, ${embeddingSql}, '${sqlStr(config.userName)}', ${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(event)}', 'hermes', '${sqlStr(PLUGIN_VERSION)}', '${ts}', '${ts}')`;
  try {
    await api.query(insertSql);
  } catch (e) {
    if (e.message?.includes("permission denied") || e.message?.includes("does not exist")) {
      log5("table missing, creating and retrying");
      await api.ensureSessionsTable(sessionsTable);
      await api.query(insertSql);
    } else {
      throw e;
    }
  }
  log5("capture ok \u2192 cloud");
  maybeTriggerPeriodicSummary(sessionId, cwd, config);
  if (event === "post_llm_call" && process.env.HIVEMIND_WIKI_WORKER !== "1" && process.env.HIVEMIND_SKILLIFY_WORKER !== "1") {
    tryStopCounterTrigger({
      config,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      agent: "hermes",
      sessionId
    });
  }
}
function maybeTriggerPeriodicSummary(sessionId, cwd, config) {
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  try {
    const state = bumpTotalCount(sessionId);
    const cfg = loadTriggerConfig();
    if (!shouldTrigger(state, cfg))
      return;
    if (!tryAcquireLock(sessionId)) {
      log5(`periodic trigger suppressed (lock held) session=${sessionId}`);
      return;
    }
    wikiLog(`Periodic: threshold hit (total=${state.totalCount}, since=${state.totalCount - state.lastSummaryCount}, N=${cfg.everyNMessages}, hours=${cfg.everyHours})`);
    try {
      spawnHermesWikiWorker({
        config,
        sessionId,
        cwd,
        bundleDir: bundleDirFromImportMeta(import.meta.url),
        reason: "Periodic"
      });
    } catch (e) {
      log5(`periodic spawn failed: ${e.message}`);
      try {
        releaseLock(sessionId);
      } catch {
      }
    }
  } catch (e) {
    log5(`periodic trigger error: ${e.message}`);
  }
}
main().catch((e) => {
  log5(`fatal: ${e.message}`);
  process.exit(0);
});
