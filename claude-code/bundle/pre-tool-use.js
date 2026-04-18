#!/usr/bin/env node

// dist/src/hooks/pre-tool-use.js
import { existsSync as existsSync3 } from "node:fs";
import { join as join6, dirname } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

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
    const header = [];
    if (obj.date_time)
      header.push(`date: ${obj.date_time}`);
    if (obj.speakers) {
      const s = obj.speakers;
      const names = [s.speaker_a, s.speaker_b].filter(Boolean).join(", ");
      if (names)
        header.push(`speakers: ${names}`);
    }
    const lines = obj.turns.map((t) => {
      const sp = String(t?.speaker ?? t?.name ?? "?").trim();
      const tx = String(t?.text ?? t?.content ?? "").replace(/\s+/g, " ").trim();
      const tag = t?.dia_id ? `[${t.dia_id}] ` : "";
      return `${tag}${sp}: ${tx}`;
    });
    const out2 = [...header, ...lines].join("\n");
    return out2.trim() ? out2 : raw;
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
    return `path LIKE '${likePattern}'`;
  }
  const base = clean.split("/").pop() ?? "";
  if (base.includes(".")) {
    return `path = '${sqlStr(clean)}'`;
  }
  return `(path = '${sqlStr(clean)}' OR path LIKE '${sqlLike(clean)}/%')`;
}
async function searchDeeplakeTables(api, memoryTable, sessionsTable, opts) {
  const { pathFilter, contentScanOnly, likeOp, escapedPattern, prefilterPattern, prefilterPatterns } = opts;
  const limit = opts.limit ?? 100;
  const filterPatterns = contentScanOnly ? prefilterPatterns && prefilterPatterns.length > 0 ? prefilterPatterns : prefilterPattern ? [prefilterPattern] : [] : [escapedPattern];
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
  return {
    pathFilter: buildPathFilter(targetPath),
    contentScanOnly: hasRegexMeta,
    likeOp: params.ignoreCase ? "ILIKE" : "LIKE",
    escapedPattern: sqlLike(params.pattern),
    prefilterPattern: literalPrefilter ? sqlLike(literalPrefilter) : void 0,
    prefilterPatterns: alternationPrefilters?.map((literal) => sqlLike(literal))
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
async function grepBothTables(api, memoryTable, sessionsTable, params, targetPath) {
  const rows = await searchDeeplakeTables(api, memoryTable, sessionsTable, buildGrepSearchOptions(params, targetPath));
  const seen = /* @__PURE__ */ new Set();
  const unique = rows.filter((r) => seen.has(r.path) ? false : (seen.add(r.path), true));
  const normalized = unique.map((r) => ({ path: r.path, content: normalizeContent(r.path, r.content) }));
  return refineGrepMatches(normalized, params);
}

// dist/src/hooks/grep-direct.js
function parseBashGrep(cmd) {
  const first = cmd.trim().split(/\s*\|\s*/)[0];
  if (!/^(grep|egrep|fgrep)\b/.test(first))
    return null;
  const isFixed = first.startsWith("fgrep");
  const tokens = [];
  let pos = 0;
  while (pos < first.length) {
    if (first[pos] === " " || first[pos] === "	") {
      pos++;
      continue;
    }
    if (first[pos] === "'" || first[pos] === '"') {
      const q = first[pos];
      let end = pos + 1;
      while (end < first.length && first[end] !== q)
        end++;
      tokens.push(first.slice(pos + 1, end));
      pos = end + 1;
    } else {
      let end = pos;
      while (end < first.length && first[end] !== " " && first[end] !== "	")
        end++;
      tokens.push(first.slice(pos, end));
      pos = end;
    }
  }
  let ignoreCase = false, wordMatch = false, filesOnly = false, countOnly = false, lineNumber = false, invertMatch = false, fixedString = isFixed;
  let ti = 1;
  while (ti < tokens.length && tokens[ti].startsWith("-") && tokens[ti] !== "--") {
    const flag = tokens[ti];
    if (flag.startsWith("--")) {
      const handlers = {
        "--ignore-case": () => {
          ignoreCase = true;
        },
        "--word-regexp": () => {
          wordMatch = true;
        },
        "--files-with-matches": () => {
          filesOnly = true;
        },
        "--count": () => {
          countOnly = true;
        },
        "--line-number": () => {
          lineNumber = true;
        },
        "--invert-match": () => {
          invertMatch = true;
        },
        "--fixed-strings": () => {
          fixedString = true;
        }
      };
      handlers[flag]?.();
      ti++;
      continue;
    }
    for (const c of flag.slice(1)) {
      switch (c) {
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
        case "v":
          invertMatch = true;
          break;
        case "F":
          fixedString = true;
          break;
      }
    }
    ti++;
  }
  if (ti < tokens.length && tokens[ti] === "--")
    ti++;
  if (ti >= tokens.length)
    return null;
  let target = tokens[ti + 1] ?? "/";
  if (target === "." || target === "./")
    target = "/";
  return {
    pattern: tokens[ti],
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
  const output = await grepBothTables(api, table, sessionsTable, matchParams, params.targetPath);
  return output.join("\n") || "(no matches)";
}

// dist/src/hooks/virtual-table-query.js
function normalizeSessionPart(path, content) {
  return normalizeContent(path, content);
}
function buildVirtualIndexContent(rows) {
  const lines = ["# Memory Index", "", `${rows.length} sessions:`, ""];
  for (const row of rows) {
    const path = row["path"];
    const project = row["project"] || "";
    const description = (row["description"] || "").slice(0, 120);
    const date = (row["creation_date"] || "").slice(0, 10);
    lines.push(`- [${path}](${path}) ${date} ${project ? `[${project}]` : ""} ${description}`);
  }
  return lines.join("\n");
}
function buildUnionQuery(memoryQuery, sessionsQuery) {
  return `SELECT path, content, size_bytes, creation_date, source_order FROM ((${memoryQuery}) UNION ALL (${sessionsQuery})) AS combined ORDER BY path, source_order, creation_date`;
}
function buildInList(paths) {
  return paths.map((path) => `'${sqlStr(path)}'`).join(", ");
}
function buildDirFilter(dirs) {
  const cleaned = [...new Set(dirs.map((dir) => dir.replace(/\/+$/, "") || "/"))];
  if (cleaned.length === 0 || cleaned.includes("/"))
    return "";
  const clauses = cleaned.map((dir) => `path LIKE '${sqlLike(dir)}/%'`);
  return ` WHERE ${clauses.join(" OR ")}`;
}
async function queryUnionRows(api, memoryQuery, sessionsQuery) {
  const unionQuery = buildUnionQuery(memoryQuery, sessionsQuery);
  try {
    return await api.query(unionQuery);
  } catch {
    const [memoryRows, sessionRows] = await Promise.all([
      api.query(memoryQuery).catch(() => []),
      api.query(sessionsQuery).catch(() => [])
    ]);
    return [...memoryRows, ...sessionRows];
  }
}
async function readVirtualPathContents(api, memoryTable, sessionsTable, virtualPaths) {
  const uniquePaths = [...new Set(virtualPaths)];
  const result = new Map(uniquePaths.map((path) => [path, null]));
  if (uniquePaths.length === 0)
    return result;
  const inList = buildInList(uniquePaths);
  const rows = await queryUnionRows(api, `SELECT path, summary::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 0 AS source_order FROM "${memoryTable}" WHERE path IN (${inList})`, `SELECT path, message::text AS content, NULL::bigint AS size_bytes, COALESCE(creation_date::text, '') AS creation_date, 1 AS source_order FROM "${sessionsTable}" WHERE path IN (${inList})`);
  const memoryHits = /* @__PURE__ */ new Map();
  const sessionHits = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const path = row["path"];
    const content = row["content"];
    const sourceOrder = Number(row["source_order"] ?? 0);
    if (typeof path !== "string" || typeof content !== "string")
      continue;
    if (sourceOrder === 0) {
      memoryHits.set(path, content);
    } else {
      const current = sessionHits.get(path) ?? [];
      current.push(normalizeSessionPart(path, content));
      sessionHits.set(path, current);
    }
  }
  for (const path of uniquePaths) {
    if (memoryHits.has(path)) {
      result.set(path, memoryHits.get(path) ?? null);
      continue;
    }
    const sessionParts = sessionHits.get(path) ?? [];
    if (sessionParts.length > 0) {
      result.set(path, sessionParts.join("\n"));
    }
  }
  if (result.get("/index.md") === null && uniquePaths.includes("/index.md")) {
    const rows2 = await api.query(`SELECT path, project, description, creation_date FROM "${memoryTable}" WHERE path LIKE '/summaries/%' ORDER BY creation_date DESC`).catch(() => []);
    result.set("/index.md", buildVirtualIndexContent(rows2));
  }
  return result;
}
async function listVirtualPathRowsForDirs(api, memoryTable, sessionsTable, dirs) {
  const uniqueDirs = [...new Set(dirs.map((dir) => dir.replace(/\/+$/, "") || "/"))];
  const filter = buildDirFilter(uniqueDirs);
  const rows = await queryUnionRows(api, `SELECT path, NULL::text AS content, size_bytes, '' AS creation_date, 0 AS source_order FROM "${memoryTable}"${filter}`, `SELECT path, NULL::text AS content, size_bytes, '' AS creation_date, 1 AS source_order FROM "${sessionsTable}"${filter}`);
  const deduped = dedupeRowsByPath(rows.map((row) => ({
    path: row["path"],
    size_bytes: row["size_bytes"]
  })));
  const byDir = /* @__PURE__ */ new Map();
  for (const dir of uniqueDirs)
    byDir.set(dir, []);
  for (const row of deduped) {
    const path = row["path"];
    if (typeof path !== "string")
      continue;
    for (const dir of uniqueDirs) {
      const prefix = dir === "/" ? "/" : `${dir}/`;
      if (dir === "/" || path.startsWith(prefix)) {
        byDir.get(dir)?.push(row);
      }
    }
  }
  return byDir;
}
async function readVirtualPathContent(api, memoryTable, sessionsTable, virtualPath) {
  return (await readVirtualPathContents(api, memoryTable, sessionsTable, [virtualPath])).get(virtualPath) ?? null;
}
async function listVirtualPathRows(api, memoryTable, sessionsTable, dir) {
  return (await listVirtualPathRowsForDirs(api, memoryTable, sessionsTable, [dir])).get(dir.replace(/\/+$/, "") || "/") ?? [];
}
async function findVirtualPaths(api, memoryTable, sessionsTable, dir, filenamePattern) {
  const normalizedDir = dir.replace(/\/+$/, "") || "/";
  const likePath = `${sqlLike(normalizedDir === "/" ? "" : normalizedDir)}/%`;
  const rows = await queryUnionRows(api, `SELECT path, NULL::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 0 AS source_order FROM "${memoryTable}" WHERE path LIKE '${likePath}' AND filename LIKE '${filenamePattern}'`, `SELECT path, NULL::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 1 AS source_order FROM "${sessionsTable}" WHERE path LIKE '${likePath}' AND filename LIKE '${filenamePattern}'`);
  return [...new Set(rows.map((row) => row["path"]).filter((value) => typeof value === "string" && value.length > 0))];
}
function dedupeRowsByPath(rows) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const row of rows) {
    const path = typeof row["path"] === "string" ? row["path"] : "";
    if (!path || seen.has(path))
      continue;
    seen.add(path);
    unique.push(row);
  }
  return unique;
}

