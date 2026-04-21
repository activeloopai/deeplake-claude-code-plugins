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
    graphNodesTableName: env.HIVEMIND_GRAPH_NODES_TABLE ?? env.DEEPLAKE_GRAPH_NODES_TABLE ?? "graph_nodes",
    graphEdgesTableName: env.HIVEMIND_GRAPH_EDGES_TABLE ?? env.DEEPLAKE_GRAPH_EDGES_TABLE ?? "graph_edges",
    factsTableName: env.HIVEMIND_FACTS_TABLE ?? env.DEEPLAKE_FACTS_TABLE ?? "memory_facts",
    entitiesTableName: env.HIVEMIND_ENTITIES_TABLE ?? env.DEEPLAKE_ENTITIES_TABLE ?? "memory_entities",
    factEntityLinksTableName: env.HIVEMIND_FACT_ENTITY_LINKS_TABLE ?? env.DEEPLAKE_FACT_ENTITY_LINKS_TABLE ?? "fact_entity_links",
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

// dist/src/hooks/knowledge-graph.js
import { randomUUID as randomUUID3 } from "node:crypto";

// dist/src/hooks/upload-summary.js
import { randomUUID as randomUUID2 } from "node:crypto";

// dist/src/hooks/knowledge-graph.js
var GRAPH_PROMPT_TEMPLATE = `You are extracting a compact knowledge graph delta from a session summary.

SESSION ID: __SESSION_ID__
SOURCE PATH: __SOURCE_PATH__
PROJECT: __PROJECT__

SUMMARY MARKDOWN:
__SUMMARY_TEXT__

Return ONLY valid JSON with this exact shape:
{"nodes":[{"name":"canonical entity name","type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","summary":"short factual description","aliases":["optional alias"]}],"edges":[{"source":"canonical source entity","target":"canonical target entity","relation":"snake_case_relation","summary":"short factual relation summary","evidence":"short supporting phrase"}]}

Rules:
- Use canonical names for repeated entities.
- Include people, places, organizations, books/media, tools, files, goals, status labels, preferences, and notable events when they matter for future recall.
- Convert relationship/status/origin/preferences into edges when possible. Example relation shapes: home_country, relationship_status, enjoys, decided_to_pursue, works_on, uses_tool, located_in, recommended, plans, supports.
- Keep summaries short and factual. Do not invent facts beyond the summary.
- If a source or target appears in an edge but not in nodes, also include it in nodes.
- Prefer stable canonical names over pronouns.
- Return no markdown, no prose, no code fences, only JSON.`;

// dist/src/hooks/memory-facts.js
import { randomUUID as randomUUID4 } from "node:crypto";
var MEMORY_FACT_PROMPT_TEMPLATE = `You are extracting durable long-term memory facts from raw session transcript rows.

SESSION ID: __SESSION_ID__
SOURCE PATH: __SOURCE_PATH__
PROJECT: __PROJECT__

TRANSCRIPT ROWS:
__TRANSCRIPT_TEXT__

Return ONLY valid JSON with this exact shape:
{"facts":[{"subject":"canonical entity","subject_type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","subject_aliases":["optional alias"],"predicate":"snake_case_relation","object":"canonical object text","object_type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","object_aliases":["optional alias"],"summary":"short factual claim","evidence":"short supporting phrase","confidence":0.0,"valid_at":"optional date/time text","valid_from":"optional date/time text","valid_to":"optional date/time text"}]}

Rules:
- The transcript rows are the only source of truth for this extraction. Do not rely on summaries or inferred rewrites.
- Extract atomic facts that are useful for later recall. One durable claim per fact.
- Prefer canonical names for repeated people, organizations, places, projects, tools, and artifacts.
- Use relation-style predicates such as works_on, home_country, relationship_status, prefers, plans, decided_to_pursue, located_in, uses_tool, recommended, supports, owns, read, attends, moved_from, moved_to.
- Facts should preserve temporal history instead of overwriting it. If the transcript says something changed, emit the new fact and include timing in valid_at / valid_from / valid_to when the transcript supports it.
- Include assistant-confirmed or tool-confirmed actions when they are stated as completed facts in the transcript.
- If a speaker explicitly self-identifies or states a status, preserve that exact label instead of broadening it.
- Preserve exact named places, titles, organizations, and relative time phrases when they are the stated fact.
- Do not invent facts that are not supported by the transcript.
- Avoid duplicates or near-duplicates. If two facts say the same thing, keep the more specific one.
- Return no markdown, no prose, no code fences, only JSON.`;

