#!/usr/bin/env node

// dist/src/hooks/pre-tool-use.js
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
    memoryPath: process.env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/deeplake-api.js
import { ManagedClient, initializeWasm, deeplakeSetEndpointAndOpen, deeplakeAppend, deeplakeSetRow, deeplakeCommit, deeplakeRelease, deeplakeNumRows, deeplakeGetColumnData } from "deeplake";
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
var wasmInitialized = false;
var DeeplakeApi = class {
  token;
  apiUrl;
  orgId;
  workspaceId;
  tableName;
  _client;
  _wasmDs = null;
  _pendingRows = [];
  constructor(token, apiUrl, orgId, workspaceId, tableName) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.orgId = orgId;
    this.workspaceId = workspaceId;
    this.tableName = tableName;
    this._client = new ManagedClient({ token, workspaceId, apiUrl, orgId });
  }
  // ── WASM lifecycle ────────────────────────────────────────────────────────
  /** Initialize WASM engine (once per process). */
  async initWasm() {
    if (wasmInitialized)
      return;
    await initializeWasm();
    wasmInitialized = true;
    log2("WASM initialized");
  }
  /** Open the WASM dataset handle for direct S3 writes. */
  async openDataset(timeoutMs = 3e4) {
    if (this._wasmDs)
      return;
    const alPath = `al://${this.workspaceId}/${this.tableName}`;
    log2(`opening dataset: ${alPath}`);
    const openPromise = deeplakeSetEndpointAndOpen(this.apiUrl, alPath, "", this.token);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("dataset open timed out")), timeoutMs));
    this._wasmDs = await Promise.race([openPromise, timeout]);
    log2("dataset opened");
  }
  /** Get the WASM dataset handle. Throws if not opened. */
  get wasmDs() {
    if (!this._wasmDs)
      throw new Error("WASM dataset not opened");
    return this._wasmDs;
  }
  /** Release the WASM dataset handle. */
  releaseDataset() {
    if (this._wasmDs) {
      deeplakeRelease(this._wasmDs);
      this._wasmDs = null;
      log2("dataset released");
    }
  }
  // ── WASM writes ───────────────────────────────────────────────────────────
  /** Append new rows via WASM (does NOT commit). */
  async wasmAppend(batch) {
    await deeplakeAppend(this.wasmDs, batch);
  }
  /** Update a row in-place via WASM (does NOT commit). */
  async wasmSetRow(rowIndex, data) {
    await deeplakeSetRow(this.wasmDs, rowIndex, data);
  }
  /** Commit all pending WASM changes to S3. */
  async wasmCommit(message) {
    await deeplakeCommit(this.wasmDs, message);
  }
  /** Get number of rows via WASM. */
  wasmNumRows() {
    return deeplakeNumRows(this.wasmDs);
  }
  /** Get a column's data for a range of rows via WASM. */
  async wasmGetColumnData(column, start, end) {
    return deeplakeGetColumnData(this.wasmDs, column, start, end);
  }
  // ── SQL reads via ManagedClient ───────────────────────────────────────────
  /** Execute SQL and return results as row-objects. */
  async query(sql) {
    return this._client.query(sql);
  }
  // ── Writes (legacy SQL path, kept for appendFile / rm / ensureTable) ──────
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
    await this._client.createIndex(this.tableName, column);
  }
  /** List all tables in the workspace. */
  async listTables() {
    return this._client.listTables();
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

// dist/src/hooks/pre-tool-use.js
var log3 = (msg) => log("pre", msg);
var MEMORY_PATH = join3(homedir3(), ".deeplake", "memory");
var TILDE_PATH = "~/.deeplake/memory";
var HOME_VAR_PATH = "$HOME/.deeplake/memory";
var __bundleDir = dirname(fileURLToPath(import.meta.url));
var SHELL_BUNDLE = existsSync2(join3(__bundleDir, "shell", "deeplake-shell.js")) ? join3(__bundleDir, "shell", "deeplake-shell.js") : join3(__bundleDir, "..", "shell", "deeplake-shell.js");
var SAFE_BUILTINS = /* @__PURE__ */ new Set([
  // filesystem
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
  // text processing
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
  // search
  "find",
  "xargs",
  "which",
  // data formats
  "jq",
  "yq",
  "xan",
  "base64",
  "od",
  // archives
  "tar",
  "gzip",
  "gunzip",
  "zcat",
  // hashing
  "md5sum",
  "sha1sum",
  "sha256sum",
  // output/io
  "echo",
  "printf",
  "tee",
  "cat",
  // path/env
  "pwd",
  "cd",
  "basename",
  "dirname",
  "env",
  "printenv",
  "hostname",
  "whoami",
  // misc
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
  // shell control flow
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
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const stages = stripped.split(/\||;|&&|\|\|/);
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
      const fp = toolInput.file_path;
      if (fp && touchesMemory(fp)) {
        const virtualPath = rewritePaths(fp) || "/";
        return `cat ${virtualPath}`;
      }
      break;
    }
    case "Bash": {
      const cmd = toolInput.command;
      if (!cmd || !touchesMemory(cmd))
        break;
      if (/\bdeeplake\s+(mount|login|unmount|status)\b/.test(cmd) || cmd.includes("deeplake.ai/install"))
        break;
      {
        const rewritten = rewritePaths(cmd);
        if (!isSafe(rewritten)) {
          log3(`unsafe command blocked: ${rewritten}`);
          return null;
        }
        return rewritten;
      }
      break;
    }
    case "Glob": {
      const p = toolInput.path;
      if (p && touchesMemory(p)) {
        return `ls /`;
      }
      break;
    }
  }
  return null;
}
async function main() {
  const input = await readStdin();
  log3(`hook fired: tool=${input.tool_name} input=${JSON.stringify(input.tool_input)}`);
  const cmd = input.tool_input.command ?? "";
  const shellCmd = getShellCommand(input.tool_name, input.tool_input);
  if (!shellCmd && touchesMemory(cmd) && (/\bdeeplake\s+(mount|login|unmount|status)\b/.test(cmd) || cmd.includes("deeplake.ai/install"))) {
    log3(`deeplake CLI command \u2014 passing through to real bash`);
    return;
  }
  if (!shellCmd && touchesMemory(cmd)) {
    let cliInstalled = false;
    try {
      execFileSync("which", ["deeplake"], { stdio: "ignore", timeout: 2e3 });
      cliInstalled = true;
    } catch {
      const paths = ["/usr/local/bin/deeplake", join3(homedir3(), ".local", "bin", "deeplake"), join3(homedir3(), ".deeplake", "bin", "deeplake")];
      cliInstalled = paths.some((p) => existsSync2(p));
    }
    if (cliInstalled) {
      const mountActive = existsSync2(join3(MEMORY_PATH, ".deeplake"));
      if (mountActive) {
        log3(`unsafe, CLI installed + mounted \u2014 passing through to real bash`);
        return;
      }
      log3(`unsafe, CLI installed but not mounted \u2192 suggesting mount`);
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "The Deeplake CLI is installed but the memory filesystem is not mounted.",
          additionalContext: "Ask the user: 'The Deeplake memory filesystem needs to be mounted. Shall I mount it?' If they agree, run: deeplake mount ~/.deeplake/memory \u2014 then retry the original command. If mount fails, report the error and stop."
        }
      }));
      return;
    }
    log3(`unsafe, CLI not installed \u2192 suggesting install`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "This command requires the Deeplake CLI with FUSE mount support.",
        additionalContext: "Ask the user: 'This command needs the Deeplake CLI. Shall I install it?' If they agree, run: curl -fsSL https://deeplake.ai/install.sh | bash && deeplake mount ~/.deeplake/memory \u2014 then retry the original command. If they decline, rewrite using safe builtins (cat, grep, jq, head, tail). If install fails (FUSE not supported, Windows, permission error), report the error and stop."
      }
    }));
    return;
  }
  if (!shellCmd)
    return;
  const config = loadConfig();
  if (config && (input.tool_name === "Read" || input.tool_name === "Grep")) {
    const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
    try {
      if (input.tool_name === "Read") {
        const virtualPath = rewritePaths(input.tool_input.file_path ?? "");
        log3(`direct read: ${virtualPath}`);
        const rows = await api.query(`SELECT content_text FROM "${table}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`);
        if (rows.length > 0 && rows[0]["content_text"]) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: {
                command: `echo ${JSON.stringify(rows[0]["content_text"])}`,
                description: `[DeepLake direct] cat ${virtualPath}`
              }
            }
          }));
          return;
        }
      } else if (input.tool_name === "Grep") {
        const pattern = input.tool_input.pattern ?? "";
        const ignoreCase = !!input.tool_input["-i"];
        log3(`direct grep: ${pattern}`);
        const pathRows = await api.query(`SELECT path FROM "${table}" WHERE content_text ${ignoreCase ? "ILIKE" : "LIKE"} '%${sqlStr(pattern)}%' LIMIT 10`);
        if (pathRows.length > 0) {
          const allResults = [];
          for (const pr of pathRows.slice(0, 5)) {
            const p = pr["path"];
            const contentRows = await api.query(`SELECT content_text FROM "${table}" WHERE path = '${sqlStr(p)}' LIMIT 1`);
            if (!contentRows[0]?.["content_text"])
              continue;
            const text = contentRows[0]["content_text"];
            const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
            const matches = text.split("\n").filter((line) => re.test(line)).slice(0, 5).map((line) => `${p}:${line.slice(0, 300)}`);
            allResults.push(...matches);
          }
          const results = allResults.join("\n");
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: {
                command: `echo ${JSON.stringify(results || "(no matches)")}`,
                description: `[DeepLake direct] grep ${pattern}`
              }
            }
          }));
          return;
        }
      }
    } catch (e) {
      log3(`direct query failed, falling back to shell: ${e.message}`);
    }
  }
  log3(`intercepted \u2192 rewriting to shell: ${shellCmd}`);
  const rewrittenCommand = `node "${SHELL_BUNDLE}" -c "${shellCmd.replace(/"/g, '\\"')}"`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        command: rewrittenCommand,
        description: `[DeepLake virtual FS] ${shellCmd}`
      }
    }
  };
  log3(`rewritten: ${rewrittenCommand}`);
  console.log(JSON.stringify(output));
}
main().catch((e) => {
  log3(`fatal: ${e.message}`);
  process.exit(0);
});
