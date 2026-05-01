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
function sqlLike(value) {
  return sqlStr(value).replace(/%/g, "\\%").replace(/_/g, "\\_");
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

// dist/src/shell/grep-core.js
var TOOL_INPUT_FIELDS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "prompt",
  "subagent_type",
  "query",
  "url",
  "notebook_path",
  "old_string",
  "new_string",
  "content",
  "skill",
  "args",
  "taskId",
  "status",
  "subject",
  "description",
  "to",
  "message",
  "summary",
  "max_results"
];
var TOOL_RESPONSE_DROP = /* @__PURE__ */ new Set([
  // Note: `stderr` is intentionally NOT in this set. The `stdout` high-signal
  // branch below already de-dupes it for the common case (appends as suffix
  // when non-empty). If a tool response has ONLY `stderr` and no `stdout`
  // (hard-failure on some tools), the generic cleanup preserves it so the
  // error message reaches Claude instead of collapsing to `[ok]`.
  "interrupted",
  "isImage",
  "noOutputExpected",
  "type",
  "structuredPatch",
  "userModified",
  "originalFile",
  "replaceAll",
  "totalDurationMs",
  "totalTokens",
  "totalToolUseCount",
  "usage",
  "toolStats",
  "durationMs",
  "durationSeconds",
  "bytes",
  "code",
  "codeText",
  "agentId",
  "agentType",
  "verificationNudgeNeeded",
  "numLines",
  "numFiles",
  "truncated",
  "statusChange",
  "updatedFields",
  "isAgent",
  "success"
]);
function maybeParseJson(v) {
  if (typeof v !== "string")
    return v;
  const s = v.trim();
  if (s[0] !== "{" && s[0] !== "[")
    return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}
