#!/usr/bin/env node

// dist/src/hooks/session-end.js
import { execSync, spawn } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync as appendFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3, tmpdir } from "node:os";

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
    memoryPath: process.env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = process.env.DEEPLAKE_DEBUG === "1";
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

// dist/src/deeplake-api.js
var log2 = (msg) => log("sdk", msg);
var DeeplakeApi = class {
  token;
  apiUrl;
  orgId;
  workspaceId;
  tableName;
  _pendingRows = [];
  constructor(token, apiUrl, orgId, workspaceId, tableName) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.orgId = orgId;
    this.workspaceId = workspaceId;
    this.tableName = tableName;
  }
  /** Execute SQL and return results as row-objects. */
  async query(sql) {
    const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-Activeloop-Org-Id": this.orgId
      },
      body: JSON.stringify({ query: sql })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Query failed: ${resp.status}: ${text.slice(0, 200)}`);
    }
    const raw = await resp.json();
    if (!raw?.rows || !raw?.columns)
      return [];
    return raw.rows.map((row) => Object.fromEntries(raw.columns.map((col, i) => [col, row[i]])));
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
  /** List all tables in the workspace. */
  async listTables() {
    const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Activeloop-Org-Id": this.orgId
      }
    });
    if (!resp.ok)
      return [];
    const data = await resp.json();
    return (data.tables ?? []).map((t) => t.table_name);
  }
  /** Create the table if it doesn't already exist. Migrate columns on existing tables. */
  async ensureTable() {
    const tables = await this.listTables();
    if (!tables.includes(this.tableName)) {
      log2(`table "${this.tableName}" not found, creating`);
      await this.query(`CREATE TABLE IF NOT EXISTS "${this.tableName}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', content BYTEA NOT NULL DEFAULT ''::bytea, content_text TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`);
      log2(`table "${this.tableName}" created`);
    } else {
      for (const col of ["project", "description", "creation_date", "last_update_date"]) {
        try {
          await this.query(`ALTER TABLE "${this.tableName}" ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
          log2(`added column "${col}" to "${this.tableName}"`);
        } catch {
        }
      }
    }
  }
};

// dist/src/hooks/session-end.js
var log3 = (msg) => log("session-end", msg);
var HOME = homedir3();
var WIKI_LOG = join3(HOME, ".claude", "hooks", "deeplake-wiki.log");
function wikiLog(msg) {
  try {
    mkdirSync(join3(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync2(WIKI_LOG, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] ${msg}
`);
  } catch {
  }
}
function findClaudeBin() {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join3(HOME, ".claude", "local", "claude");
  }
}
async function main() {
  const input = await readStdin();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId)
    return;
  const config = loadConfig();
  if (!config) {
    log3("no config");
    return;
  }
  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
  const rows = await api.query(`SELECT path, content_text FROM "${table}" WHERE path LIKE '${sqlStr(`/sessions/%${sessionId}%`)}' LIMIT 1`);
  if (rows.length === 0) {
    const fallbackRows = await api.query(`SELECT path, content_text FROM "${table}" WHERE path = '${sqlStr(`/session_${sessionId}.jsonl`)}' LIMIT 1`);
    if (fallbackRows.length > 0)
      rows.push(...fallbackRows);
  }
  if (rows.length === 0 || !rows[0]["content_text"]) {
    wikiLog(`SessionEnd: no JSONL on server for ${sessionId}`);
    return;
  }
  const jsonlServerPath = rows[0]["path"];
  const jsonlContent = rows[0]["content_text"];
  wikiLog(`SessionEnd: found JSONL at ${jsonlServerPath}`);
  if (!jsonlContent.trim()) {
    wikiLog(`SessionEnd: empty JSONL for ${sessionId}`);
    return;
  }
  const jsonlLines = jsonlContent.split("\n").filter(Boolean).length;
  const tmpDir = join3(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tmpJsonl = join3(tmpDir, "session.jsonl");
  const tmpSummary = join3(tmpDir, "summary.md");
  writeFileSync(tmpJsonl, jsonlContent);
  wikiLog(`SessionEnd: processing ${sessionId} (${jsonlLines} lines, tmp: ${tmpDir})`);
  let prevOffset = 0;
  try {
    const sumRows = await api.query(`SELECT content_text FROM "${table}" WHERE path = '${sqlStr(`/summaries/${config.userName}/${sessionId}.md`)}' LIMIT 1`);
    if (sumRows.length > 0 && sumRows[0]["content_text"]) {
      const existing = sumRows[0]["content_text"];
      const match = existing.match(/\*\*JSONL offset\*\*:\s*(\d+)/);
      if (match)
        prevOffset = parseInt(match[1], 10);
      writeFileSync(tmpSummary, existing);
    }
  } catch {
  }
  const claudeBin = findClaudeBin();
  const projectName = cwd.split("/").pop() || "unknown";
  const wikiPrompt = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge \u2014 entities, decisions, relationships, and facts \u2014 into a structured, searchable wiki entry. Think of this as building a knowledge graph, not writing a summary.

SESSION JSONL path: ${tmpJsonl}
SUMMARY FILE to write: ${tmpSummary}
SESSION ID: ${sessionId}
PROJECT: ${projectName}
PREVIOUS JSONL OFFSET (lines already processed): ${prevOffset}
CURRENT JSONL LINES: ${jsonlLines}

Steps:
1. Read the session JSONL at the path above.
   - If PREVIOUS JSONL OFFSET > 0, this is a resumed session. Read the existing summary file first,
     then focus on lines AFTER the offset for new content. Merge new facts into the existing summary.
   - If offset is 0, generate from scratch.

2. Write the summary file at the path above with this EXACT format. The header fields (Source, Project) are pre-filled \u2014 copy them VERBATIM, do NOT replace them with paths from the JSONL content:

# Session ${sessionId}
- **Source**: ${jsonlServerPath}
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: ${projectName}
- **JSONL offset**: ${jsonlLines}

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

PRIVACY: Never include absolute filesystem paths (e.g. /home/user/..., /Users/..., C:\\...) in the summary. Use only project-relative paths or the project name. The Source and Project fields above are already correct \u2014 do not change them.

LENGTH LIMIT: Keep the total summary under 4000 characters. Be dense and concise \u2014 prioritize facts over prose. If a session is short, the summary should be short too.`;
  const promptFile = join3(tmpDir, "prompt.txt");
  writeFileSync(promptFile, wikiPrompt);
  const configFile = join3(tmpDir, "config.json");
  writeFileSync(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    table,
    sessionId,
    userName: config.userName,
    summaryPath: tmpSummary,
    project: cwd.split("/").pop() || "unknown",
    tmpDir
  }));
  const uploadScript = join3(tmpDir, "upload.mjs");
  writeFileSync(uploadScript, `import { readFileSync, existsSync } from "node:fs";
const cfg = JSON.parse(readFileSync("${configFile}", "utf-8"));
function esc(s) { return s.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "''").replace(/[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, ""); }
async function query(sql) {
  const r = await fetch(cfg.apiUrl + "/workspaces/" + cfg.workspaceId + "/tables/query", {
    method: "POST",
    headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json", "X-Activeloop-Org-Id": cfg.orgId },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error("API " + r.status + ": " + (await r.text()).slice(0, 200));
  return r.json().then(j => {
    if (!j.columns || !j.rows) return [];
    return j.rows.map(row => Object.fromEntries(j.columns.map((col, i) => [col, row[i]])));
  }).catch(() => []);
}
async function upload(vpath, localPath) {
  if (!existsSync(localPath)) return;
  const text = readFileSync(localPath, "utf-8");
  if (!text.trim()) return;
  const hex = Buffer.from(text, "utf-8").toString("hex");
  const fname = vpath.split("/").pop();
  const ts = new Date().toISOString();
  await query("SELECT deeplake_sync_table('" + cfg.table + "')");
  const rows = await query("SELECT path FROM \\"" + cfg.table + "\\" WHERE path = '" + esc(vpath) + "' LIMIT 1");
  if (rows.length > 0) {
    await query("UPDATE \\"" + cfg.table + "\\" SET content = E'\\\\\\\\x" + hex + "', content_text = E'" + esc(text) + "', size_bytes = " + Buffer.byteLength(text) + ", last_update_date = '" + ts + "' WHERE path = '" + esc(vpath) + "'");
  } else {
    const id = crypto.randomUUID();
    await query("INSERT INTO \\"" + cfg.table + "\\" (id, path, filename, content, content_text, mime_type, size_bytes, project, creation_date, last_update_date) VALUES ('" + id + "', '" + esc(vpath) + "', '" + esc(fname) + "', E'\\\\\\\\x" + hex + "', E'" + esc(text) + "', 'text/markdown', " + Buffer.byteLength(text) + ", '" + esc(cfg.project) + "', '" + ts + "', '" + ts + "')");
  }
  console.log("Uploaded " + vpath);
}
await upload("/summaries/" + cfg.userName + "/" + cfg.sessionId + ".md", cfg.summaryPath);
// Update summary row metadata (description + last_update_date) for virtual index.md
try {
  var summaryText = existsSync(cfg.summaryPath) ? readFileSync(cfg.summaryPath, "utf-8") : "";
  var whatHappened = summaryText.match(/## What Happened\\n([\\s\\S]*?)(?=\\n##|$)/);
  var desc = whatHappened ? whatHappened[1].trim().slice(0, 300) : "completed";
  var ts = new Date().toISOString();
  await query("UPDATE \\"" + cfg.table + "\\" SET description = E'" + esc(desc) + "', last_update_date = '" + ts + "' WHERE path = '/summaries/" + cfg.userName + "/" + cfg.sessionId + ".md'");
  console.log("Updated description for " + cfg.sessionId);
} catch(e) { console.log("Failed to update description: " + e.message); }
console.log("Server upload complete for " + cfg.sessionId);
`);
  const wrapperScript = join3(tmpDir, "wiki-worker.sh");
  writeFileSync(wrapperScript, `#!/bin/bash
LOG="${WIKI_LOG}"
PROMPT_FILE="${promptFile}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] wiki-worker: starting claude -p for ${sessionId}" >> "$LOG"

PROMPT=$(cat "$PROMPT_FILE")
"${claudeBin}" -p "$PROMPT" \\
  --no-session-persistence \\
  --model haiku \\
  --permission-mode bypassPermissions \\
  >> "$LOG" 2>&1

EXIT_CODE=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] wiki-worker: claude -p exited (code $EXIT_CODE) for ${sessionId}" >> "$LOG"

# Upload to server
node "${uploadScript}" >> "$LOG" 2>&1

# Cleanup
rm -rf "${tmpDir}"
`, { mode: 493 });
  spawn("nohup", ["bash", wrapperScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`SessionEnd: spawned wiki worker for ${sessionId} (script: ${wrapperScript})`);
}
main().catch((e) => {
  log3(`fatal: ${e.message}`);
  process.exit(0);
});
