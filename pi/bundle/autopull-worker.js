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

// dist/src/utils/client-header.js
var DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
function deeplakeClientValue() {
  return "hivemind";
}
function deeplakeClientHeader() {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}

// dist/src/deeplake-schema.js
var MEMORY_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "filename", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "summary", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "summary_embedding", sql: "FLOAT4[]" },
  { name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mime_type", sql: "TEXT NOT NULL DEFAULT 'text/plain'" },
  { name: "size_bytes", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "creation_date", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var SESSIONS_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "filename", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "message", sql: "JSONB" },
  { name: "message_embedding", sql: "FLOAT4[]" },
  { name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mime_type", sql: "TEXT NOT NULL DEFAULT 'application/json'" },
  { name: "size_bytes", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "creation_date", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var SKILLS_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "project_key", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "local_path", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "install", sql: "TEXT NOT NULL DEFAULT 'project'" },
  { name: "source_sessions", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "source_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "scope", sql: "TEXT NOT NULL DEFAULT 'me'" },
  { name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "contributors", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "trigger_text", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "body", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" }
]);
function validateSchema(label, cols) {
  const seen = /* @__PURE__ */ new Set();
  for (const col of cols) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name)) {
      throw new Error(`${label}: column name "${col.name}" is not a valid SQL identifier`);
    }
    if (seen.has(col.name)) {
      throw new Error(`${label}: duplicate column "${col.name}"`);
    }
    seen.add(col.name);
    const notNull = /\bNOT\s+NULL\b/i.test(col.sql);
    const hasDefault = /\bDEFAULT\b/i.test(col.sql);
    if (notNull && !hasDefault) {
      throw new Error(`${label}: column "${col.name}" is NOT NULL but has no DEFAULT \u2014 ALTER TABLE ADD COLUMN on a populated table would fail.`);
    }
  }
}
validateSchema("MEMORY_COLUMNS", MEMORY_COLUMNS);
validateSchema("SESSIONS_COLUMNS", SESSIONS_COLUMNS);
validateSchema("SKILLS_COLUMNS", SKILLS_COLUMNS);
function buildCreateTableSql(tableName, cols) {
  const safe = sqlIdent(tableName);
  const colSql = cols.map((c) => `${c.name} ${c.sql}`).join(", ");
  return `CREATE TABLE IF NOT EXISTS "${safe}" (${colSql}) USING deeplake`;
}
function buildIntrospectionSql(tableName, workspaceId) {
  return `SELECT column_name FROM information_schema.columns WHERE table_name = '${sqlStr(tableName)}' AND table_schema = '${sqlStr(workspaceId)}'`;
}
async function healMissingColumns(args) {
  const safeTable = sqlIdent(args.tableName);
  const introspectSql = buildIntrospectionSql(args.tableName, args.workspaceId);
  const rows = await args.query(introspectSql);
  const existing = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const v = row?.column_name;
    if (typeof v === "string")
      existing.add(v.toLowerCase());
  }
  const missingCols = args.columns.filter((c) => !existing.has(c.name.toLowerCase()));
  const missing = missingCols.map((c) => c.name);
  if (missingCols.length === 0)
    return { missing, altered: [] };
  const altered = [];
  for (const col of missingCols) {
    try {
      await args.query(`ALTER TABLE "${safeTable}" ADD COLUMN ${col.name} ${col.sql}`);
      altered.push(col.name);
      args.log?.(`schema-heal: added "${args.tableName}"."${col.name}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg))
        throw e;
      const recheck = await args.query(introspectSql);
      const present = recheck.some((r) => {
        const v = r?.column_name;
        return typeof v === "string" && v.toLowerCase() === col.name.toLowerCase();
      });
      if (!present)
        throw e;
      args.log?.(`schema-heal: "${args.tableName}"."${col.name}" appeared via race, treating as success`);
    }
  }
  return { missing, altered };
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
   * Heal any missing columns on a table so it matches one of the schema
   * definitions in `deeplake-schema.ts`. One SELECT against
   * `information_schema.columns` per call, then `ALTER TABLE ADD COLUMN`
   * only the genuinely missing ones — never blanket, never `IF NOT
   * EXISTS`.
   *
   * History: an earlier path used a local marker file (`col_<name>` under
   * the index-marker dir) to skip even the SELECT after the first
   * confirmation, plus per-column ALTERs for `summary_embedding`,
   * `message_embedding`, `agent`, `plugin_version`. The marker existed
   * because Deeplake used to expose a ~30s post-ALTER bug where
   * subsequent INSERTs failed, so we wanted to keep ALTER traffic to a
   * minimum. The bug was re-verified on 2026-05-18 against
   * `api.deeplake.ai` (`test_plugin` org) and no longer reproduces
   * (71/71 INSERTs OK, first success 2ms after ALTER). The single SELECT
   * + targeted ALTER pattern survives the marker removal because: each
   * ALTER still costs ~800ms (so blanket sweeps are wasteful) and the
   * diff produces clearer logs than "ALTER all with IF NOT EXISTS".
   */
  async healSchema(table, columns) {
    await healMissingColumns({
      query: (sql) => this.query(sql),
      tableName: table,
      workspaceId: this.workspaceId,
      columns,
      log: log2
    });
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
  /** Create the memory table if it doesn't already exist. Heal missing columns on existing tables. */
  async ensureTable(name) {
    if (!MEMORY_COLUMNS.some((c) => c.name === SUMMARY_EMBEDDING_COL)) {
      throw new Error(`MEMORY_COLUMNS missing "${SUMMARY_EMBEDDING_COL}" (embeddings/columns.ts drift)`);
    }
    const tbl = sqlIdent(name ?? this.tableName);
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log2(`table "${tbl}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(tbl, MEMORY_COLUMNS), tbl);
      log2(`table "${tbl}" created`);
      if (!tables.includes(tbl))
        this._tablesCache = [...tables, tbl];
    }
    await this.healSchema(tbl, MEMORY_COLUMNS);
  }
  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log2(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, SESSIONS_COLUMNS), safe);
      log2(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, SESSIONS_COLUMNS);
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
      await this.createTableWithRetry(buildCreateTableSql(safe, SKILLS_COLUMNS), safe);
      log2(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, SKILLS_COLUMNS);
    await this.ensureLookupIndex(safe, "project_key_name", `("project_key", "name")`);
  }
};