function snakeCase(k) {
  return k.replace(/([A-Z])/g, "_$1").toLowerCase();
}
function camelCase(k) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function formatToolInput(raw) {
  const p = maybeParseJson(raw);
  if (typeof p !== "object" || p === null)
    return String(p ?? "");
  const parts = [];
  for (const k of TOOL_INPUT_FIELDS) {
    if (p[k] === void 0)
      continue;
    const v = p[k];
    parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  for (const k of ["glob", "output_mode", "limit", "offset"]) {
    if (p[k] !== void 0)
      parts.push(`${k}: ${p[k]}`);
  }
  return parts.length ? parts.join("\n") : JSON.stringify(p);
}
function formatToolResponse(raw, inp, toolName) {
  const r = maybeParseJson(raw);
  if (typeof r !== "object" || r === null)
    return String(r ?? "");
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return r.filePath ? `[wrote ${r.filePath}]` : "[ok]";
  }
  if (typeof r.stdout === "string") {
    const stderr = r.stderr;
    return r.stdout + (stderr ? `
stderr: ${stderr}` : "");
  }
  if (typeof r.content === "string")
    return r.content;
  if (r.file && typeof r.file === "object") {
    const f = r.file;
    if (typeof f.content === "string")
      return `[${f.filePath ?? ""}]
${f.content}`;
    if (typeof f.base64 === "string")
      return `[binary ${f.filePath ?? ""}: ${f.base64.length} base64 chars]`;
  }
  if (Array.isArray(r.filenames))
    return r.filenames.join("\n");
  if (Array.isArray(r.matches)) {
    return r.matches.map((m) => typeof m === "string" ? m : JSON.stringify(m)).join("\n");
  }
  if (Array.isArray(r.results)) {
    return r.results.map((x) => typeof x === "string" ? x : x?.title ?? x?.url ?? JSON.stringify(x)).join("\n");
  }
  const inpObj = maybeParseJson(inp);
  const kept = {};
  for (const [k, v] of Object.entries(r)) {
    if (TOOL_RESPONSE_DROP.has(k))
      continue;
    if (v === "" || v === false || v == null)
      continue;
    if (typeof inpObj === "object" && inpObj) {
      const inObj = inpObj;
      if (k in inObj && JSON.stringify(inObj[k]) === JSON.stringify(v))
        continue;
      const snake = snakeCase(k);
      if (snake in inObj && JSON.stringify(inObj[snake]) === JSON.stringify(v))
        continue;
      const camel = camelCase(k);
      if (camel in inObj && JSON.stringify(inObj[camel]) === JSON.stringify(v))
        continue;
    }
    kept[k] = v;
  }
  return Object.keys(kept).length ? JSON.stringify(kept) : "[ok]";
}
function formatToolCall(obj) {
  return `[tool:${obj?.tool_name ?? "?"}]
input: ${formatToolInput(obj?.tool_input)}
response: ${formatToolResponse(obj?.tool_response, obj?.tool_input, obj?.tool_name)}`;
}
function normalizeContent(path, raw) {
  if (!path.includes("/sessions/"))
    return raw;
  if (!raw || raw[0] !== "{")
    return raw;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (Array.isArray(obj.turns)) {
    const dateHeader = obj.date_time ? `(${String(obj.date_time)}) ` : "";
    const lines = obj.turns.map((t) => {
      const sp = String(t?.speaker ?? t?.name ?? "?").trim();
      const tx = String(t?.text ?? t?.content ?? "").replace(/\s+/g, " ").trim();
      const tag = t?.dia_id ? `[${t.dia_id}] ` : "";
      return `${dateHeader}${tag}${sp}: ${tx}`;
    });
    const out2 = lines.join("\n");
    return out2.trim() ? out2 : raw;
  }
  if (obj.turn && typeof obj.turn === "object" && !Array.isArray(obj.turn)) {
    const t = obj.turn;
    const sp = String(t.speaker ?? t.name ?? "?").trim();
    const tx = String(t.text ?? t.content ?? "").replace(/\s+/g, " ").trim();
    const tag = t.dia_id ? `[${String(t.dia_id)}] ` : "";
    const dateHeader = obj.date_time ? `(${String(obj.date_time)}) ` : "";
    const line = `${dateHeader}${tag}${sp}: ${tx}`;
    return line.trim() ? line : raw;
  }
  const stripRecalled = (t) => {
    const i = t.indexOf("<recalled-memories>");
    if (i === -1)
      return t;
    const j = t.lastIndexOf("</recalled-memories>");
    if (j === -1 || j < i)
      return t;
    const head = t.slice(0, i);
    const tail = t.slice(j + "</recalled-memories>".length);
    return (head + tail).replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n");
  };
  let out = null;
  if (obj.type === "user_message") {
    out = `[user] ${stripRecalled(String(obj.content ?? ""))}`;
  } else if (obj.type === "assistant_message") {
    const agent = obj.agent_type ? ` (agent=${obj.agent_type})` : "";
    out = `[assistant${agent}] ${stripRecalled(String(obj.content ?? ""))}`;
  } else if (obj.type === "tool_call") {
    out = formatToolCall(obj);
  }
  if (out === null)
    return raw;
  const trimmed = out.trim();
  if (!trimmed || trimmed === "[user]" || trimmed === "[assistant]" || /^\[tool:[^\]]*\]\s+input:\s+\{\}\s+response:\s+\{\}$/.test(trimmed))
    return raw;
  return out;
}
function buildPathCondition(targetPath) {
  if (!targetPath || targetPath === "/")
    return "";
  const clean = targetPath.replace(/\/+$/, "");
  if (/[*?]/.test(clean)) {
    const likePattern = sqlLike(clean).replace(/\*/g, "%").replace(/\?/g, "_");
    return `path LIKE '${likePattern}' ESCAPE '\\'`;
  }
  const base = clean.split("/").pop() ?? "";
  if (base.includes(".")) {
    return `path = '${sqlStr(clean)}'`;
  }
  return `(path = '${sqlStr(clean)}' OR path LIKE '${sqlLike(clean)}/%' ESCAPE '\\')`;
}
async function searchDeeplakeTables(api, memoryTable, sessionsTable, opts) {
  const { pathFilter, contentScanOnly, likeOp, escapedPattern, prefilterPattern, prefilterPatterns, queryEmbedding, bm25Term, multiWordPatterns } = opts;
  const limit = opts.limit ?? 100;
  if (queryEmbedding && queryEmbedding.length > 0) {
    const vecLit = serializeFloat4Array(queryEmbedding);
    const semanticLimit = Math.min(limit, Number(process.env.HIVEMIND_SEMANTIC_LIMIT ?? "20"));
    const lexicalLimit = Math.min(limit, Number(process.env.HIVEMIND_HYBRID_LEXICAL_LIMIT ?? "20"));
    const filterPatternsForLex = contentScanOnly ? prefilterPatterns && prefilterPatterns.length > 0 ? prefilterPatterns : prefilterPattern ? [prefilterPattern] : [] : [escapedPattern];
    const memLexFilter = buildContentFilter("summary::text", likeOp, filterPatternsForLex);
    const sessLexFilter = buildContentFilter("message::text", likeOp, filterPatternsForLex);
    const memLexQuery = memLexFilter ? `SELECT path, summary::text AS content, 0 AS source_order, '' AS creation_date, 1.0 AS score FROM "${memoryTable}" WHERE 1=1${pathFilter}${memLexFilter} LIMIT ${lexicalLimit}` : null;
    const sessLexQuery = sessLexFilter ? `SELECT path, message::text AS content, 1 AS source_order, COALESCE(creation_date::text, '') AS creation_date, 1.0 AS score FROM "${sessionsTable}" WHERE 1=1${pathFilter}${sessLexFilter} LIMIT ${lexicalLimit}` : null;
    const memSemQuery = `SELECT path, summary::text AS content, 0 AS source_order, '' AS creation_date, (summary_embedding <#> ${vecLit}) AS score FROM "${memoryTable}" WHERE ARRAY_LENGTH(summary_embedding, 1) > 0${pathFilter} ORDER BY score DESC LIMIT ${semanticLimit}`;
    const sessSemQuery = `SELECT path, message::text AS content, 1 AS source_order, COALESCE(creation_date::text, '') AS creation_date, (message_embedding <#> ${vecLit}) AS score FROM "${sessionsTable}" WHERE ARRAY_LENGTH(message_embedding, 1) > 0${pathFilter} ORDER BY score DESC LIMIT ${semanticLimit}`;
    const parts = [memSemQuery, sessSemQuery];
    if (memLexQuery)
      parts.push(memLexQuery);
    if (sessLexQuery)
      parts.push(sessLexQuery);
    const unionSql = parts.map((q) => `(${q})`).join(" UNION ALL ");
    const outerLimit = semanticLimit + lexicalLimit;
    const rows2 = await api.query(`SELECT path, content, source_order, creation_date, score FROM (` + unionSql + `) AS combined ORDER BY score DESC LIMIT ${outerLimit}`);
    const seen = /* @__PURE__ */ new Set();
    const unique = [];
    for (const row of rows2) {
      const p = String(row["path"]);
      if (seen.has(p))
        continue;
      seen.add(p);
      unique.push({ path: p, content: String(row["content"] ?? "") });
    }
    return unique;
  }
  const filterPatterns = contentScanOnly ? prefilterPatterns && prefilterPatterns.length > 0 ? prefilterPatterns : prefilterPattern ? [prefilterPattern] : [] : multiWordPatterns && multiWordPatterns.length > 1 ? multiWordPatterns : [escapedPattern];
  const memFilter = buildContentFilter("summary::text", likeOp, filterPatterns);
  const sessFilter = buildContentFilter("message::text", likeOp, filterPatterns);
  const memQuery = `SELECT path, summary::text AS content, 0 AS source_order, '' AS creation_date FROM "${memoryTable}" WHERE 1=1${pathFilter}${memFilter} LIMIT ${limit}`;
  const sessQuery = `SELECT path, message::text AS content, 1 AS source_order, COALESCE(creation_date::text, '') AS creation_date FROM "${sessionsTable}" WHERE 1=1${pathFilter}${sessFilter} LIMIT ${limit}`;
  const rows = await api.query(`SELECT path, content, source_order, creation_date FROM ((${memQuery}) UNION ALL (${sessQuery})) AS combined ORDER BY path, source_order, creation_date`);
  return rows.map((row) => ({
    path: String(row["path"]),
    content: String(row["content"] ?? "")
  }));
}
function serializeFloat4Array(vec) {
  const parts = [];
  for (const v of vec) {
    if (!Number.isFinite(v))
      return "NULL";
    parts.push(String(v));
  }
  return `ARRAY[${parts.join(",")}]::float4[]`;
}
function buildPathFilter(targetPath) {
  const condition = buildPathCondition(targetPath);
  return condition ? ` AND ${condition}` : "";
}
function extractRegexLiteralPrefilter(pattern) {
  if (!pattern)
    return null;
  const parts = [];
  let current = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!next)
        return null;
      if (/[dDsSwWbBAZzGkKpP]/.test(next))
        return null;
      current += next;
      i++;
      continue;
    }
    if (ch === ".") {
      if (pattern[i + 1] === "*") {
        if (current)
          parts.push(current);
        current = "";
        i++;
        continue;
      }
      return null;
    }
    if ("|()[]{}+?^$".includes(ch) || ch === "*")
      return null;
    current += ch;
  }
  if (current)
    parts.push(current);
  const literal = parts.reduce((best, part) => part.length > best.length ? part : best, "");
  return literal.length >= 2 ? literal : null;
}
function extractRegexAlternationPrefilters(pattern) {
  if (!pattern.includes("|"))
    return null;
  const parts = [];
  let current = "";
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      current += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      if (!current)
        return null;
      parts.push(current);
      current = "";
      continue;
    }
    if ("()[]{}^$".includes(ch))
      return null;
    current += ch;
  }
  if (escaped || !current)
    return null;
  parts.push(current);
  const literals = [...new Set(parts.map((part) => extractRegexLiteralPrefilter(part)).filter((part) => typeof part === "string" && part.length >= 2))];
  return literals.length > 0 ? literals : null;
}
function buildGrepSearchOptions(params, targetPath) {
  const hasRegexMeta = !params.fixedString && /[.*+?^${}()|[\]\\]/.test(params.pattern);
  const literalPrefilter = hasRegexMeta ? extractRegexLiteralPrefilter(params.pattern) : null;
  const alternationPrefilters = hasRegexMeta ? extractRegexAlternationPrefilters(params.pattern) : null;
  let bm25Term;
  if (!hasRegexMeta) {
    bm25Term = params.pattern;
  } else if (alternationPrefilters && alternationPrefilters.length > 0) {
    bm25Term = alternationPrefilters.join(" ");
  } else if (literalPrefilter) {
    bm25Term = literalPrefilter;
  }
  const multiWordPatterns = !hasRegexMeta ? params.pattern.split(/\s+/).filter((w) => w.length > 2).slice(0, 4) : [];
  return {
    pathFilter: buildPathFilter(targetPath),
    contentScanOnly: hasRegexMeta,
    // Kept for the pure-lexical fallback path and existing tests; BM25 is now
    // the preferred lexical ranker when a term can be extracted.
    likeOp: process.env.HIVEMIND_GREP_LIKE === "case-sensitive" ? "LIKE" : "ILIKE",
    escapedPattern: sqlLike(params.pattern),
    prefilterPattern: literalPrefilter ? sqlLike(literalPrefilter) : void 0,
    prefilterPatterns: alternationPrefilters?.map((literal) => sqlLike(literal)),
    bm25Term,
    multiWordPatterns: multiWordPatterns.length > 1 ? multiWordPatterns.map((w) => sqlLike(w)) : void 0
  };
}
function buildContentFilter(column, likeOp, patterns) {
  if (patterns.length === 0)
    return "";
  if (patterns.length === 1)
    return ` AND ${column} ${likeOp} '%${patterns[0]}%'`;
  return ` AND (${patterns.map((pattern) => `${column} ${likeOp} '%${pattern}%'`).join(" OR ")})`;
}
function compileGrepRegex(params) {
  let reStr = params.fixedString ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : params.pattern;
  if (params.wordMatch)
    reStr = `\\b${reStr}\\b`;
  try {
    return new RegExp(reStr, params.ignoreCase ? "i" : "");
  } catch {
    return new RegExp(params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), params.ignoreCase ? "i" : "");
  }
}
function refineGrepMatches(rows, params, forceMultiFilePrefix) {
  const re = compileGrepRegex(params);
  const multi = forceMultiFilePrefix ?? rows.length > 1;
  const output = [];
  for (const row of rows) {
    if (!row.content)
      continue;
    const lines = row.content.split("\n");
    const matched = [];
    for (let i = 0; i < lines.length; i++) {
      const hit = re.test(lines[i]);
      if (hit !== !!params.invertMatch) {
        if (params.filesOnly) {
          output.push(row.path);
          break;
        }
        const prefix = multi ? `${row.path}:` : "";
        const ln = params.lineNumber ? `${i + 1}:` : "";
        matched.push(`${prefix}${ln}${lines[i]}`);
      }
    }
    if (!params.filesOnly) {
      if (params.countOnly) {
        output.push(`${multi ? `${row.path}:` : ""}${matched.length}`);
      } else {
        output.push(...matched);
      }
    }
  }
  return output;
}
async function grepBothTables(api, memoryTable, sessionsTable, params, targetPath, queryEmbedding) {
  const rows = await searchDeeplakeTables(api, memoryTable, sessionsTable, {
    ...buildGrepSearchOptions(params, targetPath),
    queryEmbedding
  });
  const seen = /* @__PURE__ */ new Set();
  const unique = rows.filter((r) => seen.has(r.path) ? false : (seen.add(r.path), true));
  const normalized = unique.map((r) => ({ path: r.path, content: normalizeContent(r.path, r.content) }));
  if (queryEmbedding && queryEmbedding.length > 0) {
    const emitAllLines = process.env.HIVEMIND_SEMANTIC_EMIT_ALL !== "false";
    if (emitAllLines) {
      const lines = [];
      for (const r of normalized) {
        for (const line of r.content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed)
            lines.push(`${r.path}:${line}`);
        }
      }
      return lines;
    }
  }
  return refineGrepMatches(normalized, params);
}

