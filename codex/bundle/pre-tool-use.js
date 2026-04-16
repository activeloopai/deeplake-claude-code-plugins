#!/usr/bin/env node

// dist/src/hooks/codex/pre-tool-use.js
import { existsSync as existsSync2 } from "node:fs";
import { execFileSync } from "node:child_process";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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
    sessionsTableName: process.env.DEEPLAKE_SESSIONS_TABLE ?? "sessions",
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
function sqlLike(value) {
  return sqlStr(value).replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// dist/src/deeplake-api.js
var log2 = (msg) => log("sdk", msg);
var TRACE_SQL = process.env.DEEPLAKE_TRACE_SQL === "1" || process.env.DEEPLAKE_DEBUG === "1";
var DEBUG_FILE_LOG = process.env.DEEPLAKE_DEBUG === "1";
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
      await this.query(`CREATE TABLE IF NOT EXISTS "${tbl}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'text/plain', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`);
      log2(`table "${tbl}" created`);
    }
  }
  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name) {
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      log2(`table "${name}" not found, creating`);
      await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', message JSONB, author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/json', size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT '') USING deeplake`);
      log2(`table "${name}" created`);
    }
  }
};

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
  const { pattern, targetPath, ignoreCase, wordMatch, filesOnly, countOnly, lineNumber, invertMatch, fixedString } = params;
  const likeOp = ignoreCase ? "ILIKE" : "LIKE";
  const escapedLike = sqlLike(pattern);
  let pathFilter = "";
  if (targetPath && targetPath !== "/") {
    const clean = targetPath.replace(/\/+$/, "");
    pathFilter = ` AND (path = '${sqlStr(clean)}' OR path LIKE '${sqlLike(clean)}/%')`;
  }
  const hasRegexMeta = !fixedString && /[.*+?^${}()|[\]\\]/.test(pattern);
  let rows = [];
  if (!hasRegexMeta) {
    const contentFilter = ` AND summary ${likeOp} '%${escapedLike}%'`;
    try {
      rows = await api.query(`SELECT path, summary AS content FROM "${table}" WHERE 1=1${pathFilter}${contentFilter} LIMIT 100`);
    } catch {
      rows = [];
    }
  } else {
    try {
      rows = await api.query(`SELECT path, summary AS content FROM "${table}" WHERE 1=1${pathFilter} LIMIT 100`);
    } catch {
      rows = [];
    }
  }
  let reStr = fixedString ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  if (wordMatch)
    reStr = `\\b${reStr}\\b`;
  let re;
  try {
    re = new RegExp(reStr, ignoreCase ? "i" : "");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
  }
  const output = [];
  const multi = rows.length > 1;
  for (const row of rows) {
    const p = row["path"];
    const text = row["content"];
    if (!text)
      continue;
    const lines = text.split("\n");
    const matched = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) !== !!invertMatch) {
        if (filesOnly) {
          output.push(p);
          break;
        }
        const prefix = multi ? `${p}:` : "";
        const ln = lineNumber ? `${i + 1}:` : "";
        matched.push(`${prefix}${ln}${lines[i]}`);
      }
    }
    if (!filesOnly) {
      if (countOnly) {
        output.push(`${multi ? `${p}:` : ""}${matched.length}`);
      } else {
        output.push(...matched);
      }
    }
  }
  return output.join("\n") || "(no matches)";
}

// dist/src/hooks/codex/pre-tool-use.js
var log3 = (msg) => log("codex-pre", msg);
var MEMORY_PATH = join3(homedir3(), ".deeplake", "memory");
var TILDE_PATH = "~/.deeplake/memory";
var HOME_VAR_PATH = "$HOME/.deeplake/memory";
var __bundleDir = dirname(fileURLToPath(import.meta.url));
var SHELL_BUNDLE = existsSync2(join3(__bundleDir, "shell", "deeplake-shell.js")) ? join3(__bundleDir, "shell", "deeplake-shell.js") : join3(__bundleDir, "..", "shell", "deeplake-shell.js");
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
function touchesMemory(cmd) {
  return cmd.includes(MEMORY_PATH) || cmd.includes(TILDE_PATH) || cmd.includes(HOME_VAR_PATH);
}
function rewritePaths(cmd) {
  return cmd.replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/").replace(/~\/.deeplake\/memory\/?/g, "/").replace(/\$HOME\/.deeplake\/memory\/?/g, "/").replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}
function blockWithContent(content) {
  process.stderr.write(content);
  process.exit(2);
}
function runVirtualShell(cmd) {
  try {
    return execFileSync("node", [SHELL_BUNDLE, "-c", cmd], {
      encoding: "utf-8",
      timeout: 1e4,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"]
      // capture stderr instead of inheriting
    }).trim();
  } catch (e) {
    log3(`virtual shell failed: ${e.message}`);
    return "";
  }
}
async function main() {
  const input = await readStdin();
  const cmd = input.tool_input?.command ?? "";
  log3(`hook fired: cmd=${cmd}`);
  if (!touchesMemory(cmd))
    return;
  const rewritten = rewritePaths(cmd);
  if (!isSafe(rewritten)) {
    const guidance = "This command is not supported for ~/.deeplake/memory/ operations. Only bash builtins are available: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find, etc. Do NOT use python, python3, node, curl, or other interpreters. Rewrite your command using only bash tools and retry.";
    log3(`unsupported command, returning guidance: ${rewritten}`);
    process.stdout.write(guidance);
    process.exit(0);
  }
  const config = loadConfig();
  if (config) {
    const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
    try {
      {
        let virtualPath = null;
        let lineLimit = 0;
        let fromEnd = false;
        const catCmd = rewritten.replace(/\s+2>\S+/g, "").trim();
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
          const headMatch = rewritten.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ?? rewritten.match(/^head\s+(\S+)\s*$/);
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
          const tailMatch = rewritten.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ?? rewritten.match(/^tail\s+(\S+)\s*$/);
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
          const wcMatch = rewritten.match(/^wc\s+-l\s+(\S+)\s*$/);
          if (wcMatch) {
            virtualPath = wcMatch[1];
            lineLimit = -1;
          }
        }
        if (virtualPath && !virtualPath.endsWith("/")) {
          const sessionsTable = process.env["DEEPLAKE_SESSIONS_TABLE"] ?? "sessions";
          const isSession = virtualPath.startsWith("/sessions/");
          log3(`direct read: ${virtualPath}`);
          let content = null;
          if (isSession) {
            const rows = await api.query(`SELECT message::text AS content FROM "${sessionsTable}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`);
            if (rows.length > 0 && rows[0]["content"])
              content = rows[0]["content"];
          } else {
            const rows = await api.query(`SELECT summary FROM "${table}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`);
            if (rows.length > 0 && rows[0]["summary"]) {
              content = rows[0]["summary"];
            } else if (virtualPath === "/index.md") {
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
          }
          if (content !== null) {
            if (lineLimit === -1) {
              blockWithContent(`${content.split("\n").length} ${virtualPath}`);
            }
            if (lineLimit > 0) {
              const lines = content.split("\n");
              content = fromEnd ? lines.slice(-lineLimit).join("\n") : lines.slice(0, lineLimit).join("\n");
            }
            blockWithContent(content);
          }
        }
      }
      const lsMatch = rewritten.match(/^ls\s+(?:-[a-zA-Z]+\s+)*(\S+)?\s*$/);
      if (lsMatch) {
        const dir = (lsMatch[1] ?? "/").replace(/\/+$/, "") || "/";
        const isLong = /\s-[a-zA-Z]*l/.test(rewritten);
        log3(`direct ls: ${dir}`);
        const rows = await api.query(`SELECT path, size_bytes FROM "${table}" WHERE path LIKE '${sqlLike(dir === "/" ? "" : dir)}/%' ORDER BY path`);
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
        if (entries.size > 0) {
          const lines = [];
          for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (isLong) {
              const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
              const size = info.isDir ? "0" : String(info.size).padStart(6);
              lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
            } else {
              lines.push(name + (info.isDir ? "/" : ""));
            }
          }
          blockWithContent(lines.join("\n"));
        } else {
          blockWithContent(`ls: cannot access '${dir}': No such file or directory`);
        }
      }
      {
        const findMatch = rewritten.match(/^find\s+(\S+)\s+(?:-type\s+\S+\s+)?-name\s+'([^']+)'/);
        if (findMatch) {
          const dir = findMatch[1].replace(/\/+$/, "") || "/";
          const namePattern = sqlLike(findMatch[2]).replace(/\*/g, "%").replace(/\?/g, "_");
          const sessionsTable = process.env["DEEPLAKE_SESSIONS_TABLE"] ?? "sessions";
          const isSessionDir = dir === "/sessions" || dir.startsWith("/sessions/");
          const findTable = isSessionDir ? sessionsTable : table;
          log3(`direct find: ${dir} -name '${findMatch[2]}'`);
          const rows = await api.query(`SELECT path FROM "${findTable}" WHERE path LIKE '${sqlLike(dir === "/" ? "" : dir)}/%' AND filename LIKE '${namePattern}' ORDER BY path`);
          let result2 = rows.map((r) => r["path"]).join("\n") || "";
          if (/\|\s*wc\s+-l\s*$/.test(rewritten)) {
            result2 = String(rows.length);
          }
          blockWithContent(result2 || "(no matches)");
        }
      }
      const grepParams = parseBashGrep(rewritten);
      if (grepParams) {
        const sessionsTable = process.env["DEEPLAKE_SESSIONS_TABLE"] ?? "sessions";
        log3(`direct grep: pattern=${grepParams.pattern} path=${grepParams.targetPath}`);
        const result2 = await handleGrepDirect(api, table, sessionsTable, grepParams);
        if (result2 !== null) {
          blockWithContent(result2);
        }
      }
    } catch (e) {
      log3(`direct query failed, falling back to shell: ${e.message}`);
    }
  }
  log3(`intercepted \u2192 running via virtual shell: ${rewritten}`);
  const result = runVirtualShell(rewritten);
  if (result) {
    blockWithContent(result);
  } else {
    blockWithContent("[Deeplake Memory] Command returned empty or the file does not exist in cloud storage.");
  }
}
main().catch((e) => {
  log3(`fatal: ${e.message}`);
  process.exit(0);
});
