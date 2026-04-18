#!/usr/bin/env node

// dist/src/hooks/session-start-setup.js
import { fileURLToPath } from "node:url";
import { dirname as dirname3, join as join6 } from "node:path";
import { mkdirSync as mkdirSync4, appendFileSync as appendFileSync3 } from "node:fs";
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
    memoryPath: env.HIVEMIND_MEMORY_PATH ?? env.DEEPLAKE_MEMORY_PATH ?? join2(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var DEBUG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var LOG = join3(homedir3(), ".deeplake", "hook-debug.log");
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-Activeloop-Org-Id": this.orgId
          },
          body: JSON.stringify({ query: sql })
        });
      } catch (e) {
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
  }
};

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

// dist/src/hooks/session-queue.js
import { appendFileSync as appendFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, readdirSync, renameSync, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join4 } from "node:path";
import { homedir as homedir4 } from "node:os";
var DEFAULT_QUEUE_DIR = join4(homedir4(), ".deeplake", "queue");
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
function buildSessionInsertSql(sessionsTable, rows) {
  if (rows.length === 0)
    throw new Error("buildSessionInsertSql: rows must not be empty");
  const table = sqlIdent(sessionsTable);
  const values = rows.map((row) => {
    const jsonForSql = row.message.replace(/'/g, "''");
    return `('${sqlStr(row.id)}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', '${jsonForSql}'::jsonb, '${sqlStr(row.author)}', ${row.sizeBytes}, '${sqlStr(row.project)}', '${sqlStr(row.description)}', '${sqlStr(row.agent)}', '${sqlStr(row.creationDate)}', '${sqlStr(row.lastUpdateDate)}')`;
  }).join(", ");
  return `INSERT INTO "${table}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${values}`;
}
async function flushSessionQueue(api, opts) {
  const queueDir = opts.queueDir ?? DEFAULT_QUEUE_DIR;
  const maxBatchRows = opts.maxBatchRows ?? DEFAULT_MAX_BATCH_ROWS;
  const staleInflightMs = opts.staleInflightMs ?? DEFAULT_STALE_INFLIGHT_MS;
  const waitIfBusyMs = opts.waitIfBusyMs ?? 0;
  const drainAll = opts.drainAll ?? false;
  mkdirSync2(queueDir, { recursive: true });
  const queuePath = getQueuePath(queueDir, opts.sessionId);
  const inflightPath = getInflightPath(queueDir, opts.sessionId);
  if (isSessionWriteDisabled(opts.sessionsTable, queueDir)) {
    return existsSync3(queuePath) || existsSync3(inflightPath) ? { status: "disabled", rows: 0, batches: 0 } : { status: "empty", rows: 0, batches: 0 };
  }
  let totalRows = 0;
  let totalBatches = 0;
  let flushedAny = false;
  while (true) {
    if (opts.allowStaleInflight)
      recoverStaleInflight(queuePath, inflightPath, staleInflightMs);
    if (existsSync3(inflightPath)) {
      if (waitIfBusyMs > 0) {
        await waitForInflightToClear(inflightPath, waitIfBusyMs);
        if (opts.allowStaleInflight)
          recoverStaleInflight(queuePath, inflightPath, staleInflightMs);
      }
      if (existsSync3(inflightPath)) {
        return flushedAny ? { status: "flushed", rows: totalRows, batches: totalBatches } : { status: "busy", rows: 0, batches: 0 };
      }
    }
    if (!existsSync3(queuePath)) {
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
  mkdirSync2(queueDir, { recursive: true });
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
function getQueuePath(queueDir, sessionId) {
  return join4(queueDir, `${sessionId}.jsonl`);
}
function getInflightPath(queueDir, sessionId) {
  return join4(queueDir, `${sessionId}.inflight`);
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
  const raw = readFileSync3(path, "utf-8");
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
function requeueInflight(queuePath, inflightPath) {
  if (!existsSync3(inflightPath))
    return;
  if (!existsSync3(queuePath)) {
    renameSync(inflightPath, queuePath);
    return;
  }
  const inflight = readFileSync3(inflightPath, "utf-8");
  const queued = readFileSync3(queuePath, "utf-8");
  writeFileSync2(queuePath, `${inflight}${queued}`);
  rmSync(inflightPath, { force: true });
}
function recoverStaleInflight(queuePath, inflightPath, staleInflightMs) {
  if (!existsSync3(inflightPath) || !isStale(inflightPath, staleInflightMs))
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
      const path = join4(queueDir, name);
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
  mkdirSync2(queueDir, { recursive: true });
  writeFileSync2(getSessionWriteDisabledPath(queueDir, sessionsTable), JSON.stringify({
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
  if (!existsSync3(path))
    return false;
  try {
    const raw = readFileSync3(path, "utf-8");
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
  return join4(queueDir, `.${sessionsTable}.disabled.json`);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function waitForInflightToClear(inflightPath, waitIfBusyMs) {
  const startedAt = Date.now();
  while (existsSync3(inflightPath) && Date.now() - startedAt < waitIfBusyMs) {
    await sleep2(BUSY_WAIT_STEP_MS);
  }
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// dist/src/hooks/version-check.js
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
import { homedir as homedir5 } from "node:os";
var DEFAULT_VERSION_CACHE_PATH = join5(homedir5(), ".deeplake", ".version-check.json");
var DEFAULT_VERSION_CACHE_TTL_MS = 60 * 60 * 1e3;
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join5(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync4(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join5(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync4(candidate, "utf-8"));
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
  const parse = (v) => v.split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || la === ca && lb > cb || la === ca && lb === cb && lc > cc;
}
function readVersionCache(cachePath = DEFAULT_VERSION_CACHE_PATH) {
  if (!existsSync4(cachePath))
    return null;
  try {
    const parsed = JSON.parse(readFileSync4(cachePath, "utf-8"));
    if (parsed && typeof parsed.checkedAt === "number" && typeof parsed.url === "string" && (typeof parsed.latest === "string" || parsed.latest === null)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function writeVersionCache(entry, cachePath = DEFAULT_VERSION_CACHE_PATH) {
  mkdirSync3(dirname2(cachePath), { recursive: true });
  writeFileSync3(cachePath, JSON.stringify(entry));
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

// dist/src/hooks/session-start-setup.js
var log3 = (msg) => log("session-setup", msg);
var __bundleDir = dirname3(fileURLToPath(import.meta.url));
var GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
var VERSION_CHECK_TIMEOUT = 3e3;
var HOME = homedir6();
var WIKI_LOG = join6(HOME, ".claude", "hooks", "deeplake-wiki.log");
function wikiLog(msg) {
  try {
    mkdirSync4(join6(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync3(WIKI_LOG, `[${utcTimestamp()}] ${msg}
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
  await api.query(`INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'claude_code', '${now}', '${now}')`);
  wikiLog(`SessionSetup: created placeholder for ${sessionId} (${cwd})`);
}
async function main() {
  if ((process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1")
    return;
  const input = await readStdin();
  const creds = loadCredentials();
  if (!creds?.token) {
    log3("no credentials");
    return;
  }
  if (!creds.userName) {
    try {
      const { userInfo: userInfo2 } = await import("node:os");
      creds.userName = userInfo2().username ?? "unknown";
      saveCredentials(creds);
      log3(`backfilled userName: ${creds.userName}`);
    } catch {
    }
  }
  const captureEnabled = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";
  if (input.session_id) {
    try {
      const config = loadConfig();
      if (config) {
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
        await api.ensureTable();
        if (captureEnabled) {
          if (isSessionWriteDisabled(config.sessionsTableName)) {
            log3(`sessions table disabled, skipping setup for "${config.sessionsTableName}"`);
          } else {
            try {
              await api.ensureSessionsTable(config.sessionsTableName);
              const drain = await drainSessionQueues(api, {
                sessionsTable: config.sessionsTableName
              });
              if (drain.flushedSessions > 0) {
                log3(`drained ${drain.flushedSessions} queued session(s), rows=${drain.rows}, batches=${drain.batches}`);
              }
            } catch (e) {
              if (isSessionWriteAuthError(e)) {
                markSessionWriteDisabled(config.sessionsTableName, e.message);
                log3(`sessions table unavailable, skipping setup: ${e.message}`);
              } else {
                throw e;
              }
            }
          }
          await createPlaceholder(api, config.tableName, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
        }
        log3("setup complete");
      }
    } catch (e) {
      log3(`setup failed: ${e.message}`);
      wikiLog(`SessionSetup: failed for ${input.session_id}: ${e.message}`);
    }
  }
  const autoupdate = creds.autoupdate !== false;
  try {
    const current = getInstalledVersion(__bundleDir, ".claude-plugin");
    if (current) {
      const latest = await getLatestVersionCached({
        url: GITHUB_RAW_PKG,
        timeoutMs: VERSION_CHECK_TIMEOUT
      });
      if (latest && isNewer(latest, current)) {
        if (autoupdate) {
          log3(`autoupdate: updating ${current} \u2192 ${latest}`);
          try {
            const scopes = ["user", "project", "local", "managed"];
            const cmd = scopes.map((s) => `claude plugin update hivemind@hivemind --scope ${s} 2>/dev/null`).join("; ");
            execSync2(cmd, { stdio: "ignore", timeout: 6e4 });
            process.stderr.write(`\u2705 Hivemind auto-updated: ${current} \u2192 ${latest}. Run /reload-plugins to apply.
`);
            log3(`autoupdate succeeded: ${current} \u2192 ${latest}`);
          } catch (e) {
            process.stderr.write(`\u2B06\uFE0F Hivemind update available: ${current} \u2192 ${latest}. Auto-update failed \u2014 run /hivemind:update to upgrade manually.
`);
            log3(`autoupdate failed: ${e.message}`);
          }
        } else {
          process.stderr.write(`\u2B06\uFE0F Hivemind update available: ${current} \u2192 ${latest}. Run /hivemind:update to upgrade.
`);
          log3(`update available (autoupdate off): ${current} \u2192 ${latest}`);
        }
      } else {
        log3(`version up to date: ${current}`);
      }
    }
  } catch (e) {
    log3(`version check failed: ${e.message}`);
  }
}
main().catch((e) => {
  log3(`fatal: ${e.message}`);
  process.exit(0);
});
