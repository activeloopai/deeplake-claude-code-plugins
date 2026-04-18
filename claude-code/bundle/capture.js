#!/usr/bin/env node

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

// dist/src/hooks/summary-state.js
import { readFileSync as readFileSync2, writeFileSync, writeSync, mkdirSync, renameSync, existsSync as existsSync2, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
var STATE_DIR = join3(homedir3(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function statePath(sessionId) {
  return join3(STATE_DIR, `${sessionId}.json`);
}
function lockPath(sessionId) {
  return join3(STATE_DIR, `${sessionId}.lock`);
}
function readState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync2(p))
    return null;
  try {
    return JSON.parse(readFileSync2(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = statePath(sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}
function withRmwLock(sessionId, fn) {
  mkdirSync(STATE_DIR, { recursive: true });
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
  mkdirSync(STATE_DIR, { recursive: true });
  const p = lockPath(sessionId);
  if (existsSync2(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync2(p, "utf-8"), 10);
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
import { fileURLToPath } from "node:url";
import { dirname, join as join4 } from "node:path";
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, appendFileSync as appendFileSync2 } from "node:fs";
import { homedir as homedir4, tmpdir } from "node:os";
var HOME = homedir4();
var WIKI_LOG = join4(HOME, ".claude", "hooks", "deeplake-wiki.log");
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
    mkdirSync2(join4(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync2(WIKI_LOG, `[${utcTimestamp()}] ${msg}
`);
  } catch {
  }
}
function findClaudeBin() {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join4(HOME, ".claude", "local", "claude");
  }
}
function spawnWikiWorker(opts) {
  const { config, sessionId, cwd, bundleDir, reason } = opts;
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join4(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync2(tmpDir, { recursive: true });
  const configFile = join4(tmpDir, "config.json");
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
    claudeBin: findClaudeBin(),
    wikiLog: WIKI_LOG,
    hooksDir: join4(HOME, ".claude", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE
  }));
  wikiLog(`${reason}: spawning summary worker for ${sessionId}`);
  const workerPath = join4(bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`${reason}: spawned summary worker for ${sessionId}`);
}
function bundleDirFromImportMeta(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl));
}

// dist/src/hooks/session-queue.js
import { appendFileSync as appendFileSync3, existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync, renameSync as renameSync2, rmSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5 } from "node:path";
import { homedir as homedir5 } from "node:os";
var DEFAULT_QUEUE_DIR = join5(homedir5(), ".deeplake", "queue");
var DEFAULT_MAX_BATCH_ROWS = 50;
var DEFAULT_STALE_INFLIGHT_MS = 6e4;
var BUSY_WAIT_STEP_MS = 100;
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
  mkdirSync3(queueDir, { recursive: true });
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
  mkdirSync3(queueDir, { recursive: true });
  const queuePath = getQueuePath(queueDir, opts.sessionId);
  const inflightPath = getInflightPath(queueDir, opts.sessionId);
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
      throw e;
    }
    if (!drainAll) {
      return { status: "flushed", rows: totalRows, batches: totalBatches };
    }
  }
}
function getQueuePath(queueDir, sessionId) {
  return join5(queueDir, `${sessionId}.jsonl`);
}
function getInflightPath(queueDir, sessionId) {
  return join5(queueDir, `${sessionId}.inflight`);
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
  for (let i = 0; i < rows.length; i += maxBatchRows) {
    const chunk = rows.slice(i, i + maxBatchRows);
    const sql = buildSessionInsertSql(sessionsTable, chunk);
    try {
      await api.query(sql);
    } catch (e) {
      if (!ensured && isEnsureSessionsTableRetryable(e)) {
        await api.ensureSessionsTable(sessionsTable);
        ensured = true;
        await api.query(sql);
      } else {
        throw e;
      }
    }
    batches += 1;
  }
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
    renameSync2(inflightPath, queuePath);
    return;
  }
  const inflight = readFileSync3(inflightPath, "utf-8");
  const queued = readFileSync3(queuePath, "utf-8");
  writeFileSync3(queuePath, `${inflight}${queued}`);
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
function isEnsureSessionsTableRetryable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("permission denied") || message.includes("does not exist");
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

// dist/src/hooks/capture.js
var log3 = (msg) => log("capture", msg);
var CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";
async function main() {
  if (!CAPTURE)
    return;
  const input = await readStdin();
  const config = loadConfig();
  if (!config) {
    log3("no config");
    return;
  }
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    hook_event_name: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    timestamp: ts
  };
  let entry;
  if (input.prompt !== void 0) {
    log3(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt
    };
  } else if (input.tool_name !== void 0) {
    log3(`tool=${input.tool_name} session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response)
    };
  } else if (input.last_assistant_message !== void 0) {
    log3(`assistant session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "assistant_message",
      content: input.last_assistant_message,
      ...input.agent_transcript_path ? { agent_transcript_path: input.agent_transcript_path } : {}
    };
  } else {
    log3("unknown event, skipping");
    return;
  }
  const sessionPath = buildSessionPath(config, input.session_id);
  const line = JSON.stringify(entry);
  const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
  appendQueuedSessionRow(buildQueuedSessionRow({
    sessionPath,
    line,
    userName: config.userName,
    projectName,
    description: input.hook_event_name ?? "",
    agent: "claude_code",
    timestamp: ts
  }));
  log3(`queued ${input.hook_event_name ?? "event"} for ${sessionPath}`);
  maybeTriggerPeriodicSummary(input.session_id, input.cwd ?? "", config);
  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.sessionsTableName);
    const result = await flushSessionQueue(api, {
      sessionId: input.session_id,
      sessionsTable: config.sessionsTableName,
      drainAll: true
    });
    log3(`flush ${result.status}: rows=${result.rows} batches=${result.batches}`);
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
      log3(`periodic trigger suppressed (lock held) session=${sessionId}`);
      return;
    }
    wikiLog(`Periodic: threshold hit (total=${state.totalCount}, since=${state.totalCount - state.lastSummaryCount}, N=${cfg.everyNMessages}, hours=${cfg.everyHours})`);
    spawnWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "Periodic"
    });
  } catch (e) {
    log3(`periodic trigger error: ${e.message}`);
  }
}
main().catch((e) => {
  log3(`fatal: ${e.message}`);
  process.exit(0);
});
