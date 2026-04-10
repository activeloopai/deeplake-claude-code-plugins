#!/usr/bin/env node

// dist/src/hooks/session-start.js
import { fileURLToPath } from "node:url";
import { dirname, join as join4 } from "node:path";
import { mkdirSync as mkdirSync2, appendFileSync as appendFileSync2, readFileSync as readFileSync3 } from "node:fs";
import { execSync as execSync2 } from "node:child_process";
import { homedir as homedir4 } from "node:os";

// dist/src/commands/auth.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  const token = process.env.DEEPLAKE_TOKEN ?? creds?.token;
  const orgId = process.env.DEEPLAKE_ORG_ID ?? creds?.orgId;
  if (!token || !orgId)
    return null;
  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: process.env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.DEEPLAKE_TABLE ?? "memory",
    sessionsTableName: process.env.DEEPLAKE_SESSIONS_TABLE ?? "sessions",
    memoryPath: process.env.DEEPLAKE_MEMORY_PATH ?? join2(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var DEBUG = process.env.DEEPLAKE_DEBUG === "1";
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

// dist/src/deeplake-api.js
var log2 = (msg) => log("sdk", msg);
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
  constructor(token, apiUrl, orgId, workspaceId, tableName) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.orgId = orgId;
    this.workspaceId = workspaceId;
    this.tableName = tableName;
  }
  /** Execute SQL with retry on transient errors and bounded concurrency. */
  async query(sql) {
    await this._sem.acquire();
    try {
      return await this._queryWithRetry(sql);
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
    const hex = row.content.toString("hex");
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const cd = row.creationDate ?? ts;
    const lud = row.lastUpdateDate ?? ts;
    const exists = await this.query(`SELECT path FROM "${this.tableName}" WHERE path = '${sqlStr(row.path)}' LIMIT 1`);
    if (exists.length > 0) {
      let setClauses = `content = E'\\\\x${hex}', content_text = E'${sqlStr(row.contentText)}', mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
      if (row.project !== void 0)
        setClauses += `, project = '${sqlStr(row.project)}'`;
      if (row.description !== void 0)
        setClauses += `, description = '${sqlStr(row.description)}'`;
      await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`);
    } else {
      const id = randomUUID();
      let cols = "id, path, filename, content, content_text, mime_type, size_bytes, creation_date, last_update_date";
      let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'\\\\x${hex}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
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
  async listTables() {
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
          return (data.tables ?? []).map((t) => t.table_name);
        }
        if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(resp.status)) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
        return [];
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return [];
      }
    }
    return [];
  }
  /** Create the memory table if it doesn't already exist. Migrate columns on existing tables. */
  async ensureTable(name) {
    const tbl = name ?? this.tableName;
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log2(`table "${tbl}" not found, creating`);
      await this.query(`CREATE TABLE IF NOT EXISTS "${tbl}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', content BYTEA NOT NULL DEFAULT ''::bytea, content_text TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`);
      log2(`table "${tbl}" created`);
    } else {
      for (const col of ["project", "description", "creation_date", "last_update_date"]) {
        try {
          await this.query(`ALTER TABLE "${tbl}" ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
          log2(`added column "${col}" to "${tbl}"`);
        } catch {
        }
      }
    }
  }
  /** Create the sessions table (uses JSONB for content_text since every row is a JSON event). */
  async ensureSessionsTable(name) {
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      log2(`table "${name}" not found, creating`);
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', content_text JSONB, mime_type TEXT NOT NULL DEFAULT 'application/json', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`);
      log2(`table "${name}" created`);
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

// dist/src/hooks/session-start.js
var log3 = (msg) => log("session-start", msg);
var __bundleDir = dirname(fileURLToPath(import.meta.url));
var AUTH_CMD = join4(__bundleDir, "commands", "auth-login.js");
var context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) \u2014 personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) \u2014 global memory shared across all sessions, users, and agents in the org

Deeplake memory structure:
- ~/.deeplake/memory/index.md \u2014 START HERE, table of all sessions
- ~/.deeplake/memory/summaries/username/*.md \u2014 AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/username/*.jsonl \u2014 raw session data (last resort)

SEARCH STRATEGY: Always read index.md first. Then read specific summaries. Only read raw JSONL if summaries don't have enough detail. Do NOT jump straight to JSONL files.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management (DEEPLAKE_AUTH_CMD will be replaced with actual path below):
- Switch org: node "DEEPLAKE_AUTH_CMD" org switch <name-or-id>
- List orgs: node "DEEPLAKE_AUTH_CMD" org list
- Invite member: node "DEEPLAKE_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>
- List members: node "DEEPLAKE_AUTH_CMD" members
- Re-login: node "DEEPLAKE_AUTH_CMD" login

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
var GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/deeplake-claude-code-plugins/main/package.json";
var VERSION_CHECK_TIMEOUT = 3e3;
function getInstalledVersion() {
  try {
    const pkgPath = join4(__bundleDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync3(pkgPath, "utf-8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
async function getLatestVersion() {
  try {
    const res = await fetch(GITHUB_RAW_PKG, { signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT) });
    if (!res.ok)
      return null;
    const pkg = await res.json();
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
function isNewer(latest, current) {
  const parse = (v) => v.split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || la === ca && lb > cb || la === ca && lb === cb && lc > cc;
}
var HOME = homedir4();
var WIKI_LOG = join4(HOME, ".claude", "hooks", "deeplake-wiki.log");
function wikiLog(msg) {
  try {
    mkdirSync2(join4(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync2(WIKI_LOG, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] ${msg}
`);
  } catch {
  }
}
async function createPlaceholder(api, table, sessionId, cwd, userName, orgName, workspaceId) {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;
  await api.query(`SELECT deeplake_sync_table('${table}')`);
  const existing = await api.query(`SELECT path FROM "${table}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`);
  if (existing.length > 0) {
    wikiLog(`SessionStart: summary exists for ${sessionId} (resumed)`);
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
  const hex = Buffer.from(content, "utf-8").toString("hex");
  const filename = `${sessionId}.md`;
  await api.query(`INSERT INTO "${table}" (id, path, filename, content, content_text, mime_type, size_bytes, project, description, creation_date, last_update_date) VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'\\\\x${hex}', E'${sqlStr(content)}', 'text/markdown', ${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', '${now}', '${now}')`);
  wikiLog(`SessionStart: created placeholder for ${sessionId} (${cwd})`);
}
async function main() {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1")
    return;
  const input = await readStdin();
  let creds = loadCredentials();
  if (!creds?.token) {
    log3("no credentials found \u2014 run /deeplake-hivemind:login to authenticate");
  } else {
    log3(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    if (creds.token && !creds.userName) {
      try {
        const { userInfo: userInfo2 } = await import("node:os");
        creds.userName = userInfo2().username ?? "unknown";
        saveCredentials(creds);
        log3(`backfilled and persisted userName: ${creds.userName}`);
      } catch {
      }
    }
  }
  if (input.session_id && creds?.token) {
    try {
      const config = loadConfig();
      if (config) {
        const table = config.tableName;
        const sessionsTable = config.sessionsTableName;
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
        await api.ensureTable();
        await api.ensureSessionsTable(sessionsTable);
        await createPlaceholder(api, table, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
        log3("placeholder created");
      }
    } catch (e) {
      log3(`placeholder failed: ${e.message}`);
      wikiLog(`SessionStart: placeholder failed for ${input.session_id}: ${e.message}`);
    }
  }
  const autoupdate = creds?.autoupdate !== false;
  let updateNotice = "";
  try {
    const current = getInstalledVersion();
    if (current) {
      const latest = await getLatestVersion();
      if (latest && isNewer(latest, current)) {
        if (autoupdate) {
          log3(`autoupdate: updating ${current} \u2192 ${latest}`);
          try {
            const scopes = ["user", "project", "local", "managed"];
            const cmd = scopes.map((s) => `claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope ${s} 2>/dev/null`).join("; ");
            execSync2(cmd, { stdio: "ignore", timeout: 6e4 });
            updateNotice = `

\u2705 Deeplake Hivemind auto-updated: ${current} \u2192 ${latest}. Run /reload-plugins to apply.`;
            process.stderr.write(`\u2705 Deeplake Hivemind auto-updated: ${current} \u2192 ${latest}. Run /reload-plugins to apply.
`);
            log3(`autoupdate succeeded: ${current} \u2192 ${latest}`);
          } catch (e) {
            updateNotice = `

\u2B06\uFE0F Deeplake Hivemind update available: ${current} \u2192 ${latest}. Auto-update failed \u2014 run /deeplake-hivemind:update to upgrade manually.`;
            process.stderr.write(`\u2B06\uFE0F Deeplake Hivemind update available: ${current} \u2192 ${latest}. Auto-update failed \u2014 run /deeplake-hivemind:update to upgrade manually.
`);
            log3(`autoupdate failed: ${e.message}`);
          }
        } else {
          updateNotice = `

\u2B06\uFE0F Deeplake Hivemind update available: ${current} \u2192 ${latest}. Run /deeplake-hivemind:update to upgrade.`;
          process.stderr.write(`\u2B06\uFE0F Deeplake Hivemind update available: ${current} \u2192 ${latest}. Run /deeplake-hivemind:update to upgrade.
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
  const resolvedContext = context.replace(/DEEPLAKE_AUTH_CMD/g, AUTH_CMD);
  const additionalContext = creds?.token ? `${resolvedContext}

Logged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${updateNotice}` : `${resolvedContext}

\u26A0\uFE0F Not logged in to Deeplake. Memory search will not work. Ask the user to run /deeplake-hivemind:login to authenticate.${updateNotice}`;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  }));
}
main().catch((e) => {
  log3(`fatal: ${e.message}`);
  process.exit(0);
});