// dist/src/hooks/bash-command-compiler.js
function isQuoted(ch) {
  return ch === "'" || ch === '"';
}
function splitTopLevel(input, operators) {
  const parts = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote)
        quote = null;
      current += ch;
      continue;
    }
    if (isQuoted(ch)) {
      quote = ch;
      current += ch;
      continue;
    }
    const matched = operators.find((op) => input.startsWith(op, i));
    if (matched) {
      const trimmed2 = current.trim();
      if (trimmed2)
        parts.push(trimmed2);
      current = "";
      i += matched.length - 1;
      continue;
    }
    current += ch;
  }
  if (quote)
    return null;
  const trimmed = current.trim();
  if (trimmed)
    parts.push(trimmed);
  return parts;
}
function tokenizeShellWords(input) {
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
    if (isQuoted(ch)) {
      quote = ch;
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
function expandBraceToken(token) {
  const match = token.match(/\{([^{}]+)\}/);
  if (!match)
    return [token];
  const [expr] = match;
  const prefix = token.slice(0, match.index);
  const suffix = token.slice((match.index ?? 0) + expr.length);
  let variants = [];
  const numericRange = match[1].match(/^(-?\d+)\.\.(-?\d+)$/);
  if (numericRange) {
    const start = Number(numericRange[1]);
    const end = Number(numericRange[2]);
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      variants.push(String(value));
    }
  } else {
    variants = match[1].split(",");
  }
  return variants.flatMap((variant) => expandBraceToken(`${prefix}${variant}${suffix}`));
}
function stripAllowedModifiers(segment) {
  const ignoreMissing = /\s2>\/dev\/null\s*$/.test(segment);
  const clean = segment.replace(/\s2>\/dev\/null\s*$/g, "").replace(/\s2>&1\s*/g, " ").trim();
  return { clean, ignoreMissing };
}
function hasUnsupportedRedirection(segment) {
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote)
        quote = null;
      continue;
    }
    if (isQuoted(ch)) {
      quote = ch;
      continue;
    }
    if (ch === ">" || ch === "<")
      return true;
  }
  return false;
}
function parseHeadTailStage(stage) {
  const tokens = tokenizeShellWords(stage);
  if (!tokens || tokens.length === 0)
    return null;
  const [cmd, ...rest] = tokens;
  if (cmd !== "head" && cmd !== "tail")
    return null;
  if (rest.length === 0)
    return { lineLimit: 10, fromEnd: cmd === "tail" };
  if (rest.length === 1) {
    const count = Number(rest[0]);
    if (!Number.isFinite(count)) {
      return { lineLimit: 10, fromEnd: cmd === "tail" };
    }
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  if (rest.length === 2 && /^-\d+$/.test(rest[0])) {
    const count = Number(rest[0]);
    if (!Number.isFinite(count))
      return null;
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  if (rest.length === 2 && rest[0] === "-n") {
    const count = Number(rest[1]);
    if (!Number.isFinite(count))
      return null;
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  if (rest.length === 3 && rest[0] === "-n") {
    const count = Number(rest[1]);
    if (!Number.isFinite(count))
      return null;
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  return null;
}
function isValidPipelineHeadTailStage(stage) {
  const tokens = tokenizeShellWords(stage);
  if (!tokens || tokens[0] !== "head" && tokens[0] !== "tail")
    return false;
  if (tokens.length === 1)
    return true;
  if (tokens.length === 2)
    return /^-\d+$/.test(tokens[1]);
  if (tokens.length === 3)
    return tokens[1] === "-n" && /^-?\d+$/.test(tokens[2]);
  return false;
}
function parseFindNamePatterns(tokens) {
  const patterns = [];
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-type") {
      i += 1;
      continue;
    }
    if (token === "-o")
      continue;
    if (token === "-name") {
      const pattern = tokens[i + 1];
      if (!pattern)
        return null;
      patterns.push(pattern);
      i += 1;
      continue;
    }
    return null;
  }
  return patterns.length > 0 ? patterns : null;
}
function parseCompiledSegment(segment) {
  const { clean, ignoreMissing } = stripAllowedModifiers(segment);
  if (hasUnsupportedRedirection(clean))
    return null;
  const pipeline = splitTopLevel(clean, ["|"]);
  if (!pipeline || pipeline.length === 0)
    return null;
  const tokens = tokenizeShellWords(pipeline[0]);
  if (!tokens || tokens.length === 0)
    return null;
  if (tokens[0] === "echo" && pipeline.length === 1) {
    const text = tokens.slice(1).join(" ");
    return { kind: "echo", text };
  }
  if (tokens[0] === "cat") {
    const paths = tokens.slice(1).flatMap(expandBraceToken);
    if (paths.length === 0)
      return null;
    let lineLimit = 0;
    let fromEnd = false;
    let countLines2 = false;
    if (pipeline.length > 1) {
      if (pipeline.length !== 2)
        return null;
      const pipeStage = pipeline[1].trim();
      if (/^wc\s+-l\s*$/.test(pipeStage)) {
        if (paths.length !== 1)
          return null;
        countLines2 = true;
      } else {
        if (!isValidPipelineHeadTailStage(pipeStage))
          return null;
        const headTail = parseHeadTailStage(pipeStage);
        if (!headTail)
          return null;
        lineLimit = headTail.lineLimit;
        fromEnd = headTail.fromEnd;
      }
    }
    return { kind: "cat", paths, lineLimit, fromEnd, countLines: countLines2, ignoreMissing };
  }
  if (tokens[0] === "head" || tokens[0] === "tail") {
    if (pipeline.length !== 1)
      return null;
    const parsed = parseHeadTailStage(clean);
    if (!parsed)
      return null;
    const headTokens = tokenizeShellWords(clean);
    if (!headTokens)
      return null;
    if (headTokens[1] === "-n" && headTokens.length < 4 || /^-\d+$/.test(headTokens[1] ?? "") && headTokens.length < 3 || headTokens.length === 2 && /^-?\d+$/.test(headTokens[1] ?? ""))
      return null;
    const path = headTokens[headTokens.length - 1];
    if (path === "head" || path === "tail" || path === "-n")
      return null;
    return {
      kind: "cat",
      paths: expandBraceToken(path),
      lineLimit: parsed.lineLimit,
      fromEnd: parsed.fromEnd,
      countLines: false,
      ignoreMissing
    };
  }
  if (tokens[0] === "wc" && tokens[1] === "-l" && pipeline.length === 1 && tokens[2]) {
    return {
      kind: "cat",
      paths: expandBraceToken(tokens[2]),
      lineLimit: 0,
      fromEnd: false,
      countLines: true,
      ignoreMissing
    };
  }
  if (tokens[0] === "ls" && pipeline.length === 1) {
    const dirs = tokens.slice(1).filter((token) => !token.startsWith("-")).flatMap(expandBraceToken);
    const longFormat = tokens.some((token) => token.startsWith("-") && token.includes("l"));
    return { kind: "ls", dirs: dirs.length > 0 ? dirs : ["/"], longFormat };
  }
  if (tokens[0] === "find") {
    if (pipeline.length > 3)
      return null;
    const dir = tokens[1];
    if (!dir)
      return null;
    const patterns = parseFindNamePatterns(tokens);
    if (!patterns)
      return null;
    const countOnly = pipeline.length === 2 && /^wc\s+-l\s*$/.test(pipeline[1].trim());
    if (countOnly) {
      if (patterns.length !== 1)
        return null;
      return { kind: "find", dir, pattern: patterns[0], countOnly };
    }
    if (pipeline.length >= 2) {
      const xargsTokens = tokenizeShellWords(pipeline[1].trim());
      if (!xargsTokens || xargsTokens[0] !== "xargs")
        return null;
      const xargsArgs = xargsTokens.slice(1);
      while (xargsArgs[0] && xargsArgs[0].startsWith("-")) {
        if (xargsArgs[0] === "-r") {
          xargsArgs.shift();
          continue;
        }
        return null;
      }
      const grepCmd = xargsArgs.join(" ");
      const grepParams2 = parseBashGrep(grepCmd);
      if (!grepParams2)
        return null;
      let lineLimit = 0;
      if (pipeline.length === 3) {
        const headStage = pipeline[2].trim();
        if (!isValidPipelineHeadTailStage(headStage))
          return null;
        const headTail = parseHeadTailStage(headStage);
        if (!headTail || headTail.fromEnd)
          return null;
        lineLimit = headTail.lineLimit;
      }
      return { kind: "find_grep", dir, patterns, params: grepParams2, lineLimit };
    }
    if (patterns.length !== 1)
      return null;
    return { kind: "find", dir, pattern: patterns[0], countOnly };
  }
  const grepParams = parseBashGrep(clean);
  if (grepParams) {
    let lineLimit = 0;
    if (pipeline.length > 1) {
      if (pipeline.length !== 2)
        return null;
      const headStage = pipeline[1].trim();
      if (!isValidPipelineHeadTailStage(headStage))
        return null;
      const headTail = parseHeadTailStage(headStage);
      if (!headTail || headTail.fromEnd)
        return null;
      lineLimit = headTail.lineLimit;
    }
    return { kind: "grep", params: grepParams, lineLimit };
  }
  return null;
}
function parseCompiledBashCommand(cmd) {
  if (cmd.includes("||"))
    return null;
  const segments = splitTopLevel(cmd, ["&&", ";", "\n"]);
  if (!segments || segments.length === 0)
    return null;
  const parsed = segments.map(parseCompiledSegment);
  if (parsed.some((segment) => segment === null))
    return null;
  return parsed;
}
function applyLineWindow(content, lineLimit, fromEnd) {
  if (lineLimit <= 0)
    return content;
  const lines = content.split("\n");
  return (fromEnd ? lines.slice(-lineLimit) : lines.slice(0, lineLimit)).join("\n");
}
function countLines(content) {
  return content === "" ? 0 : content.split("\n").length;
}
function renderDirectoryListing(dir, rows, longFormat) {
  const entries = /* @__PURE__ */ new Map();
  const prefix = dir === "/" ? "/" : `${dir}/`;
  for (const row of rows) {
    const path = row["path"];
    if (!path.startsWith(prefix) && dir !== "/")
      continue;
    const rest = dir === "/" ? path.slice(1) : path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (!name)
      continue;
    const existing = entries.get(name);
    if (slash !== -1) {
      if (!existing)
        entries.set(name, { isDir: true, size: 0 });
    } else {
      entries.set(name, { isDir: false, size: Number(row["size_bytes"] ?? 0) });
    }
  }
  if (entries.size === 0)
    return `ls: cannot access '${dir}': No such file or directory`;
  const lines = [];
  for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (longFormat) {
      const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
      const size = String(info.isDir ? 0 : info.size).padStart(6);
      lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
    } else {
      lines.push(name + (info.isDir ? "/" : ""));
    }
  }
  return lines.join("\n");
}
async function executeCompiledBashCommand(api, memoryTable, sessionsTable, cmd, deps = {}) {
  const { readVirtualPathContentsFn = readVirtualPathContents, listVirtualPathRowsForDirsFn = listVirtualPathRowsForDirs, findVirtualPathsFn = findVirtualPaths, handleGrepDirectFn = handleGrepDirect } = deps;
  const plan = parseCompiledBashCommand(cmd);
  if (!plan)
    return null;
  const readPaths = [...new Set(plan.flatMap((segment) => segment.kind === "cat" ? segment.paths : []))];
  const listDirs = [...new Set(plan.flatMap((segment) => segment.kind === "ls" ? segment.dirs.map((dir) => dir.replace(/\/+$/, "") || "/") : []))];
  const contentMap = readPaths.length > 0 ? await readVirtualPathContentsFn(api, memoryTable, sessionsTable, readPaths) : /* @__PURE__ */ new Map();
  const dirRowsMap = listDirs.length > 0 ? await listVirtualPathRowsForDirsFn(api, memoryTable, sessionsTable, listDirs) : /* @__PURE__ */ new Map();
  const outputs = [];
  for (const segment of plan) {
    if (segment.kind === "echo") {
      outputs.push(segment.text);
      continue;
    }
    if (segment.kind === "cat") {
      const contents = [];
      for (const path of segment.paths) {
        const content = contentMap.get(path) ?? null;
        if (content === null) {
          if (segment.ignoreMissing)
            continue;
          return null;
        }
        contents.push(content);
      }
      const combined = contents.join("");
      if (segment.countLines) {
        outputs.push(`${countLines(combined)} ${segment.paths[0]}`);
      } else {
        outputs.push(applyLineWindow(combined, segment.lineLimit, segment.fromEnd));
      }
      continue;
    }
    if (segment.kind === "ls") {
      for (const dir of segment.dirs) {
        outputs.push(renderDirectoryListing(dir.replace(/\/+$/, "") || "/", dirRowsMap.get(dir.replace(/\/+$/, "") || "/") ?? [], segment.longFormat));
      }
      continue;
    }
    if (segment.kind === "find") {
      const filenamePattern = sqlLike(segment.pattern).replace(/\*/g, "%").replace(/\?/g, "_");
      const paths = await findVirtualPathsFn(api, memoryTable, sessionsTable, segment.dir.replace(/\/+$/, "") || "/", filenamePattern);
      outputs.push(segment.countOnly ? String(paths.length) : paths.join("\n") || "(no matches)");
      continue;
    }
    if (segment.kind === "find_grep") {
      const dir = segment.dir.replace(/\/+$/, "") || "/";
      const candidateBatches = await Promise.all(segment.patterns.map((pattern) => findVirtualPathsFn(api, memoryTable, sessionsTable, dir, sqlLike(pattern).replace(/\*/g, "%").replace(/\?/g, "_"))));
      const candidatePaths = [...new Set(candidateBatches.flat())];
      if (candidatePaths.length === 0) {
        outputs.push("(no matches)");
        continue;
      }
      const candidateContents = await readVirtualPathContentsFn(api, memoryTable, sessionsTable, candidatePaths);
      const matched = refineGrepMatches(candidatePaths.flatMap((path) => {
        const content = candidateContents.get(path);
        if (content === null || content === void 0)
          return [];
        return [{ path, content: normalizeContent(path, content) }];
      }), segment.params);
      const limited = segment.lineLimit > 0 ? matched.slice(0, segment.lineLimit) : matched;
      outputs.push(limited.join("\n") || "(no matches)");
      continue;
    }
    if (segment.kind === "grep") {
      const result = await handleGrepDirectFn(api, memoryTable, sessionsTable, segment.params);
      if (result === null)
        return null;
      if (segment.lineLimit > 0) {
        outputs.push(result.split("\n").slice(0, segment.lineLimit).join("\n"));
      } else {
        outputs.push(result);
      }
      continue;
    }
  }
  return outputs.join("\n");
}

// dist/src/hooks/query-cache.js
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
import { homedir as homedir3 } from "node:os";
var log3 = (msg) => log("query-cache", msg);
var DEFAULT_CACHE_ROOT = join4(homedir3(), ".deeplake", "query-cache");
var INDEX_CACHE_FILE = "index.md";
function getSessionQueryCacheDir(sessionId, deps = {}) {
  const { cacheRoot = DEFAULT_CACHE_ROOT } = deps;
  return join4(cacheRoot, sessionId);
}
function readCachedIndexContent(sessionId, deps = {}) {
  const { logFn = log3 } = deps;
  try {
    return readFileSync3(join4(getSessionQueryCacheDir(sessionId, deps), INDEX_CACHE_FILE), "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT")
      return null;
    logFn(`read failed for session=${sessionId}: ${e.message}`);
    return null;
  }
}
function writeCachedIndexContent(sessionId, content, deps = {}) {
  const { logFn = log3 } = deps;
  try {
    const dir = getSessionQueryCacheDir(sessionId, deps);
    mkdirSync2(dir, { recursive: true });
    writeFileSync2(join4(dir, INDEX_CACHE_FILE), content, "utf-8");
  } catch (e) {
    logFn(`write failed for session=${sessionId}: ${e.message}`);
  }
}

// dist/src/hooks/memory-path-utils.js
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";
var MEMORY_PATH = join5(homedir4(), ".deeplake", "memory");
var TILDE_PATH = "~/.deeplake/memory";
var HOME_VAR_PATH = "$HOME/.deeplake/memory";
var SAFE_BUILTINS = /* @__PURE__ */ new Set([
  "cat",
  "ls",
  "cp",
  "mv",
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "ln",
  "chmod",
  "stat",
  "readlink",
  "du",
  "tree",
  "file",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "sed",
  "awk",
  "cut",
  "tr",
  "sort",
  "uniq",
  "wc",
  "head",
  "tail",
  "tac",
  "rev",
  "nl",
  "fold",
  "expand",
  "unexpand",
  "paste",
  "join",
  "comm",
  "column",
  "diff",
  "strings",
  "split",
  "find",
  "xargs",
  "which",
  "jq",
  "yq",
  "xan",
  "base64",
  "od",
  "tar",
  "gzip",
  "gunzip",
  "zcat",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "echo",
  "printf",
  "tee",
  "pwd",
  "cd",
  "basename",
  "dirname",
  "env",
  "printenv",
  "hostname",
  "whoami",
  "date",
  "seq",
  "expr",
  "sleep",
  "timeout",
  "time",
  "true",
  "false",
  "test",
  "alias",
  "unalias",
  "history",
  "help",
  "clear",
  "for",
  "while",
  "do",
  "done",
  "if",
  "then",
  "else",
  "fi",
  "case",
  "esac"
]);
function isSafe(cmd) {
  if (/\$\(|`|<\(/.test(cmd))
    return false;
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const stages = stripped.split(/\||;|&&|\|\||\n/);
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken))
      return false;
  }
  return true;
}
function touchesMemory(p) {
  return p.includes(MEMORY_PATH) || p.includes(TILDE_PATH) || p.includes(HOME_VAR_PATH);
}
function rewritePaths(cmd) {
  return cmd.replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/").replace(/~\/.deeplake\/memory\/?/g, "/").replace(/\$HOME\/.deeplake\/memory\/?/g, "/").replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}

// dist/src/hooks/pre-tool-use.js
var log4 = (msg) => log("pre", msg);
var __bundleDir = dirname(fileURLToPath2(import.meta.url));
var SHELL_BUNDLE = existsSync3(join6(__bundleDir, "shell", "deeplake-shell.js")) ? join6(__bundleDir, "shell", "deeplake-shell.js") : join6(__bundleDir, "..", "shell", "deeplake-shell.js");
function getReadTargetPath(toolInput) {
  const rawPath = toolInput.file_path ?? toolInput.path;
  return rawPath ? rawPath : null;
}
function isLikelyDirectoryPath(virtualPath) {
  const normalized = virtualPath.replace(/\/+$/, "") || "/";
  if (normalized === "/")
    return true;
  const base = normalized.split("/").pop() ?? "";
  return !base.includes(".");
}
function getShellCommand(toolName, toolInput) {
  switch (toolName) {
    case "Grep": {
      const p = toolInput.path;
      if (p && touchesMemory(p)) {
        const pattern = toolInput.pattern ?? "";
        const flags = ["-r"];
        if (toolInput["-i"])
          flags.push("-i");
        if (toolInput["-n"])
          flags.push("-n");
        return `grep ${flags.join(" ")} '${pattern}' /`;
      }
      break;
    }
    case "Read": {
      const fp = getReadTargetPath(toolInput);
      if (fp && touchesMemory(fp)) {
        const rewritten = rewritePaths(fp) || "/";
        return `${isLikelyDirectoryPath(rewritten) ? "ls" : "cat"} ${rewritten}`;
      }
      break;
    }
    case "Bash": {
      const cmd = toolInput.command;
      if (!cmd || !touchesMemory(cmd))
        break;
      const rewritten = rewritePaths(cmd);
      if (!isSafe(rewritten)) {
        log4(`unsafe command blocked: ${rewritten}`);
        return null;
      }
      return rewritten;
    }
    case "Glob": {
      const p = toolInput.path;
      if (p && touchesMemory(p))
        return "ls /";
      break;
    }
  }
  return null;
}
function buildAllowDecision(command, description) {
  return { command, description };
}
function extractGrepParams(toolName, toolInput, shellCmd) {
  if (toolName === "Grep") {
    const outputMode = toolInput.output_mode ?? "files_with_matches";
    return {
      pattern: toolInput.pattern ?? "",
      targetPath: rewritePaths(toolInput.path ?? "") || "/",
      ignoreCase: !!toolInput["-i"],
      wordMatch: false,
      filesOnly: outputMode === "files_with_matches",
      countOnly: outputMode === "count",
      lineNumber: !!toolInput["-n"],
      invertMatch: false,
      fixedString: false
    };
  }
  if (toolName === "Bash")
    return parseBashGrep(shellCmd);
  return null;
}
function buildFallbackDecision(shellCmd, shellBundle = SHELL_BUNDLE) {
  return buildAllowDecision(`node "${shellBundle}" -c "${shellCmd.replace(/"/g, '\\"')}"`, `[DeepLake shell] ${shellCmd}`);
}
async function processPreToolUse(input, deps = {}) {
  const { config = loadConfig(), createApi = (table2, activeConfig) => new DeeplakeApi(activeConfig.token, activeConfig.apiUrl, activeConfig.orgId, activeConfig.workspaceId, table2), executeCompiledBashCommandFn = executeCompiledBashCommand, handleGrepDirectFn = handleGrepDirect, readVirtualPathContentsFn = readVirtualPathContents, readVirtualPathContentFn = readVirtualPathContent, listVirtualPathRowsFn = listVirtualPathRows, findVirtualPathsFn = findVirtualPaths, readCachedIndexContentFn = readCachedIndexContent, writeCachedIndexContentFn = writeCachedIndexContent, shellBundle = SHELL_BUNDLE, logFn = log4 } = deps;
  const cmd = input.tool_input.command ?? "";
  const shellCmd = getShellCommand(input.tool_name, input.tool_input);
  const toolPath = getReadTargetPath(input.tool_input) ?? input.tool_input.path ?? "";
  if (!shellCmd && (touchesMemory(cmd) || touchesMemory(toolPath))) {
    const guidance = "[RETRY REQUIRED] The command you tried is not available for ~/.deeplake/memory/. This virtual filesystem only supports bash builtins: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find, etc. python, python3, node, and curl are NOT available. You MUST rewrite your command using only the bash tools listed above and try again. For example, to parse JSON use: cat file.json | jq '.key'. To count keys: cat file.json | jq 'keys | length'.";
    logFn(`unsupported command, returning guidance: ${cmd}`);
    return buildAllowDecision(`echo ${JSON.stringify(guidance)}`, "[DeepLake] unsupported command \u2014 rewrite using bash builtins");
  }
  if (!shellCmd)
    return null;
  if (!config)
    return buildFallbackDecision(shellCmd, shellBundle);
  const table = process.env["HIVEMIND_TABLE"] ?? "memory";
  const sessionsTable = process.env["HIVEMIND_SESSIONS_TABLE"] ?? "sessions";
  const api = createApi(table, config);
  const readVirtualPathContentsWithCache = async (cachePaths) => {
    const uniquePaths = [...new Set(cachePaths)];
    const result = new Map(uniquePaths.map((path) => [path, null]));
    const cachedIndex = uniquePaths.includes("/index.md") ? readCachedIndexContentFn(input.session_id) : null;
    const remainingPaths = cachedIndex === null ? uniquePaths : uniquePaths.filter((path) => path !== "/index.md");
    if (cachedIndex !== null) {
      result.set("/index.md", cachedIndex);
    }
    if (remainingPaths.length > 0) {
      const fetched = await readVirtualPathContentsFn(api, table, sessionsTable, remainingPaths);
      for (const [path, content] of fetched)
        result.set(path, content);
    }
    const fetchedIndex = result.get("/index.md");
    if (typeof fetchedIndex === "string") {
      writeCachedIndexContentFn(input.session_id, fetchedIndex);
    }
    return result;
  };
  try {
    if (input.tool_name === "Bash") {
      const compiled = await executeCompiledBashCommandFn(api, table, sessionsTable, shellCmd, {
        readVirtualPathContentsFn: async (_api, _memoryTable, _sessionsTable, cachePaths) => readVirtualPathContentsWithCache(cachePaths)
      });
      if (compiled !== null) {
        return buildAllowDecision(`echo ${JSON.stringify(compiled)}`, `[DeepLake compiled] ${shellCmd}`);
      }
    }
    const grepParams = extractGrepParams(input.tool_name, input.tool_input, shellCmd);
    if (grepParams) {
      logFn(`direct grep: pattern=${grepParams.pattern} path=${grepParams.targetPath}`);
      const result = await handleGrepDirectFn(api, table, sessionsTable, grepParams);
      if (result !== null)
        return buildAllowDecision(`echo ${JSON.stringify(result)}`, `[DeepLake direct] grep ${grepParams.pattern}`);
    }
    let virtualPath = null;
    let lineLimit = 0;
    let fromEnd = false;
    let lsDir = null;
    let longFormat = false;
    if (input.tool_name === "Read") {
      virtualPath = rewritePaths(getReadTargetPath(input.tool_input) ?? "");
      if (virtualPath && isLikelyDirectoryPath(virtualPath)) {
        lsDir = virtualPath.replace(/\/+$/, "") || "/";
        virtualPath = null;
      }
    } else if (input.tool_name === "Bash") {
      const catCmd = shellCmd.replace(/\s+2>\S+/g, "").trim();
      const catPipeHead = catCmd.match(/^cat\s+(\S+?)\s*(?:\|[^|]*)*\|\s*head\s+(?:-n?\s*)?(-?\d+)\s*$/);
      if (catPipeHead) {
        virtualPath = catPipeHead[1];
        lineLimit = Math.abs(parseInt(catPipeHead[2], 10));
      }
      if (!virtualPath) {
        const catMatch = catCmd.match(/^cat\s+(\S+)\s*$/);
        if (catMatch)
          virtualPath = catMatch[1];
      }
      if (!virtualPath) {
        const headMatch = shellCmd.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ?? shellCmd.match(/^head\s+(\S+)\s*$/);
        if (headMatch) {
          if (headMatch[2]) {
            virtualPath = headMatch[2];
            lineLimit = Math.abs(parseInt(headMatch[1], 10));
          } else {
            virtualPath = headMatch[1];
            lineLimit = 10;
          }
        }
      }
      if (!virtualPath) {
        const tailMatch = shellCmd.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ?? shellCmd.match(/^tail\s+(\S+)\s*$/);
        if (tailMatch) {
          fromEnd = true;
          if (tailMatch[2]) {
            virtualPath = tailMatch[2];
            lineLimit = Math.abs(parseInt(tailMatch[1], 10));
          } else {
            virtualPath = tailMatch[1];
            lineLimit = 10;
          }
        }
      }
      if (!virtualPath) {
        const wcMatch = shellCmd.match(/^wc\s+-l\s+(\S+)\s*$/);
        if (wcMatch) {
          virtualPath = wcMatch[1];
          lineLimit = -1;
        }
      }
    }
    if (virtualPath && !virtualPath.endsWith("/")) {
      logFn(`direct read: ${virtualPath}`);
      let content = virtualPath === "/index.md" ? readCachedIndexContentFn(input.session_id) : null;
      if (content === null) {
        content = await readVirtualPathContentFn(api, table, sessionsTable, virtualPath);
      }
      if (content === null && virtualPath === "/index.md") {
        const idxRows = await api.query(`SELECT path, project, description, creation_date FROM "${table}" WHERE path LIKE '/summaries/%' ORDER BY creation_date DESC`);
        const lines = ["# Memory Index", "", `${idxRows.length} sessions:`, ""];
        for (const r of idxRows) {
          const p = r["path"];
          const proj = r["project"] || "";
          const desc = (r["description"] || "").slice(0, 120);
          const date = (r["creation_date"] || "").slice(0, 10);
          lines.push(`- [${p}](${p}) ${date} ${proj ? `[${proj}]` : ""} ${desc}`);
        }
        content = lines.join("\n");
      }
      if (content !== null) {
        if (virtualPath === "/index.md") {
          writeCachedIndexContentFn(input.session_id, content);
        }
        if (lineLimit === -1)
          return buildAllowDecision(`echo ${JSON.stringify(`${content.split("\n").length} ${virtualPath}`)}`, `[DeepLake direct] wc -l ${virtualPath}`);
        if (lineLimit > 0) {
          const lines = content.split("\n");
          content = fromEnd ? lines.slice(-lineLimit).join("\n") : lines.slice(0, lineLimit).join("\n");
        }
        const label = lineLimit > 0 ? fromEnd ? `tail -${lineLimit}` : `head -${lineLimit}` : "cat";
        return buildAllowDecision(`echo ${JSON.stringify(content)}`, `[DeepLake direct] ${label} ${virtualPath}`);
      }
    }
    if (!lsDir && input.tool_name === "Glob") {
      lsDir = rewritePaths(input.tool_input.path ?? "") || "/";
    } else if (input.tool_name === "Bash") {
      const lsMatch = shellCmd.match(/^ls\s+(?:-([a-zA-Z]+)\s+)?(\S+)?\s*$/);
      if (lsMatch) {
        lsDir = lsMatch[2] ?? "/";
        longFormat = (lsMatch[1] ?? "").includes("l");
      }
    }
    if (lsDir) {
      const dir = lsDir.replace(/\/+$/, "") || "/";
      logFn(`direct ls: ${dir}`);
      const rows = await listVirtualPathRowsFn(api, table, sessionsTable, dir);
      const entries = /* @__PURE__ */ new Map();
      const prefix = dir === "/" ? "/" : dir + "/";
      for (const row of rows) {
        const p = row["path"];
        if (!p.startsWith(prefix) && dir !== "/")
          continue;
        const rest = dir === "/" ? p.slice(1) : p.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (!name)
          continue;
        const existing = entries.get(name);
        if (slash !== -1) {
          if (!existing)
            entries.set(name, { isDir: true, size: 0 });
        } else {
          entries.set(name, { isDir: false, size: row["size_bytes"] ?? 0 });
        }
      }
      const lines = [];
      for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (longFormat) {
          const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
          const size = String(info.isDir ? 0 : info.size).padStart(6);
          lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
        } else {
          lines.push(name + (info.isDir ? "/" : ""));
        }
      }
      return buildAllowDecision(`echo ${JSON.stringify(lines.join("\n") || "(empty directory)")}`, `[DeepLake direct] ls ${dir}`);
    }
    if (input.tool_name === "Bash") {
      const findMatch = shellCmd.match(/^find\s+(\S+)\s+(?:-type\s+\S+\s+)?-name\s+'([^']+)'/);
      if (findMatch) {
        const dir = findMatch[1].replace(/\/+$/, "") || "/";
        const namePattern = sqlLike(findMatch[2]).replace(/\*/g, "%").replace(/\?/g, "_");
        logFn(`direct find: ${dir} -name '${findMatch[2]}'`);
        const paths = await findVirtualPathsFn(api, table, sessionsTable, dir, namePattern);
        let result = paths.join("\n") || "";
        if (/\|\s*wc\s+-l\s*$/.test(shellCmd))
          result = String(paths.length);
        return buildAllowDecision(`echo ${JSON.stringify(result || "(no matches)")}`, `[DeepLake direct] find ${dir}`);
      }
    }
  } catch (e) {
    logFn(`direct query failed, falling back to shell: ${e.message}`);
  }
  return buildFallbackDecision(shellCmd, shellBundle);
}
async function main() {
  const input = await readStdin();
  const decision = await processPreToolUse(input);
  if (!decision)
    return;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: decision
    }
  }));
}
if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    log4(`fatal: ${e.message}`);
    process.exit(0);
  });
}
export {
  buildAllowDecision,
  extractGrepParams,
  getShellCommand,
  isSafe,
  processPreToolUse,
  rewritePaths,
  touchesMemory
};