// dist/src/hooks/spawn-wiki-worker.js
var HOME = homedir4();
var WIKI_LOG = join5(HOME, ".claude", "hooks", "deeplake-wiki.log");
var WIKI_PROMPT_TEMPLATE = `You are maintaining a persistent wiki from a session transcript. This page will become part of a long-lived knowledge base that future agents will search through index.md before opening the source session. Write for retrieval, not storytelling.

The session may be a coding session, a meeting, or a personal conversation. Your job is to turn the raw transcript into a dense, factual wiki page that preserves names, dates, relationships, preferences, plans, titles, and exact status changes.

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
   - Treat the JSONL as the source of truth. Do not invent facts.

2. Write the summary file at the path above with this EXACT format. The header fields (Source, Project) are pre-filled \u2014 copy them VERBATIM, do NOT replace them with paths from the JSONL content:

# Session __SESSION_ID__
- **Source**: __JSONL_SERVER_PATH__
- **Date**: <primary real-world date/time for the session if the transcript contains one; otherwise "unknown">
- **Participants**: <comma-separated names or roles of the main participants>
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__
- **Topics**: <comma-separated topics, themes, or workstreams>
- **JSONL offset**: __JSONL_LINES__

## What Happened
<2-4 dense sentences. What happened, why it mattered, and what changed. Prefer specific names/titles/dates over abstractions.>

## Searchable Facts
<Bullet list of atomic facts. One fact per bullet. Each bullet should be able to answer a future query on its own.
Include exact names, titles, identity labels, relationship status clues, home countries/origins, occupations, preferences, collections, books/media titles, pets, family details, goals, plans, locations, organizations, bugs, APIs, dates, and relative-time resolutions when the session date makes them unambiguous.>

## People
<For each person mentioned: name, role/relationship, notable traits/preferences/goals, and what they did or said. Format: **Name** \u2014 role/relationship \u2014 facts>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs, places, organizations, events, books, songs, artworks, pets, or products.
Format: **entity** (type) \u2014 why it matters, relevant state/details>

## Decisions & Reasoning
<Every decision made and WHY. Not just "did X" but "did X because Y, considered Z but rejected it because W". If no explicit decision happened, say "- None explicit.">

## Files Modified
<bullet list: path (new/modified/deleted) \u2014 what changed. If none, say "- None.">

## Open Questions / TODO
<Anything unresolved, blocked, explicitly deferred, or worth following up later. If none, say "- None explicit.">

IMPORTANT:
- Be exhaustive. If a detail exists in the session and could answer a later question, it should be in the wiki.
- Favor exact nouns and titles over generic paraphrases. Preserve exact book names, organization names, file names, feature names, and self-descriptions.
- Keep facts canonical and query-friendly: "Ava is single", "Leo's home country is Brazil", "The team chose retries because the API returned 429s".
- Resolve relative dates like "last year" or "next month" against the session's own date when the source makes that possible. If it is ambiguous, keep the relative phrase instead of guessing.
- Do not omit beneficiary groups or targets of goals (for example who a project, career, or effort is meant to help).
- Do not leak absolute filesystem paths beyond the pre-filled Source field.

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
    graphNodesTable: config.graphNodesTableName,
    graphEdgesTable: config.graphEdgesTableName,
    factsTable: config.factsTableName,
    entitiesTable: config.entitiesTableName,
    factEntityLinksTable: config.factEntityLinksTableName,
    sessionId,
    userName: config.userName,
    project: projectName,
    tmpDir,
    claudeBin: findClaudeBin(),
    wikiLog: WIKI_LOG,
    hooksDir: join5(HOME, ".claude", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE,
    graphPromptTemplate: GRAPH_PROMPT_TEMPLATE,
    factPromptTemplate: MEMORY_FACT_PROMPT_TEMPLATE
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
import { appendFileSync as appendFileSync3, closeSync as closeSync2, existsSync as existsSync4, mkdirSync as mkdirSync4, openSync as openSync2, readFileSync as readFileSync4, readdirSync, renameSync as renameSync2, rmSync, statSync, writeFileSync as writeFileSync4 } from "node:fs";
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
  const structured = extractStructuredSessionFields(args.line, args.sessionId);
  return {
    id: crypto.randomUUID(),
    path: args.sessionPath,
    filename: args.sessionPath.split("/").pop() ?? "",
    message: args.line,
    sessionId: structured.sessionId,
    eventType: structured.eventType,
    turnIndex: structured.turnIndex,
    diaId: structured.diaId,
    speaker: structured.speaker,
    text: structured.text,
    turnSummary: structured.turnSummary,
    sourceDateTime: structured.sourceDateTime,
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
function extractString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function extractNumber(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return 0;
}
function extractStructuredSessionFields(message, fallbackSessionId = "") {
  let parsed = null;
  try {
    const raw = JSON.parse(message);
    if (raw && typeof raw === "object")
      parsed = raw;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      sessionId: fallbackSessionId,
      eventType: "raw_message",
      turnIndex: 0,
      diaId: "",
      speaker: "",
      text: message,
      turnSummary: "",
      sourceDateTime: ""
    };
  }
  const eventType = extractString(parsed["type"]);
  const content = extractString(parsed["content"]);
  const toolName = extractString(parsed["tool_name"]);
  const speaker = extractString(parsed["speaker"]) || (eventType === "user_message" ? "user" : eventType === "assistant_message" ? "assistant" : "");
  const text = extractString(parsed["text"]) || content || (eventType === "tool_call" ? toolName : "");
  return {
    sessionId: extractString(parsed["session_id"]) || fallbackSessionId,
    eventType,
    turnIndex: extractNumber(parsed["turn_index"]),
    diaId: extractString(parsed["dia_id"]),
    speaker,
    text,
    turnSummary: extractString(parsed["summary"]) || extractString(parsed["message_summary"]) || extractString(parsed["msg_summary"]),
    sourceDateTime: extractString(parsed["source_date_time"]) || extractString(parsed["date_time"]) || extractString(parsed["date"])
  };
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
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, rmSync as rmSync2, statSync as statSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join7 } from "node:path";
import { homedir as homedir6 } from "node:os";
var log3 = (msg) => log("query-cache", msg);
var DEFAULT_CACHE_ROOT = join7(homedir6(), ".deeplake", "query-cache");
var INDEX_CACHE_TTL_MS = 15 * 60 * 1e3;
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
    sessionId: input.session_id,
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
