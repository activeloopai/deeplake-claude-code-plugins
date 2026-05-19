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
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
import { tmpdir } from "node:os";
function getIndexMarkerDir() {
  return process.env.HIVEMIND_INDEX_MARKER_DIR ?? join4(tmpdir(), "hivemind-deeplake-indexes");
}
function buildIndexMarkerPath(workspaceId, orgId, table, suffix) {
  const markerKey = [workspaceId, orgId, table, suffix].join("__").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join4(getIndexMarkerDir(), `${markerKey}.json`);
}
function hasFreshIndexMarker(markerPath) {
  if (!existsSync2(markerPath))
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
function writeIndexMarker(markerPath) {
  mkdirSync2(getIndexMarkerDir(), { recursive: true });
  writeFileSync2(markerPath, JSON.stringify({ updatedAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf-8");
}
var INDEX_MARKER_TTL_MS;
var init_index_marker_store = __esm({
  "dist/src/index-marker-store.js"() {
    "use strict";
    INDEX_MARKER_TTL_MS = Number(process.env.HIVEMIND_INDEX_MARKER_TTL_MS ?? 6 * 60 * 6e4);
  }
});

// dist/src/hooks/hermes/session-start.js
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname7 } from "node:path";

// dist/src/commands/auth.js
import { execSync } from "node:child_process";

// dist/src/utils/client-header.js
var DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
function deeplakeClientValue() {
  return "hivemind";
}
function deeplakeClientHeader() {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}

// dist/src/commands/auth-creds.js
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
function configDir() {
  return join(homedir(), ".deeplake");
}
function credsPath() {
  return join(configDir(), "credentials.json");
}
function loadCredentials() {
  try {
    return JSON.parse(readFileSync(credsPath(), "utf-8"));
  } catch {
    return null;
  }
}

// dist/src/config.js
import { readFileSync as readFileSync2, existsSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2, userInfo } from "node:os";
function loadConfig() {
  const home = homedir2();
  const credPath = join2(home, ".deeplake", "credentials.json");
  let creds = null;
  if (existsSync(credPath)) {
    try {
      creds = JSON.parse(readFileSync2(credPath, "utf-8"));
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
    memoryPath: process.env.HIVEMIND_MEMORY_PATH ?? join2(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var LOG = join3(homedir3(), ".deeplake", "hook-debug.log");
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
var MESSAGE_EMBEDDING_COL = "message_embedding";

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

// dist/src/cli/skillify-spec.js
var SKILLIFY_COMMANDS = [
  { cmd: "hivemind skillify", desc: "show scope, team, install, per-project state" },
  { cmd: "hivemind skillify pull", desc: "sync project skills from the org table to local FS" },
  { cmd: "hivemind skillify pull --user <email>", desc: "only skills authored by that user" },
  { cmd: "hivemind skillify pull --users <a,b,c>", desc: "only skills from those authors" },
  { cmd: "hivemind skillify pull --all-users", desc: 'explicit "no author filter" (default)' },
  { cmd: "hivemind skillify pull --to <project|global>", desc: "install location (project=cwd/.claude/skills, global=~/.claude/skills)" },
  { cmd: "hivemind skillify pull --dry-run", desc: "preview without touching disk" },
  { cmd: "hivemind skillify pull --force", desc: "overwrite local files even if up-to-date (creates .bak)" },
  { cmd: "hivemind skillify pull <skill-name>", desc: "pull only that one skill (combines with --user)" },
  { cmd: "hivemind skillify unpull", desc: "remove every skill previously installed by pull" },
  { cmd: "hivemind skillify unpull --user <email>", desc: "remove only that author's pulls" },
  { cmd: "hivemind skillify unpull --not-mine", desc: "remove all pulls except your own" },
  { cmd: "hivemind skillify unpull --dry-run", desc: "preview without touching disk" },
  { cmd: "hivemind skillify scope <me|team|org>", desc: "sharing scope for newly mined skills" },
  { cmd: "hivemind skillify install <project|global>", desc: "default install location for new skills" },
  { cmd: "hivemind skillify promote <skill-name>", desc: "move a project skill to the global location" },
  { cmd: "hivemind skillify team add|remove|list <name>", desc: "manage team member list" },
  { cmd: "hivemind skillify mine-local", desc: "one-shot: mine skills from local sessions (no auth needed)" },
  { cmd: "hivemind skillify mine-local --n <num|all>", desc: "how many sessions to mine (default: 8)" },
  { cmd: "hivemind skillify mine-local --force", desc: "re-run even if the manifest sentinel exists" },
  { cmd: "hivemind skillify mine-local --dry-run", desc: "stop before calling the LLM gate" }
];
function renderSkillifyCommands() {
  const maxLen = Math.max(...SKILLIFY_COMMANDS.map((c) => c.cmd.length));
  return SKILLIFY_COMMANDS.map((c) => `- ${c.cmd.padEnd(maxLen + 2)} \u2014 ${c.desc}`).join("\n");
}

// dist/src/skillify/local-manifest.js
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname, join as join5 } from "node:path";
var LOCAL_MANIFEST_PATH = join5(homedir4(), ".claude", "hivemind", "local-mined.json");
var LOCAL_MINE_LOCK_PATH = join5(homedir4(), ".claude", "hivemind", "local-mined.lock");
function readLocalManifest(path = LOCAL_MANIFEST_PATH) {
  if (!existsSync3(path))
    return null;
  try {
    return JSON.parse(readFileSync4(path, "utf-8"));
  } catch {
    return null;
  }
}
function countLocalManifestEntries(path = LOCAL_MANIFEST_PATH) {
  const m = readLocalManifest(path);
  return Array.isArray(m?.entries) ? m.entries.length : 0;
}

// dist/src/skillify/spawn-mine-local-worker.js
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync as existsSync4, mkdirSync as mkdirSync4, openSync, readdirSync, statSync, unlinkSync as unlinkSync2 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { dirname as dirname2, join as join6 } from "node:path";
import { fileURLToPath } from "node:url";
var HOME = homedir5();
var HIVEMIND_DIR = join6(HOME, ".claude", "hivemind");
var LOG_PATH = join6(HOME, ".claude", "hooks", "mine-local.log");
var CLAUDE_PROJECTS_DIR = join6(HOME, ".claude", "projects");
var LOCK_STALE_MS = 15 * 60 * 1e3;
function findBundledCliPath() {
  try {
    const thisDir = dirname2(fileURLToPath(import.meta.url));
    const cliPath = join6(thisDir, "..", "..", "bundle", "cli.js");
    return existsSync4(cliPath) ? cliPath : null;
  } catch {
    return null;
  }
}
function findHivemindLauncher() {
  const bundled = findBundledCliPath();
  if (bundled)
    return { kind: "node-script", path: bundled };
  try {
    const out = execFileSync("which", ["hivemind"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const bin = out.trim();
    return bin ? { kind: "bin", path: bin } : null;
  } catch {
    return null;
  }
}
function hasLocalClaudeSessions() {
  if (!existsSync4(CLAUDE_PROJECTS_DIR))
    return false;
  let subdirs;
  try {
    subdirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return false;
  }
  for (const sub of subdirs) {
    let files;
    try {
      files = readdirSync(join6(CLAUDE_PROJECTS_DIR, sub));
    } catch {
      continue;
    }
    if (files.some((f) => f.endsWith(".jsonl")))
      return true;
  }
  return false;
}
function maybeAutoMineLocal() {
  if (existsSync4(LOCAL_MANIFEST_PATH))
    return { triggered: false, reason: "manifest-exists" };
  if (existsSync4(LOCAL_MINE_LOCK_PATH)) {
    let stale = false;
    try {
      const stats = statSync(LOCAL_MINE_LOCK_PATH);
      stale = Date.now() - stats.mtimeMs > LOCK_STALE_MS;
    } catch {
    }
    if (!stale)
      return { triggered: false, reason: "lock-exists" };
    try {
      unlinkSync2(LOCAL_MINE_LOCK_PATH);
    } catch {
      return { triggered: false, reason: "lock-exists" };
    }
  }
  if (!hasLocalClaudeSessions())
    return { triggered: false, reason: "no-claude-sessions" };
  const launcher = findHivemindLauncher();
  if (!launcher)
    return { triggered: false, reason: "no-hivemind-bin" };
  try {
    mkdirSync4(HIVEMIND_DIR, { recursive: true });
    const fd = openSync(LOCAL_MINE_LOCK_PATH, "wx");
    closeSync(fd);
  } catch {
    return { triggered: false, reason: "lock-acquire-failed" };
  }
  try {
    mkdirSync4(join6(HOME, ".claude", "hooks"), { recursive: true });
    const out = openSync(LOG_PATH, "a");
    const [cmd, args] = launcher.kind === "node-script" ? [process.execPath, [launcher.path, "skillify", "mine-local"]] : [launcher.path, ["skillify", "mine-local"]];
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env
    });
    closeSync(out);
    child.unref();
    return { triggered: true };
  } catch {
    try {
      unlinkSync2(LOCAL_MINE_LOCK_PATH);
    } catch {
    }
    return { triggered: false, reason: "spawn-failed" };
  }
}

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

// dist/src/utils/version-check.js
import { readFileSync as readFileSync5 } from "node:fs";
import { dirname as dirname3, join as join7 } from "node:path";
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join7(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync5(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  try {
    const stamp = readFileSync5(join7(bundleDir, "..", ".hivemind_version"), "utf-8").trim();
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
    const candidate = join7(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync5(candidate, "utf-8"));
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

// dist/src/hooks/shared/autoupdate.js
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync5 } from "node:fs";
import { join as join8 } from "node:path";
var log3 = (msg) => log("autoupdate", msg);
var defaultSpawn = (cmd, args) => {
  const child = spawn2(cmd, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  child.on("error", () => {
  });
  return { pid: child.pid };
};
function findHivemindOnPath() {
  const PATH = process.env.PATH ?? "";
  const dirs = PATH.split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join8(dir, "hivemind");
    if (existsSync5(candidate))
      return candidate;
  }
  return null;
}
async function autoUpdate(creds, opts) {
  const t0 = Date.now();
  log3(`agent=${opts.agent} entered`);
  if (!creds?.token) {
    log3(`agent=${opts.agent} skip: no creds.token (${Date.now() - t0}ms)`);
    return;
  }
  if (creds.autoupdate === false) {
    log3(`agent=${opts.agent} skip: autoupdate=false (${Date.now() - t0}ms)`);
    return;
  }
  const binaryPath = opts.hivemindBinaryPath !== void 0 ? opts.hivemindBinaryPath : findHivemindOnPath();
  if (!binaryPath) {
    log3(`agent=${opts.agent} skip: hivemind binary not on PATH (${Date.now() - t0}ms)`);
    return;
  }
  log3(`agent=${opts.agent} binary=${binaryPath} \u2192 dispatching detached update`);
  const spawnFn = opts.spawn ?? defaultSpawn;
  let pid;
  try {
    pid = spawnFn(binaryPath, ["update"]).pid;
  } catch (e) {
    log3(`agent=${opts.agent} dispatch threw: ${e?.message ?? e} (${Date.now() - t0}ms)`);
    return;
  }
  log3(`agent=${opts.agent} dispatched (pid=${pid ?? "?"}) (${Date.now() - t0}ms total)`);
}

// dist/src/skillify/pull.js
import { existsSync as existsSync10, readFileSync as readFileSync8, writeFileSync as writeFileSync6, mkdirSync as mkdirSync7, renameSync as renameSync3, lstatSync as lstatSync2, readlinkSync, symlinkSync, unlinkSync as unlinkSync4 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { dirname as dirname6, join as join14 } from "node:path";

// dist/src/skillify/skill-writer.js
import { existsSync as existsSync6, mkdirSync as mkdirSync5, readFileSync as readFileSync6, readdirSync as readdirSync2, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join9 } from "node:path";
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
import { existsSync as existsSync8, lstatSync, mkdirSync as mkdirSync6, readFileSync as readFileSync7, renameSync as renameSync2, unlinkSync as unlinkSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname5, join as join12 } from "node:path";

// dist/src/skillify/legacy-migration.js
import { existsSync as existsSync7, renameSync } from "node:fs";
import { dirname as dirname4, join as join11 } from "node:path";

// dist/src/skillify/state-dir.js
import { homedir as homedir7 } from "node:os";
import { join as join10 } from "node:path";
function getStateDir() {
  const override = process.env.HIVEMIND_STATE_DIR?.trim();
  return override && override.length > 0 ? override : join10(homedir7(), ".deeplake", "state", "skillify");
}

// dist/src/skillify/legacy-migration.js
var dlog = (msg) => log("skillify-migrate", msg);
var attemptedFor = /* @__PURE__ */ new Set();
function migrateLegacyStateDir() {
  if (process.env.HIVEMIND_STATE_DIR?.trim())
    return;
  const current = getStateDir();
  if (attemptedFor.has(current))
    return;
  attemptedFor.add(current);
  const legacy = join11(dirname4(current), "skilify");
  if (!existsSync7(legacy))
    return;
  if (existsSync7(current))
    return;
  try {
    renameSync(legacy, current);
    dlog(`migrated ${legacy} -> ${current}`);
  } catch (err) {
    const code = err.code;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      dlog(`migration skipped (${code}); legacy dir left as-is or another process handled it`);
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
  return join12(getStateDir(), "pulled.json");
}
function loadManifest(path = manifestPath()) {
  migrateLegacyStateDir();
  if (!existsSync8(path))
    return emptyManifest();
  let raw;
  try {
    raw = readFileSync7(path, "utf-8");
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
  mkdirSync6(dirname5(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync5(tmp, JSON.stringify(m, null, 2) + "\n", { mode: 384 });
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
      unlinkSync3(path);
    } catch {
    }
  }
}
function pruneOrphanedEntries(path = manifestPath()) {
  const m = loadManifest(path);
  const live = [];
  let pruned = 0;
  for (const e of m.entries) {
    if (existsSync8(join12(e.installRoot, e.dirName))) {
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
import { existsSync as existsSync9 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as join13 } from "node:path";
function resolveDetected(home) {
  const out = [];
  const codexInstalled = existsSync9(join13(home, ".codex"));
  const piInstalled = existsSync9(join13(home, ".pi", "agent"));
  const hermesInstalled = existsSync9(join13(home, ".hermes"));
  if (codexInstalled || piInstalled) {
    out.push(join13(home, ".agents", "skills"));
  }
  if (hermesInstalled) {
    out.push(join13(home, ".hermes", "skills"));
  }
  if (piInstalled) {
    out.push(join13(home, ".pi", "agent", "skills"));
  }
  return out;
}
function detectAgentSkillsRoots(canonicalRoot, home = homedir8()) {
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
    return join14(homedir9(), ".claude", "skills");
  if (!cwd)
    throw new Error("install=project requires a cwd");
  return join14(cwd, ".claude", "skills");
}
function fanOutSymlinks(canonicalDir, dirName, agentRoots) {
  const out = [];
  for (const root of agentRoots) {
    const link = join14(root, dirName);
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
        unlinkSync4(link);
      } catch {
        continue;
      }
    }
    try {
      mkdirSync7(dirname6(link), { recursive: true });
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
    const canonical = join14(entry.installRoot, entry.dirName);
    if (!existsSync10(canonical))
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
  if (!existsSync10(path))
    return null;
  try {
    const text = readFileSync8(path, "utf-8");
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
    const skillDir = join14(root, dirName);
    const skillFile = join14(skillDir, "SKILL.md");
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
      mkdirSync7(skillDir, { recursive: true });
      if (existsSync10(skillFile)) {
        try {
          renameSync3(skillFile, `${skillFile}.bak`);
        } catch {
        }
      }
      writeFileSync6(skillFile, renderSkillFile(row));
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
var log4 = (msg) => log("skillify-autopull", msg);
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
    log4("disabled via HIVEMIND_AUTOPULL_DISABLED=1");
    return { pulled: 0, skipped: true, reason: "disabled" };
  }
  const loadFn = deps.loadConfigFn ?? loadConfig;
  const config = loadFn();
  if (!config) {
    log4("skipped: not logged in");
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
    log4(`pulled scanned=${summary.scanned} wrote=${summary.wrote} skipped=${summary.skipped}`);
    return { pulled: summary.wrote, skipped: false };
  } catch (e) {
    log4(`pull failed (swallowed): ${e?.message ?? e}`);
    return { pulled: 0, skipped: true, reason: "error" };
  }
}

// dist/src/hooks/hermes/session-start.js
var log5 = (msg) => log("hermes-session-start", msg);
var __bundleDir = dirname7(fileURLToPath2(import.meta.url));
var context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) \u2192 summaries/*.md \u2192 sessions/*.jsonl (last resort). Do NOT jump straight to JSONL.
Search: use \`grep\` (NOT \`rg\`/ripgrep). Example: grep -ri "keyword" ~/.deeplake/memory/
You also have hivemind MCP tools registered: hivemind_search, hivemind_read, hivemind_index. Prefer these \u2014 one tool call returns ranked hits across all summaries and sessions in a single SQL query.
IMPORTANT: Only use these bash builtins to interact with ~/.deeplake/memory/: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find. Do NOT use rg/ripgrep, python, python3, node, curl, or other interpreters.
Do NOT spawn subagents to read deeplake memory.

Organization management \u2014 each argument is SEPARATE (do NOT quote subcommands together):
- hivemind login                              \u2014 SSO login
- hivemind whoami                             \u2014 show current user/org
- hivemind org list                           \u2014 list organizations
- hivemind org switch <name-or-id>            \u2014 switch organization
- hivemind workspaces                         \u2014 list workspaces
- hivemind workspace <id>                     \u2014 switch workspace
- hivemind invite <email> <ADMIN|WRITE|READ>  \u2014 invite member (ALWAYS ask user which role before inviting)
- hivemind members                            \u2014 list members
- hivemind remove <user-id>                   \u2014 remove member

SKILLS (skillify) \u2014 mine + share reusable skills across the org:
${renderSkillifyCommands()}

Embeddings (semantic memory search) \u2014 opt-in, persisted in ~/.deeplake/config.json:
- hivemind embeddings install               \u2014 download deps (~600MB), symlink agents, set enabled:true
- hivemind embeddings enable                \u2014 flip enabled:true (run install first if deps missing)
- hivemind embeddings disable               \u2014 flip enabled:false + SIGTERM daemon (deps stay on disk)
- hivemind embeddings uninstall [--prune]   \u2014 remove agent symlinks + disable; --prune wipes deps too
- hivemind embeddings status                \u2014 show config + deps + per-agent link state`;
async function createPlaceholder(api, table, sessionId, cwd, userName, orgName, workspaceId, pluginVersion) {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;
  const existing = await api.query(`SELECT path FROM "${table}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`);
  if (existing.length > 0)
    return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const projectName = cwd.split("/").pop() ?? "unknown";
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
  await api.query(`INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'hermes', '${sqlStr(pluginVersion)}', '${now}', '${now}')`);
}
async function main() {
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  const input = await readStdin();
  const sessionId = input.session_id ?? `hermes-${Date.now()}`;
  const cwd = input.cwd ?? process.cwd();
  const creds = loadCredentials();
  const captureEnabled = process.env.HIVEMIND_CAPTURE !== "false";
  if (!creds?.token) {
    maybeAutoMineLocal();
  }
  await autoUpdate(creds, { agent: "hermes" });
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  const pluginVersion = current ?? "";
  if (creds?.token && captureEnabled) {
    try {
      const config = loadConfig();
      if (config) {
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
        await api.ensureTable();
        await api.ensureSessionsTable(config.sessionsTableName);
        await createPlaceholder(api, config.tableName, sessionId, cwd, config.userName, config.orgName, config.workspaceId, pluginVersion);
        log5("placeholder created");
      }
    } catch (e) {
      log5(`placeholder failed: ${e.message}`);
    }
  }
  const pullResult = await autoPullSkills();
  log5(`autopull: pulled=${pullResult.pulled} skipped=${pullResult.skipped}`);
  let versionNotice = "";
  if (current)
    versionNotice = `
Hivemind v${current}`;
  const localMined = countLocalManifestEntries();
  const localMinedNote = localMined > 0 ? `
${localMined} local skill${localMined === 1 ? "" : "s"} from past 'hivemind skillify mine-local' run(s) live in ~/.claude/skills/. Run 'hivemind login' to start sharing new mining results with your team.` : "";
  const additional = creds?.token ? `${context}
Logged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}` : `${context}
Not logged in to Deeplake. Run: hivemind login${localMinedNote}${versionNotice}`;
  console.log(JSON.stringify({ context: additional }));
}
main().catch((e) => {
  log5(`fatal: ${e.message}`);
  process.exit(0);
});