// dist/src/utils/output-cap.js
var CLAUDE_OUTPUT_CAP_BYTES = 8 * 1024;
function byteLen(str) {
  return Buffer.byteLength(str, "utf8");
}
function capOutputForClaude(output, options = {}) {
  const maxBytes = options.maxBytes ?? CLAUDE_OUTPUT_CAP_BYTES;
  if (byteLen(output) <= maxBytes)
    return output;
  const kind = options.kind ?? "output";
  const footerReserve = 220;
  const budget = Math.max(1, maxBytes - footerReserve);
  let running = 0;
  const lines = output.split("\n");
  const keptLines = [];
  for (const line of lines) {
    const lineBytes = byteLen(line) + 1;
    if (running + lineBytes > budget)
      break;
    keptLines.push(line);
    running += lineBytes;
  }
  if (keptLines.length === 0) {
    const buf = Buffer.from(output, "utf8");
    let cutByte = Math.min(budget, buf.length);
    while (cutByte > 0 && (buf[cutByte] & 192) === 128)
      cutByte--;
    const slice = buf.subarray(0, cutByte).toString("utf8");
    const footer2 = `
... [${kind} truncated: ${(byteLen(output) / 1024).toFixed(1)} KB total; refine with '| head -N' or a tighter pattern]`;
    return slice + footer2;
  }
  const totalLines = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
  const elidedLines = Math.max(0, totalLines - keptLines.length);
  const elidedBytes = byteLen(output) - byteLen(keptLines.join("\n"));
  const footer = `
... [${kind} truncated: ${elidedLines} more lines (${(elidedBytes / 1024).toFixed(1)} KB) elided \u2014 refine with '| head -N' or a tighter pattern]`;
  return keptLines.join("\n") + footer;
}

