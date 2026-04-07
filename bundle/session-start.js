#!/usr/bin/env node

// dist/src/hooks/session-start.js
import { fileURLToPath } from "node:url";
import { dirname, join as join4 } from "node:path";
import { mkdirSync as mkdirSync2, appendFileSync as appendFileSync2 } from "node:fs";
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

// dist/src/config.js
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
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
    userName: creds?.userName ?? "user",
    workspaceId: process.env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.DEEPLAKE_TABLE ?? "memory",
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
    const paths = rows.map((r) => r.path);
    const escapedPaths = paths.map((p) => `'${sqlStr(p)}'`).join(", ");
    try {
      await this.query(`DELETE FROM "${this.tableName}" WHERE path IN (${escapedPaths})`);
    } catch {
    }
    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map((r) => this.upsertRowSql(r)));
    }
    log2(`commit: ${rows.length} rows`);
  }
  async upsertRowSql(row) {
    const hex = row.content.toString("hex");
    const id = randomUUID();
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const sql = `INSERT INTO "${this.tableName}" (id, path, filename, content, content_text, mime_type, size_bytes, timestamp) VALUES ('${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'\\\\x${hex}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${ts}')`;
    try {
      await this.query(sql);
    } catch (e) {
      if (e.message?.includes("duplicate") || e.message?.includes("unique")) {
        const updateSql = `UPDATE "${this.tableName}" SET content = E'\\\\x${hex}', content_text = E'${sqlStr(row.contentText)}', mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes} WHERE path = '${sqlStr(row.path)}'`;
        await this.query(updateSql);
      } else {
        throw e;
      }
    }
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
  /** Create the table if it doesn't already exist. */
  async ensureTable() {
    const tables = await this.listTables();
    if (tables.includes(this.tableName))
      return;
    log2(`table "${this.tableName}" not found, creating`);
    await this.query(`CREATE TABLE IF NOT EXISTS "${this.tableName}" (id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', content BYTEA NOT NULL DEFAULT ''::bytea, content_text TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size_bytes BIGINT NOT NULL DEFAULT 0, timestamp TEXT NOT NULL DEFAULT '') USING deeplake`);
    log2(`table "${this.tableName}" created`);
  }
};