// dist/src/skillify/pull.js
import { existsSync as existsSync7, readFileSync as readFileSync5, writeFileSync as writeFileSync4, mkdirSync as mkdirSync4, renameSync as renameSync3, lstatSync as lstatSync2, readlinkSync, symlinkSync, unlinkSync as unlinkSync2 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { dirname as dirname2, join as join8 } from "node:path";

// dist/src/skillify/skill-writer.js
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, readdirSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
function assertValidSkillName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`invalid skill name: empty or non-string`);
  }
  if (name.length > 100) {
    throw new Error(`invalid skill name: too long (${name.length} chars)`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid skill name: contains path separator or '..': ${name}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid skill name: must be kebab-case (lowercase a-z, 0-9, hyphen): ${name}`);
  }
}
function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n"))
    return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0)
    return null;
  const head = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const fm = { source_sessions: [] };
  let arrayKey = null;
  for (const raw of head.split(/\r?\n/)) {
    if (arrayKey) {
      const m2 = raw.match(/^\s+-\s+(.+)$/);
      if (m2) {
        const arr = fm[arrayKey] ?? [];
        arr.push(m2[1].trim());
        fm[arrayKey] = arr;
        continue;
      }
      arrayKey = null;
    }
    if (raw.startsWith("source_sessions:")) {
      arrayKey = "source_sessions";
      continue;
    }
    if (raw.startsWith("contributors:")) {
      arrayKey = "contributors";
      fm.contributors = [];
      continue;
    }
    const m = raw.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m)
      continue;
    const [, k, v] = m;
    let val = v;
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        val = JSON.parse(v);
      } catch {
      }
    } else if (k === "version") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n))
        val = n;
    }
    fm[k] = val;
  }
  return { fm, body };
}

// dist/src/skillify/manifest.js
import { existsSync as existsSync5, lstatSync, mkdirSync as mkdirSync3, readFileSync as readFileSync4, renameSync as renameSync2, unlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { dirname, join as join6 } from "node:path";

// dist/src/skillify/legacy-migration.js
import { existsSync as existsSync4, renameSync } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";
var dlog = (msg) => log("skillify-migrate", msg);
var attempted = false;
function migrateLegacyStateDir() {
  if (attempted)
    return;
  attempted = true;
  const root = join5(homedir4(), ".deeplake", "state");
  const legacy = join5(root, "skilify");
  const current = join5(root, "skillify");
  if (!existsSync4(legacy))
    return;
  if (existsSync4(current))
    return;
  try {
    renameSync(legacy, current);
    dlog(`migrated ${legacy} -> ${current}`);
  } catch (err) {
    const code = err.code;
    if (code === "EXDEV" || code === "EPERM") {
      dlog(`migration failed (${code}); leaving legacy dir in place`);
      return;
    }
    throw err;
  }
}

// dist/src/skillify/manifest.js
function emptyManifest() {
  return { version: 1, entries: [] };
}
function manifestPath() {
  return join6(homedir5(), ".deeplake", "state", "skillify", "pulled.json");
}
function loadManifest(path = manifestPath()) {
  migrateLegacyStateDir();
  if (!existsSync5(path))
    return emptyManifest();
  let raw;
  try {
    raw = readFileSync4(path, "utf-8");
  } catch {
    return emptyManifest();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return emptyManifest();
    if (parsed.version !== 1 || !Array.isArray(parsed.entries))
      return emptyManifest();
    const entries = [];
    for (const e of parsed.entries) {
      if (!e || typeof e !== "object")
        continue;
      if (typeof e.dirName !== "string" || !e.dirName)
        continue;
      if (e.dirName.includes("/") || e.dirName.includes("\\") || e.dirName.includes(".."))
        continue;
      if (typeof e.name !== "string" || !e.name)
        continue;
      if (typeof e.author !== "string")
        continue;
      if (typeof e.installRoot !== "string" || !e.installRoot)
        continue;
      if (e.install !== "global" && e.install !== "project")
        continue;
      const symlinks = Array.isArray(e.symlinks) ? e.symlinks.filter((p) => typeof p === "string" && p.length > 0 && (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) && // absolute (POSIX or Windows)
      !p.includes("..")) : [];
      entries.push({
        dirName: e.dirName,
        name: e.name,
        author: e.author,
        projectKey: typeof e.projectKey === "string" ? e.projectKey : "",
        remoteVersion: typeof e.remoteVersion === "number" ? e.remoteVersion : 1,
        install: e.install,
        installRoot: e.installRoot,
        pulledAt: typeof e.pulledAt === "string" ? e.pulledAt : (/* @__PURE__ */ new Date()).toISOString(),
        symlinks
      });
    }
    return { version: 1, entries };
  } catch {
    return emptyManifest();
  }
}
function saveManifest(m, path = manifestPath()) {
  migrateLegacyStateDir();
  mkdirSync3(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync3(tmp, JSON.stringify(m, null, 2) + "\n", { mode: 384 });
  renameSync2(tmp, path);
}
function recordPull(entry, path = manifestPath()) {
  const m = loadManifest(path);
  const idx = m.entries.findIndex((e) => e.install === entry.install && e.installRoot === entry.installRoot && e.dirName === entry.dirName);
  if (idx >= 0)
    m.entries[idx] = entry;
  else
    m.entries.push(entry);
  saveManifest(m, path);
}
function entriesForRoot(m, install, installRoot) {
  return m.entries.filter((e) => e.install === install && e.installRoot === installRoot);
}
function unlinkSymlinks(paths) {
  for (const path of paths) {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink())
      continue;
    try {
      unlinkSync(path);
    } catch {
    }
  }
}
function pruneOrphanedEntries(path = manifestPath()) {
  const m = loadManifest(path);
  const live = [];
  let pruned = 0;
  for (const e of m.entries) {
    if (existsSync5(join6(e.installRoot, e.dirName))) {
      live.push(e);
      continue;
    }
    unlinkSymlinks(e.symlinks);
    pruned++;
  }
  if (pruned > 0)
    saveManifest({ version: 1, entries: live }, path);
  return pruned;
}

// dist/src/skillify/agent-roots.js
import { existsSync as existsSync6 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join7 } from "node:path";
function resolveDetected(home) {
  const out = [];
  const codexInstalled = existsSync6(join7(home, ".codex"));
  const piInstalled = existsSync6(join7(home, ".pi", "agent"));
  const hermesInstalled = existsSync6(join7(home, ".hermes"));
  if (codexInstalled || piInstalled) {
    out.push(join7(home, ".agents", "skills"));
  }
  if (hermesInstalled) {
    out.push(join7(home, ".hermes", "skills"));
  }
  if (piInstalled) {
    out.push(join7(home, ".pi", "agent", "skills"));
  }
  return out;
}
function detectAgentSkillsRoots(canonicalRoot, home = homedir6()) {
  return resolveDetected(home).filter((p) => p !== canonicalRoot);
}

// dist/src/skillify/pull.js
function assertValidAuthor(author) {
  if (!author)
    throw new Error("author is empty");
  if (author.length > 64)
    throw new Error(`author too long (${author.length}): ${author.slice(0, 32)}\u2026`);
  if (!/^[A-Za-z0-9_.\-@]+$/.test(author)) {
    throw new Error(`author contains invalid characters: ${author}`);
  }
}
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function buildPullSql(args) {
  const where = [];
  if (args.users.length > 0) {
    const list = args.users.map((u) => `'${esc(u)}'`).join(", ");
    where.push(`author IN (${list})`);
  }
  if (args.skillName) {
    where.push(`name = '${esc(args.skillName)}'`);
  }
  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const contributorsCol = args.includeContributors === false ? "" : "contributors, ";
  return `SELECT name, project, project_key, body, version, source_agent, scope, author, ${contributorsCol}description, trigger_text, source_sessions, install, created_at, updated_at FROM "${args.tableName}"${whereClause} ORDER BY project_key ASC, name ASC, version DESC`;
}
function isMissingContributorsColumnError(message) {
  if (!message)
    return false;
  return /contributors.*(?:does not exist|not found|unknown)/i.test(message) || /(?:does not exist|unknown column).*contributors/i.test(message);
}
function isMissingTableError(message) {
  if (!message)
    return false;
  if (/\bcolumn\b/i.test(message))
    return false;
  return /Table does not exist|relation .* does not exist|no such table/i.test(message);
}
function resolvePullDestination(install, cwd) {
  if (install === "global")
    return join8(homedir7(), ".claude", "skills");
  if (!cwd)
    throw new Error("install=project requires a cwd");
  return join8(cwd, ".claude", "skills");
}
function fanOutSymlinks(canonicalDir, dirName, agentRoots) {
  const out = [];
  for (const root of agentRoots) {
    const link = join8(root, dirName);
    let existing;
    try {
      existing = lstatSync2(link);
    } catch {
      existing = null;
    }
    if (existing) {
      if (!existing.isSymbolicLink()) {
        continue;
      }
      let current;
      try {
        current = readlinkSync(link);
      } catch {
        current = null;
      }
      if (current === canonicalDir) {
        out.push(link);
        continue;
      }
      try {
        unlinkSync2(link);
      } catch {
        continue;
      }
    }
    try {
      mkdirSync4(dirname2(link), { recursive: true });
      symlinkSync(canonicalDir, link, "dir");
      out.push(link);
    } catch {
    }
  }
  return out;
}
function backfillSymlinks(installRoot) {
  const manifest = loadManifest();
  const entries = entriesForRoot(manifest, "global", installRoot);
  if (entries.length === 0)
    return;
  const detected = detectAgentSkillsRoots(installRoot);
  for (const entry of entries) {
    const canonical = join8(entry.installRoot, entry.dirName);
    if (!existsSync7(canonical))
      continue;
    const fresh = fanOutSymlinks(canonical, entry.dirName, detected);
    if (sameSorted(fresh, entry.symlinks))
      continue;
    try {
      recordPull({ ...entry, symlinks: fresh });
    } catch {
    }
  }
}
function sameSorted(a, b) {
  if (a.length !== b.length)
    return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++)
    if (sa[i] !== sb[i])
      return false;
  return true;
}
function selectLatestPerName(rows) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const r of rows) {
    const name = String(r.name ?? "");
    const projectKey = String(r.project_key ?? "");
    if (!name)
      continue;
    const key = `${projectKey}\0${name}`;
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
function renderSkillFile(row) {
  const sources = parseSourceSessions(row.source_sessions);
  const author = typeof row.author === "string" && row.author.length > 0 ? row.author : void 0;
  const contributors = parseContributors(row.contributors);
  const renderedContributors = contributors.length > 0 ? contributors : author ? [author] : [];
  const fm = {
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    trigger: typeof row.trigger_text === "string" && row.trigger_text.length > 0 ? String(row.trigger_text) : void 0,
    author,
    source_sessions: sources,
    contributors: renderedContributors,
    version: Number(row.version ?? 1),
    created_by_agent: String(row.source_agent ?? "unknown"),
    created_at: String(row.created_at ?? (/* @__PURE__ */ new Date()).toISOString()),
    updated_at: String(row.updated_at ?? (/* @__PURE__ */ new Date()).toISOString())
  };
  const body = String(row.body ?? "").trim();
  return `${renderFrontmatter(fm)}

${body}
`;
}
function parseSourceSessions(v) {
  if (Array.isArray(v))
    return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed))
        return parsed.map(String);
    } catch {
    }
  }
  return [];
}
function parseContributors(v) {
  if (Array.isArray(v))
    return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed))
        return parsed.map(String);
    } catch {
    }
  }
  return [];
}
function renderFrontmatter(fm) {
  const lines = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${JSON.stringify(fm.description)}`);
  if (fm.trigger)
    lines.push(`trigger: ${JSON.stringify(fm.trigger)}`);
  if (fm.author)
    lines.push(`author: ${fm.author}`);
  lines.push(`source_sessions:`);
  for (const s of fm.source_sessions)
    lines.push(`  - ${s}`);
  if (fm.contributors && fm.contributors.length > 0) {
    lines.push(`contributors:`);
    for (const c of fm.contributors)
      lines.push(`  - ${c}`);
  }
  lines.push(`version: ${fm.version}`);
  lines.push(`created_by_agent: ${fm.created_by_agent}`);
  lines.push(`created_at: ${fm.created_at}`);
  lines.push(`updated_at: ${fm.updated_at}`);
  lines.push("---");
  return lines.join("\n");
}
function readLocalVersion(path) {
  if (!existsSync7(path))
    return null;
  try {
    const text = readFileSync5(path, "utf-8");
    const parsed = parseFrontmatter(text);
    if (!parsed)
      return null;
    const v = parsed.fm.version;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}
function decideAction(args) {
  const shouldWrite = args.localVersion === null || args.remoteVersion > args.localVersion || args.force;
  if (!shouldWrite)
    return "skipped";
  return args.dryRun ? "dryrun" : "wrote";
}
async function runPull(opts) {
  if (!opts.dryRun)
    pruneOrphanedEntries();
  const sql = buildPullSql({
    tableName: opts.tableName,
    users: opts.users,
    skillName: opts.skillName
  });
  let rows = [];
  try {
    rows = await opts.query(sql);
  } catch (e) {
    if (isMissingTableError(e?.message)) {
      rows = [];
    } else if (isMissingContributorsColumnError(e?.message)) {
      const legacySql = buildPullSql({
        tableName: opts.tableName,
        users: opts.users,
        skillName: opts.skillName,
        includeContributors: false
      });
      rows = await opts.query(legacySql);
    } else {
      throw e;
    }
  }
  const latest = selectLatestPerName(rows);
  const root = resolvePullDestination(opts.install, opts.cwd);
  const summary = { scanned: latest.length, wrote: 0, skipped: 0, dryrun: 0, entries: [] };
  for (const row of latest) {
    const name = String(row.name ?? "");
    if (!name)
      continue;
    try {
      assertValidSkillName(name);
    } catch (e) {
      summary.entries.push({
        name,
        remoteVersion: Number(row.version ?? 1),
        localVersion: null,
        action: "skipped",
        destination: "(invalid name \u2014 skipped)",
        author: String(row.author ?? ""),
        sourceAgent: String(row.source_agent ?? "")
      });
      summary.skipped++;
      continue;
    }
    const author = String(row.author ?? "");
    if (!author) {
      summary.entries.push({
        name,
        remoteVersion: Number(row.version ?? 1),
        localVersion: null,
        action: "skipped",
        destination: "(empty author \u2014 skipped)",
        author: "",
        sourceAgent: String(row.source_agent ?? "")
      });
      summary.skipped++;
      continue;
    }
    let dirName;
    try {
      assertValidAuthor(author);
      dirName = `${name}--${author}`;
    } catch (e) {
      summary.entries.push({
        name,
        remoteVersion: Number(row.version ?? 1),
        localVersion: null,
        action: "skipped",
        destination: `(invalid author '${author}' \u2014 skipped)`,
        author,
        sourceAgent: String(row.source_agent ?? "")
      });
      summary.skipped++;
      continue;
    }
    const skillDir = join8(root, dirName);
    const skillFile = join8(skillDir, "SKILL.md");
    const remoteVersion = Number(row.version ?? 1);
    const localVersion = readLocalVersion(skillFile);
    const action = decideAction({
      remoteVersion,
      localVersion,
      force: opts.force ?? false,
      dryRun: opts.dryRun ?? false
    });
    let manifestError;
    if (action === "wrote") {
      mkdirSync4(skillDir, { recursive: true });
      if (existsSync7(skillFile)) {
        try {
          renameSync3(skillFile, `${skillFile}.bak`);
        } catch {
        }
      }
      writeFileSync4(skillFile, renderSkillFile(row));
      const symlinks = opts.install === "global" ? fanOutSymlinks(skillDir, dirName, detectAgentSkillsRoots(root)) : [];
      try {
        recordPull({
          dirName,
          name,
          author,
          projectKey: String(row.project_key ?? ""),
          remoteVersion,
          install: opts.install,
          installRoot: root,
          pulledAt: (/* @__PURE__ */ new Date()).toISOString(),
          symlinks
        });
      } catch (e) {
        manifestError = e?.message ?? String(e);
      }
    }
    summary.entries.push({
      name,
      remoteVersion,
      localVersion,
      action,
      destination: skillFile,
      author: String(row.author ?? ""),
      sourceAgent: String(row.source_agent ?? ""),
      manifestError
    });
    if (action === "wrote")
      summary.wrote++;
    else if (action === "dryrun")
      summary.dryrun++;
    else
      summary.skipped++;
  }
  if (!opts.dryRun && opts.install === "global") {
    backfillSymlinks(root);
  }
  return summary;
}

// dist/src/skillify/auto-pull.js
var log3 = (msg) => log("skillify-autopull", msg);
var DEFAULT_TIMEOUT_MS = 5e3;
function withTimeout(p, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`autopull timeout after ${ms}ms`)), ms);
    if (typeof timer.unref === "function")
      timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer)
      clearTimeout(timer);
  });
}
async function autoPullSkills(deps = {}) {
  if (process.env.HIVEMIND_AUTOPULL_DISABLED === "1") {
    log3("disabled via HIVEMIND_AUTOPULL_DISABLED=1");
    return { pulled: 0, skipped: true, reason: "disabled" };
  }
  const loadFn = deps.loadConfigFn ?? loadConfig;
  const config = loadFn();
  if (!config) {
    log3("skipped: not logged in");
    return { pulled: 0, skipped: true, reason: "not-logged-in" };
  }
  let query;
  if (deps.queryFn) {
    query = deps.queryFn;
  } else {
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.skillsTableName);
    query = (sql) => api.query(sql);
  }
  const install = deps.install ?? "global";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const summary = await withTimeout(runPull({
      query,
      tableName: config.skillsTableName,
      install,
      cwd: install === "project" ? deps.cwd ?? process.cwd() : void 0,
      users: [],
      dryRun: false,
      force: false
    }), timeoutMs);
    log3(`pulled scanned=${summary.scanned} wrote=${summary.wrote} skipped=${summary.skipped}`);
    return { pulled: summary.wrote, skipped: false };
  } catch (e) {
    log3(`pull failed (swallowed): ${e?.message ?? e}`);
    return { pulled: 0, skipped: true, reason: "error" };
  }
}

// dist/src/skillify/autopull-worker.js
void (async () => {
  try {
    await autoPullSkills();
  } catch {
  }
})();
