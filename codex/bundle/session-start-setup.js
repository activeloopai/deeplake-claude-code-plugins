#!/usr/bin/env node

// dist/src/hooks/codex/session-start-setup.js
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname3, join as join7 } from "node:path";
import { mkdirSync as mkdirSync5, appendFileSync as appendFileSync3 } from "node:fs";
import { execSync as execSync2 } from "node:child_process";
import { homedir as homedir6 } from "node:os";

// dist/src/commands/auth.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
var CONFIG_DIR = join(homedir(), ".deeplake");
var CREDS_PATH = join(CONFIG_DIR, "credentials.json");
function loadCredentials() {
  if (!existsSync(CREDS_PATH))
    return null;
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
  } catch {
    return null;
  }
}
function saveCredentials(creds) {
  if (!existsSync(CONFIG_DIR))
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync(CREDS_PATH, JSON.stringify({ ...creds, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), { mode: 384 });
}

// dist/src/config.js
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2, userInfo } from "node:os";
function loadConfig() {
  const home = homedir2();
  const credPath = join2(home, ".deeplake", "credentials.json");
  let creds = null;
  if (existsSync2(credPath)) {
    try {
      creds = JSON.parse(readFileSync2(credPath, "utf-8"));
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
    graphNodesTableName: env.HIVEMIND_GRAPH_NODES_TABLE ?? env.DEEPLAKE_GRAPH_NODES_TABLE ?? "graph_nodes",
    graphEdgesTableName: env.HIVEMIND_GRAPH_EDGES_TABLE ?? env.DEEPLAKE_GRAPH_EDGES_TABLE ?? "graph_edges",
    factsTableName: env.HIVEMIND_FACTS_TABLE ?? env.DEEPLAKE_FACTS_TABLE ?? "memory_facts",
    entitiesTableName: env.HIVEMIND_ENTITIES_TABLE ?? env.DEEPLAKE_ENTITIES_TABLE ?? "memory_entities",
    factEntityLinksTableName: env.HIVEMIND_FACT_ENTITY_LINKS_TABLE ?? env.DEEPLAKE_FACT_ENTITY_LINKS_TABLE ?? "fact_entity_links",
    memoryPath: env.HIVEMIND_MEMORY_PATH ?? env.DEEPLAKE_MEMORY_PATH ?? join2(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
import { tmpdir } from "node:os";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var DEBUG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var LOG = join3(homedir3(), ".deeplake", "hook-debug.log");
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
var DeeplakeQueryError = class extends Error {
  sqlSummary;
  status;
  responseBody;
  sql;
  cause;
  constructor(message, args = {}) {
    super(message);
    this.name = "DeeplakeQueryError";
    this.sql = args.sql;
    this.sqlSummary = args.sql ? summarizeSql(args.sql) : "";
    this.status = args.status;
    this.responseBody = args.responseBody;
    this.cause = args.cause;
  }
};
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
function isSessionInsertQuery(sql) {
  return /^\s*insert\s+into\s+"[^"]+"\s*\(\s*id\s*,\s*path\s*,\s*filename\s*,\s*message\s*,/i.test(sql);
}
function isTransientHtml403(text) {
  const body = text.toLowerCase();
  return body.includes("<html") || body.includes("403 forbidden") || body.includes("cloudflare") || body.includes("nginx");
}
function getIndexMarkerDir() {
  return process.env["HIVEMIND_INDEX_MARKER_DIR"] ?? join4(tmpdir(), "hivemind-deeplake-indexes");
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
          lastError = new DeeplakeQueryError(`Query timeout after ${QUERY_TIMEOUT_MS}ms`, { sql, cause: e });
          throw lastError;
        }
        lastError = e instanceof Error ? new DeeplakeQueryError(e.message, { sql, cause: e }) : new DeeplakeQueryError(String(e), { sql, cause: e });
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
      if (attempt < MAX_RETRIES && (RETRYABLE_CODES.has(resp.status) || retryable403)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
        log2(`query retry ${attempt + 1}/${MAX_RETRIES} (${resp.status}) in ${delay.toFixed(0)}ms`);
        await sleep(delay);
        continue;
      }
      throw new DeeplakeQueryError(`Query failed: ${resp.status}: ${text.slice(0, 200)}`, {
        sql,
        status: resp.status,
        responseBody: text.slice(0, 4e3)
      });
    }
    throw lastError ?? new DeeplakeQueryError("Query failed: max retries exceeded", { sql });
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
  /** Create the standard BM25 summary index for a memory table. */
  async createSummaryBm25Index(tableName) {
    const table = tableName ?? this.tableName;
    const indexName = this.buildLookupIndexName(table, "summary_bm25");
    await this.query(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" USING deeplake_index ("summary")`);
  }
  /** Ensure the standard BM25 summary index exists, using a local freshness marker to avoid repeated CREATEs. */
  async ensureSummaryBm25Index(tableName) {
    const table = tableName ?? this.tableName;
    const suffix = "summary_bm25";
    if (this.hasFreshLookupIndexMarker(table, suffix))
      return;
    try {
      await this.createSummaryBm25Index(table);
      this.markLookupIndexReady(table, suffix);
    } catch (e) {
      if (isDuplicateIndexError(e)) {
        this.markLookupIndexReady(table, suffix);
        return;
      }
      throw e;
    }
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
    return join4(getIndexMarkerDir(), `${markerKey}.json`);
  }
  hasFreshLookupIndexMarker(table, suffix) {
    const markerPath = this.getLookupIndexMarkerPath(table, suffix);
    if (!existsSync3(markerPath))
      return false;
    try {
      const raw = JSON.parse(readFileSync3(markerPath, "utf-8"));
      const updatedAt = raw.updatedAt ? new Date(raw.updatedAt).getTime() : NaN;
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > INDEX_MARKER_TTL_MS)
        return false;
      return true;
    } catch {
      return false;
    }
  }
  markLookupIndexReady(table, suffix) {
    mkdirSync2(getIndexMarkerDir(), { recursive: true });
    writeFileSync2(this.getLookupIndexMarkerPath(table, suffix), JSON.stringify({ updatedAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf-8");
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
  /** Create the sessions table (one physical row per message/event, with direct search columns). */
  async ensureSessionsTable(name) {
    const sessionColumns = [
      `id TEXT NOT NULL DEFAULT ''`,
      `path TEXT NOT NULL DEFAULT ''`,
      `filename TEXT NOT NULL DEFAULT ''`,
      `message JSONB`,
      `session_id TEXT NOT NULL DEFAULT ''`,
      `event_type TEXT NOT NULL DEFAULT ''`,
      `turn_index BIGINT NOT NULL DEFAULT 0`,
      `dia_id TEXT NOT NULL DEFAULT ''`,
      `speaker TEXT NOT NULL DEFAULT ''`,
      `text TEXT NOT NULL DEFAULT ''`,
      `turn_summary TEXT NOT NULL DEFAULT ''`,
      `source_date_time TEXT NOT NULL DEFAULT ''`,
      `author TEXT NOT NULL DEFAULT ''`,
      `mime_type TEXT NOT NULL DEFAULT 'application/json'`,
      `size_bytes BIGINT NOT NULL DEFAULT 0`,
      `project TEXT NOT NULL DEFAULT ''`,
      `description TEXT NOT NULL DEFAULT ''`,
      `agent TEXT NOT NULL DEFAULT ''`,
      `creation_date TEXT NOT NULL DEFAULT ''`,
      `last_update_date TEXT NOT NULL DEFAULT ''`
    ];
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      log2(`table "${name}" not found, creating`);
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (` + sessionColumns.join(", ") + `) USING deeplake`);
      log2(`table "${name}" created`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    const alterColumns = [
      ["session_id", `TEXT NOT NULL DEFAULT ''`],
      ["event_type", `TEXT NOT NULL DEFAULT ''`],
      ["turn_index", `BIGINT NOT NULL DEFAULT 0`],
      ["dia_id", `TEXT NOT NULL DEFAULT ''`],
      ["speaker", `TEXT NOT NULL DEFAULT ''`],
      ["text", `TEXT NOT NULL DEFAULT ''`],
      ["turn_summary", `TEXT NOT NULL DEFAULT ''`],
      ["source_date_time", `TEXT NOT NULL DEFAULT ''`]
    ];
    for (const [column, ddl] of alterColumns) {
      try {
        await this.query(`ALTER TABLE "${name}" ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
      } catch {
      }
    }
    await this.ensureLookupIndex(name, "path_creation_date_turn_index", `("path", "creation_date", "turn_index")`);
  }
  async ensureGraphNodesTable(name) {
    const columns = [
      `id TEXT NOT NULL DEFAULT ''`,
      `path TEXT NOT NULL DEFAULT ''`,
      `filename TEXT NOT NULL DEFAULT ''`,
      `node_id TEXT NOT NULL DEFAULT ''`,
      `canonical_name TEXT NOT NULL DEFAULT ''`,
      `node_type TEXT NOT NULL DEFAULT ''`,
      `summary TEXT NOT NULL DEFAULT ''`,
      `search_text TEXT NOT NULL DEFAULT ''`,
      `aliases TEXT NOT NULL DEFAULT ''`,
      `source_session_id TEXT NOT NULL DEFAULT ''`,
      `source_session_ids TEXT NOT NULL DEFAULT ''`,
      `source_path TEXT NOT NULL DEFAULT ''`,
      `source_paths TEXT NOT NULL DEFAULT ''`,
      `author TEXT NOT NULL DEFAULT ''`,
      `mime_type TEXT NOT NULL DEFAULT 'application/json'`,
      `size_bytes BIGINT NOT NULL DEFAULT 0`,
      `project TEXT NOT NULL DEFAULT ''`,
      `description TEXT NOT NULL DEFAULT ''`,
      `agent TEXT NOT NULL DEFAULT ''`,
      `creation_date TEXT NOT NULL DEFAULT ''`,
      `last_update_date TEXT NOT NULL DEFAULT ''`
    ];
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (${columns.join(", ")}) USING deeplake`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    for (const [column, ddl] of [
      ["source_session_ids", `TEXT NOT NULL DEFAULT ''`],
      ["source_paths", `TEXT NOT NULL DEFAULT ''`]
    ]) {
      try {
        await this.query(`ALTER TABLE "${name}" ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
      } catch {
      }
    }
    await this.ensureLookupIndex(name, "source_session_id", `("source_session_id")`);
    await this.ensureLookupIndex(name, "node_id", `("node_id")`);
  }
  async ensureGraphEdgesTable(name) {
    const columns = [
      `id TEXT NOT NULL DEFAULT ''`,
      `path TEXT NOT NULL DEFAULT ''`,
      `filename TEXT NOT NULL DEFAULT ''`,
      `edge_id TEXT NOT NULL DEFAULT ''`,
      `source_node_id TEXT NOT NULL DEFAULT ''`,
      `target_node_id TEXT NOT NULL DEFAULT ''`,
      `relation TEXT NOT NULL DEFAULT ''`,
      `summary TEXT NOT NULL DEFAULT ''`,
      `evidence TEXT NOT NULL DEFAULT ''`,
      `search_text TEXT NOT NULL DEFAULT ''`,
      `source_session_id TEXT NOT NULL DEFAULT ''`,
      `source_session_ids TEXT NOT NULL DEFAULT ''`,
      `source_path TEXT NOT NULL DEFAULT ''`,
      `source_paths TEXT NOT NULL DEFAULT ''`,
      `author TEXT NOT NULL DEFAULT ''`,
      `mime_type TEXT NOT NULL DEFAULT 'application/json'`,
      `size_bytes BIGINT NOT NULL DEFAULT 0`,
      `project TEXT NOT NULL DEFAULT ''`,
      `description TEXT NOT NULL DEFAULT ''`,
      `agent TEXT NOT NULL DEFAULT ''`,
      `creation_date TEXT NOT NULL DEFAULT ''`,
      `last_update_date TEXT NOT NULL DEFAULT ''`
    ];
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (${columns.join(", ")}) USING deeplake`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    for (const [column, ddl] of [
      ["source_session_ids", `TEXT NOT NULL DEFAULT ''`],
      ["source_paths", `TEXT NOT NULL DEFAULT ''`]
    ]) {
      try {
        await this.query(`ALTER TABLE "${name}" ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
      } catch {
      }
    }
    await this.ensureLookupIndex(name, "source_session_id", `("source_session_id")`);
    await this.ensureLookupIndex(name, "source_target_relation", `("source_node_id", "target_node_id", "relation")`);
  }
  async ensureFactsTable(name) {
    const columns = [
      `id TEXT NOT NULL DEFAULT ''`,
      `path TEXT NOT NULL DEFAULT ''`,
      `filename TEXT NOT NULL DEFAULT ''`,
      `fact_id TEXT NOT NULL DEFAULT ''`,
      `subject_entity_id TEXT NOT NULL DEFAULT ''`,
      `subject_name TEXT NOT NULL DEFAULT ''`,
      `subject_type TEXT NOT NULL DEFAULT ''`,
      `predicate TEXT NOT NULL DEFAULT ''`,
      `object_entity_id TEXT NOT NULL DEFAULT ''`,
      `object_name TEXT NOT NULL DEFAULT ''`,
      `object_type TEXT NOT NULL DEFAULT ''`,
      `summary TEXT NOT NULL DEFAULT ''`,
      `evidence TEXT NOT NULL DEFAULT ''`,
      `search_text TEXT NOT NULL DEFAULT ''`,
      `confidence TEXT NOT NULL DEFAULT ''`,
      `valid_at TEXT NOT NULL DEFAULT ''`,
      `valid_from TEXT NOT NULL DEFAULT ''`,
      `valid_to TEXT NOT NULL DEFAULT ''`,
      `source_session_id TEXT NOT NULL DEFAULT ''`,
      `source_path TEXT NOT NULL DEFAULT ''`,
      `author TEXT NOT NULL DEFAULT ''`,
      `mime_type TEXT NOT NULL DEFAULT 'application/json'`,
      `size_bytes BIGINT NOT NULL DEFAULT 0`,
      `project TEXT NOT NULL DEFAULT ''`,
      `description TEXT NOT NULL DEFAULT ''`,
      `agent TEXT NOT NULL DEFAULT ''`,
      `creation_date TEXT NOT NULL DEFAULT ''`,
      `last_update_date TEXT NOT NULL DEFAULT ''`
    ];
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (${columns.join(", ")}) USING deeplake`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    await this.ensureLookupIndex(name, "fact_id", `("fact_id")`);
    await this.ensureLookupIndex(name, "session_predicate", `("source_session_id", "predicate")`);
    await this.ensureLookupIndex(name, "subject_object", `("subject_entity_id", "object_entity_id")`);
  }
  async ensureEntitiesTable(name) {
    const columns = [
      `id TEXT NOT NULL DEFAULT ''`,
      `path TEXT NOT NULL DEFAULT ''`,
      `filename TEXT NOT NULL DEFAULT ''`,
      `entity_id TEXT NOT NULL DEFAULT ''`,
      `canonical_name TEXT NOT NULL DEFAULT ''`,
      `entity_type TEXT NOT NULL DEFAULT ''`,
      `aliases TEXT NOT NULL DEFAULT ''`,
      `summary TEXT NOT NULL DEFAULT ''`,
      `search_text TEXT NOT NULL DEFAULT ''`,
      `source_session_ids TEXT NOT NULL DEFAULT ''`,
      `source_paths TEXT NOT NULL DEFAULT ''`,
      `author TEXT NOT NULL DEFAULT ''`,
      `mime_type TEXT NOT NULL DEFAULT 'application/json'`,
      `size_bytes BIGINT NOT NULL DEFAULT 0`,
      `project TEXT NOT NULL DEFAULT ''`,
      `description TEXT NOT NULL DEFAULT ''`,
      `agent TEXT NOT NULL DEFAULT ''`,
      `creation_date TEXT NOT NULL DEFAULT ''`,
      `last_update_date TEXT NOT NULL DEFAULT ''`
    ];
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (${columns.join(", ")}) USING deeplake`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    await this.ensureLookupIndex(name, "entity_id", `("entity_id")`);
    await this.ensureLookupIndex(name, "canonical_name", `("canonical_name")`);
  }
  async ensureFactEntityLinksTable(name) {
    const columns = [
      `id TEXT NOT NULL DEFAULT ''`,
      `path TEXT NOT NULL DEFAULT ''`,
      `filename TEXT NOT NULL DEFAULT ''`,
      `link_id TEXT NOT NULL DEFAULT ''`,
      `fact_id TEXT NOT NULL DEFAULT ''`,
      `entity_id TEXT NOT NULL DEFAULT ''`,
      `entity_role TEXT NOT NULL DEFAULT ''`,
      `source_session_id TEXT NOT NULL DEFAULT ''`,
      `source_path TEXT NOT NULL DEFAULT ''`,
      `author TEXT NOT NULL DEFAULT ''`,
      `mime_type TEXT NOT NULL DEFAULT 'application/json'`,
      `size_bytes BIGINT NOT NULL DEFAULT 0`,
      `project TEXT NOT NULL DEFAULT ''`,
      `description TEXT NOT NULL DEFAULT ''`,
      `agent TEXT NOT NULL DEFAULT ''`,
      `creation_date TEXT NOT NULL DEFAULT ''`,
      `last_update_date TEXT NOT NULL DEFAULT ''`
    ];
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (${columns.join(", ")}) USING deeplake`);
      if (!tables.includes(name))
        this._tablesCache = [...tables, name];
    }
    await this.ensureLookupIndex(name, "fact_id", `("fact_id")`);
    await this.ensureLookupIndex(name, "entity_id", `("entity_id")`);
    await this.ensureLookupIndex(name, "session_entity_role", `("source_session_id", "entity_id", "entity_role")`);
  }
};

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

// dist/src/hooks/session-queue.js
import { appendFileSync as appendFileSync2, closeSync, existsSync as existsSync4, mkdirSync as mkdirSync3, openSync, readFileSync as readFileSync4, readdirSync, renameSync, rmSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname, join as join5 } from "node:path";
import { homedir as homedir4 } from "node:os";
var DEFAULT_QUEUE_DIR = join5(homedir4(), ".deeplake", "queue");
var DEFAULT_MAX_BATCH_ROWS = 50;
var DEFAULT_STALE_INFLIGHT_MS = 6e4;
var DEFAULT_AUTH_FAILURE_TTL_MS = 5 * 6e4;
var DEFAULT_DRAIN_LOCK_STALE_MS = 3e4;
var BUSY_WAIT_STEP_MS = 100;
var SessionWriteDisabledError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionWriteDisabledError";
  }
};
function buildSessionInsertSql(sessionsTable, rows) {
  if (rows.length === 0)
    throw new Error("buildSessionInsertSql: rows must not be empty");
  const table = sqlIdent(sessionsTable);
  const values = rows.map((row) => {
    const jsonForSql = escapeJsonbLiteral(coerceJsonbPayload(row.message));
    return `('${sqlStr(row.id)}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', '${jsonForSql}'::jsonb, '${sqlStr(row.sessionId)}', '${sqlStr(row.eventType)}', ${row.turnIndex}, '${sqlStr(row.diaId)}', '${sqlStr(row.speaker)}', '${sqlStr(row.text)}', '${sqlStr(row.turnSummary)}', '${sqlStr(row.sourceDateTime)}', '${sqlStr(row.author)}', ${row.sizeBytes}, '${sqlStr(row.project)}', '${sqlStr(row.description)}', '${sqlStr(row.agent)}', '${sqlStr(row.creationDate)}', '${sqlStr(row.lastUpdateDate)}')`;
  }).join(", ");
  return `INSERT INTO "${table}" (id, path, filename, message, session_id, event_type, turn_index, dia_id, speaker, text, turn_summary, source_date_time, author, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${values}`;
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
function escapeJsonbLiteral(value) {
  return value.replace(/'/g, "''").replace(/\0/g, "");
}
async function flushSessionQueue(api, opts) {
  const queueDir = opts.queueDir ?? DEFAULT_QUEUE_DIR;
  const maxBatchRows = opts.maxBatchRows ?? DEFAULT_MAX_BATCH_ROWS;
  const staleInflightMs = opts.staleInflightMs ?? DEFAULT_STALE_INFLIGHT_MS;
  const waitIfBusyMs = opts.waitIfBusyMs ?? 0;
  const drainAll = opts.drainAll ?? false;
  mkdirSync3(queueDir, { recursive: true });
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
      renameSync(queuePath, inflightPath);
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
async function drainSessionQueues(api, opts) {
  const queueDir = opts.queueDir ?? DEFAULT_QUEUE_DIR;
  mkdirSync3(queueDir, { recursive: true });
  const sessionIds = listQueuedSessionIds(queueDir, opts.staleInflightMs ?? DEFAULT_STALE_INFLIGHT_MS);
  let flushedSessions = 0;
  let rows = 0;
  let batches = 0;
  for (const sessionId of sessionIds) {
    const result = await flushSessionQueue(api, {
      sessionId,
      sessionsTable: opts.sessionsTable,
      queueDir,
      maxBatchRows: opts.maxBatchRows,
      allowStaleInflight: true,
      staleInflightMs: opts.staleInflightMs,
      drainAll: true
    });
    if (result.status === "flushed") {
      flushedSessions += 1;
      rows += result.rows;
      batches += result.batches;
    }
  }
  return {
    queuedSessions: sessionIds.length,
    flushedSessions,
    rows,
    batches
  };
}
function tryAcquireSessionDrainLock(sessionsTable, queueDir = DEFAULT_QUEUE_DIR, staleMs = DEFAULT_DRAIN_LOCK_STALE_MS) {
  mkdirSync3(queueDir, { recursive: true });
  const lockPath = getSessionDrainLockPath(queueDir, sessionsTable);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (e) {
      if (e?.code !== "EEXIST")
        throw e;
      if (existsSync4(lockPath) && isStale(lockPath, staleMs)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}
function getQueuePath(queueDir, sessionId) {
  return join5(queueDir, `${sessionId}.jsonl`);
}
function getInflightPath(queueDir, sessionId) {
  return join5(queueDir, `${sessionId}.inflight`);
}
async function flushInflightFile(api, sessionsTable, inflightPath, maxBatchRows) {
  const rows = readQueuedRows(inflightPath);
  if (rows.length === 0) {
    rmSync(inflightPath, { force: true });
    return { rows: 0, batches: 0 };
  }
  let ensured = false;
  let batches = 0;
  const queueDir = dirname(inflightPath);
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
  appendFileSync2(queuePath, inflight);
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
function listQueuedSessionIds(queueDir, staleInflightMs) {
  const sessionIds = /* @__PURE__ */ new Set();
  for (const name of readdirSync(queueDir)) {
    if (name.endsWith(".jsonl")) {
      sessionIds.add(name.slice(0, -".jsonl".length));
    } else if (name.endsWith(".inflight")) {
      const path = join5(queueDir, name);
      if (isStale(path, staleInflightMs)) {
        sessionIds.add(name.slice(0, -".inflight".length));
      }
    }
  }
  return [...sessionIds].sort();
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
  mkdirSync3(queueDir, { recursive: true });
  writeFileSync3(getSessionWriteDisabledPath(queueDir, sessionsTable), JSON.stringify({
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
  return join5(queueDir, `.${sessionsTable}.disabled.json`);
}
function getSessionDrainLockPath(queueDir, sessionsTable) {
  return join5(queueDir, `.${sessionsTable}.drain.lock`);
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

// dist/src/hooks/version-check.js
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";
import { homedir as homedir5 } from "node:os";
var DEFAULT_VERSION_CACHE_PATH = join6(homedir5(), ".deeplake", ".version-check.json");
var DEFAULT_VERSION_CACHE_TTL_MS = 60 * 60 * 1e3;
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join6(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync5(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join6(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync5(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version)
        return pkg.version;
    } catch {
    }
    const parent = dirname2(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}
function isNewer(latest, current) {
  const parse = (v) => v.replace(/-.*$/, "").split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || la === ca && lb > cb || la === ca && lb === cb && lc > cc;
}
function readVersionCache(cachePath = DEFAULT_VERSION_CACHE_PATH) {
  if (!existsSync5(cachePath))
    return null;
  try {
    const parsed = JSON.parse(readFileSync5(cachePath, "utf-8"));
    if (parsed && typeof parsed.checkedAt === "number" && typeof parsed.url === "string" && (typeof parsed.latest === "string" || parsed.latest === null)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function writeVersionCache(entry, cachePath = DEFAULT_VERSION_CACHE_PATH) {
  mkdirSync4(dirname2(cachePath), { recursive: true });
  writeFileSync4(cachePath, JSON.stringify(entry));
}
function readFreshCachedLatestVersion(url, ttlMs = DEFAULT_VERSION_CACHE_TTL_MS, cachePath = DEFAULT_VERSION_CACHE_PATH, nowMs = Date.now()) {
  const cached = readVersionCache(cachePath);
  if (!cached || cached.url !== url)
    return void 0;
  if (nowMs - cached.checkedAt > ttlMs)
    return void 0;
  return cached.latest;
}
async function getLatestVersionCached(opts) {
  const ttlMs = opts.ttlMs ?? DEFAULT_VERSION_CACHE_TTL_MS;
  const cachePath = opts.cachePath ?? DEFAULT_VERSION_CACHE_PATH;
  const nowMs = opts.nowMs ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fresh = readFreshCachedLatestVersion(opts.url, ttlMs, cachePath, nowMs);
  if (fresh !== void 0)
    return fresh;
  const stale = readVersionCache(cachePath);
  try {
    const res = await fetchImpl(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs) });
    const latest = res.ok ? (await res.json()).version ?? null : stale?.latest ?? null;
    writeVersionCache({
      checkedAt: nowMs,
      latest,
      url: opts.url
    }, cachePath);
    return latest;
  } catch {
    const latest = stale?.latest ?? null;
    writeVersionCache({
      checkedAt: nowMs,
      latest,
      url: opts.url
    }, cachePath);
    return latest;
  }
}

// dist/src/hooks/codex/session-start-setup.js
var log3 = (msg) => log("codex-session-setup", msg);
var __bundleDir = dirname3(fileURLToPath2(import.meta.url));
var GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
var VERSION_CHECK_TIMEOUT = 3e3;
var HOME = homedir6();
var WIKI_LOG = join7(HOME, ".codex", "hooks", "deeplake-wiki.log");
function wikiLog(msg) {
  try {
    mkdirSync5(join7(HOME, ".codex", "hooks"), { recursive: true });
    appendFileSync3(WIKI_LOG, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] ${msg}
`);
  } catch {
  }
}
async function createPlaceholder(api, table, sessionId, cwd, userName, orgName, workspaceId) {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;
  const existing = await api.query(`SELECT path FROM "${table}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`);
  if (existing.length > 0) {
    wikiLog(`SessionSetup: summary exists for ${sessionId} (resumed)`);
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const projectName = cwd.split("/").pop() || "unknown";
  const sessionSource = `/sessions/${userName}/${userName}_${orgName}_${workspaceId}_${sessionId}.jsonl`;
  const content = [
    `# Session ${sessionId}`,
    `- **Source**: ${sessionSource}`,
    `- **Started**: ${now}`,
    `- **Project**: ${projectName}`,
    `- **Status**: in-progress`,
    ""
  ].join("\n");
  const filename = `${sessionId}.md`;
  await api.query(`INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'codex', '${now}', '${now}')`);
  wikiLog(`SessionSetup: created placeholder for ${sessionId} (${cwd})`);
}
async function runCodexSessionStartSetup(input, deps = {}) {
  const { wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1", creds = loadCredentials(), saveCredentialsFn = saveCredentials, config = loadConfig(), createApi = (activeConfig) => new DeeplakeApi(activeConfig.token, activeConfig.apiUrl, activeConfig.orgId, activeConfig.workspaceId, activeConfig.tableName), captureEnabled = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false", drainSessionQueuesFn = drainSessionQueues, isSessionWriteDisabledFn = isSessionWriteDisabled, isSessionWriteAuthErrorFn = isSessionWriteAuthError, markSessionWriteDisabledFn = markSessionWriteDisabled, tryAcquireSessionDrainLockFn = tryAcquireSessionDrainLock, createPlaceholderFn = createPlaceholder, getInstalledVersionFn = getInstalledVersion, getLatestVersionCachedFn = getLatestVersionCached, isNewerFn = isNewer, execSyncFn = execSync2, logFn = log3, wikiLogFn = wikiLog } = deps;
  if (wikiWorker)
    return { status: "skipped" };
  if (!creds?.token) {
    logFn("no credentials");
    return { status: "no_credentials" };
  }
  if (!creds.userName) {
    try {
      const { userInfo: userInfo2 } = await import("node:os");
      creds.userName = userInfo2().username ?? "unknown";
      saveCredentialsFn(creds);
      logFn(`backfilled userName: ${creds.userName}`);
    } catch {
    }
  }
  if (input.session_id && config) {
    try {
      const api = createApi(config);
      await api.ensureTable();
      if (captureEnabled) {
        if (isSessionWriteDisabledFn(config.sessionsTableName)) {
          logFn(`sessions table disabled, skipping setup for "${config.sessionsTableName}"`);
        } else {
          const releaseDrainLock = tryAcquireSessionDrainLockFn(config.sessionsTableName);
          if (!releaseDrainLock) {
            logFn(`sessions drain already in progress, skipping duplicate setup for "${config.sessionsTableName}"`);
          } else {
            try {
              await api.ensureSessionsTable(config.sessionsTableName);
              await api.ensureGraphNodesTable(config.graphNodesTableName);
              await api.ensureGraphEdgesTable(config.graphEdgesTableName);
              await api.ensureFactsTable(config.factsTableName);
              await api.ensureEntitiesTable(config.entitiesTableName);
              await api.ensureFactEntityLinksTable(config.factEntityLinksTableName);
              const drain = await drainSessionQueuesFn(api, {
                sessionsTable: config.sessionsTableName
              });
              if (drain.flushedSessions > 0) {
                logFn(`drained ${drain.flushedSessions} queued session(s), rows=${drain.rows}, batches=${drain.batches}`);
              }
            } catch (e) {
              if (isSessionWriteAuthErrorFn(e)) {
                markSessionWriteDisabledFn(config.sessionsTableName, e.message);
                logFn(`sessions table unavailable, skipping setup: ${e.message}`);
              } else {
                throw e;
              }
            } finally {
              releaseDrainLock();
            }
          }
        }
        await createPlaceholderFn(api, config.tableName, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
      }
      logFn("setup complete");
    } catch (e) {
      logFn(`setup failed: ${e.message}`);
      wikiLogFn(`SessionSetup: failed for ${input.session_id}: ${e.message}`);
    }
  }
  const autoupdate = creds.autoupdate !== false;
  try {
    const current = getInstalledVersionFn(__bundleDir, ".codex-plugin");
    if (current) {
      const latest = await getLatestVersionCachedFn({
        url: GITHUB_RAW_PKG,
        timeoutMs: VERSION_CHECK_TIMEOUT
      });
      if (latest && isNewerFn(latest, current)) {
        if (autoupdate) {
          logFn(`autoupdate: updating ${current} \u2192 ${latest}`);
          try {
            const tag = `v${latest}`;
            if (!/^v\d+\.\d+\.\d+$/.test(tag))
              throw new Error(`unsafe version tag: ${tag}`);
            const findCmd = `INSTALL_DIR=""; CACHE_DIR=$(find ~/.codex/plugins/cache -maxdepth 3 -name "hivemind" -type d 2>/dev/null | head -1); if [ -n "$CACHE_DIR" ]; then INSTALL_DIR=$(ls -1d "$CACHE_DIR"/*/ 2>/dev/null | tail -1); elif [ -d ~/.codex/hivemind ]; then INSTALL_DIR=~/.codex/hivemind; fi; if [ -n "$INSTALL_DIR" ]; then TMPDIR=$(mktemp -d); git clone --depth 1 --branch ${tag} -q https://github.com/activeloopai/hivemind.git "$TMPDIR/hivemind" 2>/dev/null && cp -r "$TMPDIR/hivemind/codex/"* "$INSTALL_DIR/" 2>/dev/null; rm -rf "$TMPDIR"; fi`;
            execSyncFn(findCmd, { stdio: "ignore", timeout: 6e4 });
            process.stderr.write(`Hivemind auto-updated: ${current} \u2192 ${latest}. Restart Codex to apply.
`);
            logFn(`autoupdate succeeded: ${current} \u2192 ${latest} (tag: ${tag})`);
          } catch (e) {
            process.stderr.write(`Hivemind update available: ${current} \u2192 ${latest}. Auto-update failed.
`);
            logFn(`autoupdate failed: ${e.message}`);
          }
        } else {
          process.stderr.write(`Hivemind update available: ${current} \u2192 ${latest}.
`);
          logFn(`update available (autoupdate off): ${current} \u2192 ${latest}`);
        }
      } else {
        logFn(`version up to date: ${current}`);
      }
    }
  } catch (e) {
    logFn(`version check failed: ${e.message}`);
  }
  return { status: "complete" };
}
async function main() {
  const input = await readStdin();
  await runCodexSessionStartSetup(input);
}
if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    log3(`fatal: ${e.message}`);
    process.exit(0);
  });
}
export {
  createPlaceholder,
  runCodexSessionStartSetup,
  wikiLog
};