// dist/src/shell/deeplake-fs.js
import { basename, posix } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var BATCH_SIZE = 10;
var FLUSH_DEBOUNCE_MS = 200;
var TEXT_DETECT_BYTES = 4096;
function normPath(p) {
  const r = posix.normalize(p.startsWith("/") ? p : "/" + p);
  return r === "/" ? r : r.replace(/\/$/, "");
}
function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
function isText(buf) {
  const end = Math.min(buf.length, TEXT_DETECT_BYTES);
  for (let i = 0; i < end; i++)
    if (buf[i] === 0)
      return false;
  return true;
}
function guessMime(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return {
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    js: "text/javascript",
    ts: "text/typescript",
    html: "text/html",
    css: "text/css",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    pdf: "application/pdf",
    svg: "image/svg+xml",
    gz: "application/gzip",
    zip: "application/zip"
  }[ext] ?? "application/octet-stream";
}
function fsErr(code, msg, path) {
  return Object.assign(new Error(`${code}: ${msg}, '${path}'`), { code });
}
function decodeContent(raw) {
  if (raw instanceof Uint8Array)
    return Buffer.from(raw);
  if (Buffer.isBuffer(raw))
    return raw;
  if (typeof raw === "string") {
    return raw.startsWith("\\x") ? Buffer.from(raw.slice(2), "hex") : Buffer.from(raw, "base64");
  }
  throw new Error(`Unexpected content type: ${typeof raw}`);
}
var DeeplakeFs = class _DeeplakeFs {
  client;
  table;
  mountPoint;
  // path → Buffer (content) or null (exists but not fetched yet)
  files = /* @__PURE__ */ new Map();
  meta = /* @__PURE__ */ new Map();
  // dir path → Set of immediate child names
  dirs = /* @__PURE__ */ new Map();
  // batched writes pending SQL flush
  pending = /* @__PURE__ */ new Map();
  flushTimer = null;
  // serialize flushes
  flushChain = Promise.resolve();
  constructor(client, table, mountPoint) {
    this.client = client;
    this.table = table;
    this.mountPoint = mountPoint;
    this.dirs.set(mountPoint, /* @__PURE__ */ new Set());
    if (mountPoint !== "/")
      this.dirs.set("/", /* @__PURE__ */ new Set([mountPoint.slice(1)]));
  }
  static async create(client, table, mount = "/memory") {
    const fs = new _DeeplakeFs(client, table, mount);
    await client.ensureTable();
    await client.query(`SELECT deeplake_sync_table('${table}')`);
    const sql = `SELECT path, size_bytes, mime_type FROM "${table}" ORDER BY path`;
    try {
      let rows;
      try {
        rows = await client.query(sql);
      } catch {
        rows = await client.query(sql);
      }
      for (const row of rows) {
        const p = row["path"];
        fs.files.set(p, null);
        fs.meta.set(p, {
          size: Number(row["size_bytes"] ?? 0),
          mime: row["mime_type"] ?? "application/octet-stream",
          mtime: /* @__PURE__ */ new Date()
        });
        fs.addToTree(p);
      }
    } catch {
    }
    return fs;
  }
  // ── tree management ───────────────────────────────────────────────────────
  addToTree(filePath) {
    const segs = filePath.split("/").filter(Boolean);
    for (let d = 0; d < segs.length; d++) {
      const dir = d === 0 ? "/" : "/" + segs.slice(0, d).join("/");
      if (!this.dirs.has(dir))
        this.dirs.set(dir, /* @__PURE__ */ new Set());
      this.dirs.get(dir).add(segs[d]);
    }
  }
  removeFromTree(filePath) {
    this.files.delete(filePath);
    this.meta.delete(filePath);
    this.pending.delete(filePath);
    const parent = parentOf(filePath);
    this.dirs.get(parent)?.delete(basename(filePath));
  }
  // ── flush / write batching ────────────────────────────────────────────────
  scheduleFlush() {
    if (this.flushTimer !== null)
      return;
    this.flushTimer = setTimeout(() => {
      this.flush().catch(() => {
      });
    }, FLUSH_DEBOUNCE_MS);
  }
  async flush() {
    this.flushChain = this.flushChain.then(() => this._doFlush());
    return this.flushChain;
  }
  async _doFlush() {
    if (this.pending.size === 0)
      return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const rows = [...this.pending.values()];
    this.pending.clear();
    for (const r of rows) {
      const hex = r.content.toString("hex");
      const text = sqlStr(r.contentText);
      const p = sqlStr(r.path);
      const fname = sqlStr(r.filename);
      const mime = sqlStr(r.mimeType);
      const id = randomUUID2();
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      await this.client.query(`DELETE FROM "${this.table}" WHERE path = '${p}'`);
      await this.client.query(`INSERT INTO "${this.table}" (id, path, filename, content, content_text, mime_type, size_bytes, timestamp) VALUES ('${id}', '${p}', '${fname}', E'\\\\x${hex}', E'${text}', '${mime}', ${r.sizeBytes}, '${ts}')`);
    }
    await this.client.query(`SELECT deeplake_sync_table('${this.table}')`);
  }
  // ── IFileSystem: reads ────────────────────────────────────────────────────
  async readFileBuffer(path) {
    const p = normPath(path);
    if (this.dirs.has(p) && !this.files.has(p))
      throw fsErr("EISDIR", "illegal operation on a directory", p);
    if (!this.files.has(p))
      throw fsErr("ENOENT", "no such file or directory", p);
    const cached = this.files.get(p);
    if (cached !== null && cached !== void 0)
      return cached;
    const pend = this.pending.get(p);
    if (pend) {
      this.files.set(p, pend.content);
      return pend.content;
    }
    const rows = await this.client.query(`SELECT content FROM "${this.table}" WHERE path = '${sqlStr(p)}' LIMIT 1`);
    if (rows.length === 0)
      throw fsErr("ENOENT", "no such file or directory", p);
    const buf = decodeContent(rows[0]["content"]);
    this.files.set(p, buf);
    return buf;
  }
  async readFile(path, _opts) {
    const p = normPath(path);
    if (this.dirs.has(p) && !this.files.has(p))
      throw fsErr("EISDIR", "illegal operation on a directory", p);
    if (!this.files.has(p))
      throw fsErr("ENOENT", "no such file or directory", p);
    const pend = this.pending.get(p);
    if (pend)
      return pend.contentText || pend.content.toString("utf-8");
    const rows = await this.client.query(`SELECT content_text, content FROM "${this.table}" WHERE path = '${sqlStr(p)}' LIMIT 1`);
    if (rows.length === 0)
      throw fsErr("ENOENT", "no such file or directory", p);
    const row = rows[0];
    const text = row["content_text"];
    if (text && text.length > 0) {
      const buf2 = Buffer.from(text, "utf-8");
      this.files.set(p, buf2);
      return text;
    }
    const buf = decodeContent(row["content"]);
    this.files.set(p, buf);
    return buf.toString("utf-8");
  }
  // ── IFileSystem: writes ───────────────────────────────────────────────────
  async writeFile(path, content, _opts) {
    const p = normPath(path);
    if (this.dirs.has(p) && !this.files.has(p))
      throw fsErr("EISDIR", "illegal operation on a directory", p);
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
    const mime = guessMime(basename(p));
    const contentText = isText(buf) ? buf.toString("utf-8") : "";
    this.files.set(p, buf);
    this.meta.set(p, { size: buf.length, mime, mtime: /* @__PURE__ */ new Date() });
    this.addToTree(p);
    this.pending.set(p, {
      path: p,
      filename: basename(p),
      content: buf,
      contentText,
      mimeType: mime,
      sizeBytes: buf.length
    });
    if (this.pending.size >= BATCH_SIZE)
      await this.flush();
    else
      this.scheduleFlush();
  }
  async appendFile(path, content, opts) {
    const p = normPath(path);
    const add = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
    if (this.files.has(p) || await this.exists(p).catch(() => false)) {
      const addHex = Buffer.from(add, "utf-8").toString("hex");
      await this.client.query(`UPDATE "${this.table}" SET content_text = content_text || E'${sqlStr(add)}', content = content || E'\\\\x${addHex}', size_bytes = size_bytes + ${Buffer.byteLength(add, "utf-8")} WHERE path = '${sqlStr(p)}'`);
      const m = this.meta.get(p);
      if (m)
        m.size += Buffer.byteLength(add, "utf-8");
    } else {
      await this.writeFile(p, typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content), opts);
      await this.flush();
    }
  }
  // ── IFileSystem: metadata ─────────────────────────────────────────────────
  async exists(path) {
    const p = normPath(path);
    return this.files.has(p) || this.dirs.has(p);
  }
  async stat(path) {
    const p = normPath(path);
    const isFile = this.files.has(p);
    const isDir = this.dirs.has(p);
    if (!isFile && !isDir)
      throw fsErr("ENOENT", "no such file or directory", p);
    const m = this.meta.get(p);
    return {
      isFile: isFile && !isDir,
      isDirectory: isDir,
      isSymbolicLink: false,
      mode: isDir ? 493 : 420,
      size: m?.size ?? 0,
      mtime: m?.mtime ?? /* @__PURE__ */ new Date()
    };
  }
  async lstat(path) {
    return this.stat(path);
  }
  async chmod(_path, _mode) {
  }
  async utimes(_path, _atime, _mtime) {
  }
  async symlink(_target, linkPath) {
    throw fsErr("EPERM", "operation not permitted", linkPath);
  }
  async link(_src, destPath) {
    throw fsErr("EPERM", "operation not permitted", destPath);
  }
  async readlink(path) {
    throw fsErr("EINVAL", "invalid argument", path);
  }
  async realpath(path) {
    const p = normPath(path);
    if (!this.files.has(p) && !this.dirs.has(p))
      throw fsErr("ENOENT", "no such file or directory", p);
    return p;
  }
  // ── IFileSystem: directories ──────────────────────────────────────────────
  async mkdir(path, opts) {
    const p = normPath(path);
    if (this.files.has(p))
      throw fsErr("EEXIST", "file exists", p);
    if (this.dirs.has(p)) {
      if (!opts?.recursive)
        throw fsErr("EEXIST", "file exists", p);
      return;
    }
    if (!opts?.recursive) {
      const parent2 = parentOf(p);
      if (!this.dirs.has(parent2))
        throw fsErr("ENOENT", "no such file or directory", parent2);
    }
    this.dirs.set(p, /* @__PURE__ */ new Set());
    const parent = parentOf(p);
    if (!this.dirs.has(parent))
      this.dirs.set(parent, /* @__PURE__ */ new Set());
    this.dirs.get(parent).add(basename(p));
  }
  async readdir(path) {
    const p = normPath(path);
    if (!this.dirs.has(p))
      throw fsErr("ENOTDIR", "not a directory", p);
    return [...this.dirs.get(p) ?? []];
  }
  async readdirWithFileTypes(path) {
    const names = await this.readdir(path);
    const p = normPath(path);
    return names.map((name) => {
      const child = p === "/" ? `/${name}` : `${p}/${name}`;
      return {
        name,
        isFile: this.files.has(child) && !this.dirs.has(child),
        isDirectory: this.dirs.has(child),
        isSymbolicLink: false
      };
    });
  }
  // ── IFileSystem: structural mutations ─────────────────────────────────────
  async rm(path, opts) {
    const p = normPath(path);
    if (!this.files.has(p) && !this.dirs.has(p)) {
      if (opts?.force)
        return;
      throw fsErr("ENOENT", "no such file or directory", p);
    }
    if (this.dirs.has(p)) {
      const children = this.dirs.get(p) ?? /* @__PURE__ */ new Set();
      if (children.size > 0 && !opts?.recursive)
        throw fsErr("ENOTEMPTY", "directory not empty", p);
      const toDelete = [];
      const stack = [p];
      while (stack.length) {
        const cur = stack.pop();
        for (const child of [...this.dirs.get(cur) ?? []]) {
          const childPath = cur === "/" ? `/${child}` : `${cur}/${child}`;
          if (this.files.has(childPath))
            toDelete.push(childPath);
          if (this.dirs.has(childPath))
            stack.push(childPath);
        }
      }
      for (const fp of toDelete)
        this.removeFromTree(fp);
      this.dirs.delete(p);
      this.dirs.get(parentOf(p))?.delete(basename(p));
      if (toDelete.length > 0) {
        const inList = toDelete.map((fp) => `'${sqlStr(fp)}'`).join(", ");
        await this.client.query(`DELETE FROM "${this.table}" WHERE path IN (${inList})`);
      }
    } else {
      await this.client.query(`DELETE FROM "${this.table}" WHERE path = '${sqlStr(p)}'`);
      this.removeFromTree(p);
    }
  }
  async cp(src, dest, opts) {
    const s = normPath(src), d = normPath(dest);
    if (this.dirs.has(s) && !this.files.has(s)) {
      if (!opts?.recursive)
        throw fsErr("EISDIR", "is a directory", s);
      for (const fp of [...this.files.keys()].filter((k) => k === s || k.startsWith(s + "/"))) {
        await this.writeFile(d + fp.slice(s.length), await this.readFileBuffer(fp));
      }
    } else {
      await this.writeFile(d, await this.readFileBuffer(s));
    }
  }
  async mv(src, dest) {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: true });
  }
  resolvePath(base, path) {
    if (path.startsWith("/"))
      return normPath(path);
    return normPath(posix.join(base, path));
  }
  getAllPaths() {
    return [.../* @__PURE__ */ new Set([...this.files.keys(), ...this.dirs.keys()])];
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
- ~/.deeplake/memory/summaries/*.md \u2014 AI-generated wiki summaries per session
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
async function createPlaceholder(fs, sessionId, cwd) {
  try {
    await fs.mkdir("/summaries");
  } catch {
  }
  try {
    await fs.mkdir("/sessions");
  } catch {
  }
  const indexExists = await fs.exists("/index.md");
  if (!indexExists) {
    await fs.writeFile("/index.md", [
      "# Session Index",
      "",
      "List of all Claude Code sessions with summaries.",
      "",
      "| Session | Date | Project | Description |",
      "|---------|------|---------|-------------|",
      ""
    ].join("\n"));
    wikiLog("Created index.md");
  }
  const summaryPath = `/summaries/${sessionId}.md`;
  const summaryExists = await fs.exists(summaryPath);
  if (!summaryExists) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await fs.writeFile(summaryPath, [
      `# Session ${sessionId}`,
      `- **Started**: ${now}`,
      `- **Project**: ${cwd}`,
      `- **Status**: in-progress`,
      ""
    ].join("\n"));
    const shortDate = now.slice(0, 10);
    const projectName = cwd.split("/").pop() ?? "unknown";
    await fs.appendFile("/index.md", `| [${sessionId}](summaries/${sessionId}.md) | ${shortDate} | ${projectName} | in progress |
`);
    await fs.flush();
    wikiLog(`SessionStart: created placeholder for ${sessionId} (${cwd})`);
  } else {
    wikiLog(`SessionStart: summary exists for ${sessionId} (resumed)`);
  }
}
async function main() {
  const input = await readStdin();
  let creds = loadCredentials();
  if (!creds?.token) {
    log3("no credentials found \u2014 skipping auth (non-blocking)");
  } else {
    log3(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    if (creds.token && !creds.userName) {
      try {
        const { userInfo } = await import("node:os");
        creds.userName = userInfo().username ?? "user";
        log3(`backfilled userName: ${creds.userName}`);
      } catch {
      }
    }
  }
  if (input.session_id && creds?.token) {
    try {
      const config = loadConfig();
      if (config) {
        const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
        const fs = await DeeplakeFs.create(api, table, "/");
        await createPlaceholder(fs, input.session_id, input.cwd ?? "");
        log3("placeholder created");
      }
    } catch (e) {
      log3(`placeholder failed: ${e.message}`);
    }
  }
  const resolvedContext = context.replace(/DEEPLAKE_AUTH_CMD/g, AUTH_CMD);
  const additionalContext = creds?.token ? `${resolvedContext}

Logged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})` : `${resolvedContext}

\u26A0\uFE0F Not logged in to Deeplake. Memory search will not work. Ask the user to run /deeplake:deeplake-login.`;
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