// dist/src/embeddings/client.js
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync, unlinkSync, existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";

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
var SHARED_DAEMON_PATH = join4(homedir3(), ".hivemind", "embed-deps", "embed-daemon.js");
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
    this.daemonEntry = opts.daemonEntry ?? process.env.HIVEMIND_EMBED_DAEMON ?? (existsSync3(SHARED_DAEMON_PATH) ? SHARED_DAEMON_PATH : void 0);
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
      fd = openSync(this.pidPath, "wx", 384);
      writeSync(fd, String(process.pid));
    } catch (e) {
      if (this.isPidFileStale()) {
        try {
          unlinkSync(this.pidPath);
        } catch {
        }
        try {
          fd = openSync(this.pidPath, "wx", 384);
          writeSync(fd, String(process.pid));
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    if (!this.daemonEntry || !existsSync3(this.daemonEntry)) {
      log3(`daemonEntry not configured or missing: ${this.daemonEntry}`);
      try {
        closeSync(fd);
        unlinkSync(this.pidPath);
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
      log3(`spawned daemon pid=${child.pid}`);
    } finally {
      closeSync(fd);
    }
  }
  isPidFileStale() {
    try {
      const raw = readFileSync3(this.pidPath, "utf-8").trim();
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
      if (!existsSync3(this.socketPath))
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

// dist/src/embeddings/disable.js
import { createRequire } from "node:module";
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";
import { pathToFileURL } from "node:url";
var cachedStatus = null;
function defaultResolveTransformers() {
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    return;
  } catch {
  }
  const sharedDir = join5(homedir4(), ".hivemind", "embed-deps");
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

// dist/src/hooks/grep-direct.js
import { fileURLToPath } from "node:url";
import { dirname, join as join6 } from "node:path";
var SEMANTIC_ENABLED = process.env.HIVEMIND_SEMANTIC_SEARCH !== "false" && !embeddingsDisabled();
var SEMANTIC_TIMEOUT_MS = Number(process.env.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS ?? "500");
function resolveDaemonPath() {
  return join6(dirname(fileURLToPath(import.meta.url)), "..", "embeddings", "embed-daemon.js");
}
var sharedEmbedClient = null;
function getEmbedClient() {
  if (!sharedEmbedClient) {
    sharedEmbedClient = new EmbedClient({
      daemonEntry: resolveDaemonPath(),
      timeoutMs: SEMANTIC_TIMEOUT_MS
    });
  }
  return sharedEmbedClient;
}
function patternIsSemanticFriendly(pattern, fixedString) {
  if (!pattern || pattern.length < 2)
    return false;
  if (fixedString)
    return true;
  const meta = pattern.match(/[|()\[\]{}+?^$\\]/g);
  if (!meta)
    return true;
  return meta.length <= 1;
}
function splitFirstPipelineStage(cmd) {
  const input = cmd.trim();
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"') {
        escaped = true;
      }
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|")
      return input.slice(0, i).trim();
  }
  return quote ? null : input;
}
function tokenizeGrepStage(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote)
    return null;
  if (current)
    tokens.push(current);
  return tokens;
}
function parseBashGrep(cmd) {
  const first = splitFirstPipelineStage(cmd);
  if (!first)
    return null;
  const matchTool = first.match(/^(grep|egrep|fgrep|rg)\b/);
  if (!matchTool)
    return null;
  const tool = matchTool[1];
  const isFixed = tool === "fgrep";
  const isRg = tool === "rg";
  const tokens = tokenizeGrepStage(first);
  if (!tokens || tokens.length === 0)
    return null;
  let ignoreCase = false, wordMatch = false, filesOnly = false, countOnly = false, lineNumber = isRg, invertMatch = false, fixedString = isFixed;
  const explicitPatterns = [];
  let ti = 1;
  while (ti < tokens.length) {
    const token = tokens[ti];
    if (token === "--") {
      ti++;
      break;
    }
    if (!token.startsWith("-") || token === "-")
      break;
    if (token.startsWith("--")) {
      const [flag, inlineValue] = token.split("=", 2);
      const rgValueLongs = /* @__PURE__ */ new Set([
        "--type",
        "--type-not",
        "--type-add",
        "--type-clear",
        "--glob",
        "--iglob",
        "--threads",
        "--max-columns",
        "--max-depth",
        "--max-filesize",
        "--pre",
        "--pre-glob",
        "--replace",
        "--encoding",
        "--color",
        "--colors",
        "--sort",
        "--sortr",
        "--context-separator",
        "--field-context-separator",
        "--field-match-separator",
        "--path-separator",
        "--hostname-bin"
      ]);
      const handlers = {
        "--ignore-case": () => {
          ignoreCase = true;
          return false;
        },
        "--word-regexp": () => {
          wordMatch = true;
          return false;
        },
        "--files-with-matches": () => {
          filesOnly = true;
          return false;
        },
        // rg uses `--files` to list files (without searching). For our purposes
        // it's similar enough to `-l` that we treat it as filesOnly.
        "--files": () => {
          filesOnly = true;
          return false;
        },
        "--count": () => {
          countOnly = true;
          return false;
        },
        "--count-matches": () => {
          countOnly = true;
          return false;
        },
        "--line-number": () => {
          lineNumber = true;
          return false;
        },
        "--no-line-number": () => {
          lineNumber = false;
          return false;
        },
        "--invert-match": () => {
          invertMatch = true;
          return false;
        },
        "--fixed-strings": () => {
          fixedString = true;
          return false;
        },
        "--after-context": () => inlineValue === void 0,
        "--before-context": () => inlineValue === void 0,
        "--context": () => inlineValue === void 0,
        "--max-count": () => inlineValue === void 0,
        "--regexp": () => {
          if (inlineValue !== void 0) {
            explicitPatterns.push(inlineValue);
            return false;
          }
          return true;
        }
      };
      let consumeNext = handlers[flag]?.() ?? false;
      if (!consumeNext && isRg && rgValueLongs.has(flag) && inlineValue === void 0) {
        consumeNext = true;
      }
      if (consumeNext) {
        ti++;
        if (ti >= tokens.length)
          return null;
        if (flag === "--regexp")
          explicitPatterns.push(tokens[ti]);
      }
      ti++;
      continue;
    }
    const rgValueShorts = new Set(isRg ? ["t", "T", "g", "j", "M", "r", "E"] : []);
    const shortFlags = token.slice(1);
    let consumedValueFlag = false;
    for (let i = 0; i < shortFlags.length; i++) {
      const flag = shortFlags[i];
      switch (flag) {
        case "i":
          ignoreCase = true;
          break;
        case "w":
          wordMatch = true;
          break;
        case "l":
          filesOnly = true;
          break;
        case "c":
          countOnly = true;
          break;
        case "n":
          lineNumber = true;
          break;
        case "N":
          lineNumber = false;
          break;
        // rg --no-line-number short form
        case "v":
          invertMatch = true;
          break;
        case "F":
          fixedString = true;
          break;
        case "r":
          if (isRg) {
            if (i === shortFlags.length - 1) {
              ti++;
              if (ti >= tokens.length)
                return null;
            }
            consumedValueFlag = true;
            i = shortFlags.length;
          }
          break;
        case "R":
        case "E":
          if (isRg && flag === "E") {
            if (i === shortFlags.length - 1) {
              ti++;
              if (ti >= tokens.length)
                return null;
            }
            consumedValueFlag = true;
            i = shortFlags.length;
          }
          break;
        case "A":
        case "B":
        case "C":
        case "m":
          if (i === shortFlags.length - 1) {
            ti++;
            if (ti >= tokens.length)
              return null;
          }
          i = shortFlags.length;
          break;
        case "e": {
          const inlineValue = shortFlags.slice(i + 1);
          if (inlineValue) {
            explicitPatterns.push(inlineValue);
          } else {
            ti++;
            if (ti >= tokens.length)
              return null;
            explicitPatterns.push(tokens[ti]);
          }
          i = shortFlags.length;
          break;
        }
        default:
          if (rgValueShorts.has(flag)) {
            if (i === shortFlags.length - 1) {
              ti++;
              if (ti >= tokens.length)
                return null;
            }
            consumedValueFlag = true;
            i = shortFlags.length;
          }
          break;
      }
    }
    void consumedValueFlag;
    ti++;
  }
  const pattern = explicitPatterns.length > 0 ? explicitPatterns[0] : tokens[ti];
  if (!pattern)
    return null;
  let target = explicitPatterns.length > 0 ? tokens[ti] ?? "/" : tokens[ti + 1] ?? "/";
  if (target === "." || target === "./")
    target = "/";
  return {
    pattern,
    targetPath: target,
    ignoreCase,
    wordMatch,
    filesOnly,
    countOnly,
    lineNumber,
    invertMatch,
    fixedString
  };
}
async function handleGrepDirect(api, table, sessionsTable, params) {
  if (!params.pattern)
    return null;
  const matchParams = {
    pattern: params.pattern,
    ignoreCase: params.ignoreCase,
    wordMatch: params.wordMatch,
    filesOnly: params.filesOnly,
    countOnly: params.countOnly,
    lineNumber: params.lineNumber,
    invertMatch: params.invertMatch,
    fixedString: params.fixedString
  };
  let queryEmbedding = null;
  if (SEMANTIC_ENABLED && patternIsSemanticFriendly(params.pattern, params.fixedString)) {
    try {
      queryEmbedding = await getEmbedClient().embed(params.pattern, "query");
    } catch {
      queryEmbedding = null;
    }
  }
  const output = await grepBothTables(api, table, sessionsTable, matchParams, params.targetPath, queryEmbedding);
  const joined = output.join("\n") || "(no matches)";
  return capOutputForClaude(joined, { kind: "grep" });
}

// dist/src/hooks/memory-path-utils.js
import { homedir as homedir5 } from "node:os";
import { join as join7 } from "node:path";
var MEMORY_PATH = join7(homedir5(), ".deeplake", "memory");
var TILDE_PATH = "~/.deeplake/memory";
var HOME_VAR_PATH = "$HOME/.deeplake/memory";
function touchesMemory(p) {
  return p.includes(MEMORY_PATH) || p.includes(TILDE_PATH) || p.includes(HOME_VAR_PATH);
}
function rewritePaths(cmd) {
  return cmd.replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/").replace(/~\/.deeplake\/memory\/?/g, "/").replace(/\$HOME\/.deeplake\/memory\/?/g, "/").replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}

// dist/src/hooks/cursor/pre-tool-use.js
var log4 = (msg) => log("cursor-pre-tool-use", msg);
async function main() {
  const input = await readStdin();
  if (input.tool_name !== "Shell")
    return;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.length === 0)
    return;
  if (!touchesMemory(command))
    return;
  const rewritten = rewritePaths(command);
  const grepParams = parseBashGrep(rewritten);
  if (!grepParams)
    return;
  const config = loadConfig();
  if (!config) {
    log4("no config \u2014 falling through to Cursor's bash");
    return;
  }
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
  try {
    const result = await handleGrepDirect(api, config.tableName, config.sessionsTableName, grepParams);
    if (result === null) {
      log4(`fallthrough \u2014 handleGrepDirect returned null for "${grepParams.pattern}"`);
      return;
    }
    log4(`intercepted ${command.slice(0, 80)} \u2192 ${result.length} chars from SQL fast-path`);
    const echoCmd = `cat <<'__HIVEMIND_RESULT__'
${result}
__HIVEMIND_RESULT__`;
    process.stdout.write(JSON.stringify({
      permission: "allow",
      updated_input: { command: echoCmd },
      agent_message: `[Hivemind direct] ${grepParams.pattern}`
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log4(`fast-path failed, falling through: ${msg}`);
  }
}
main().catch((e) => {
  log4(`fatal: ${e.message}`);
  process.exit(0);
});
