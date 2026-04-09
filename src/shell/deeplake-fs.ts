import { basename, posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeeplakeApi } from "../deeplake-api.js";
import type {
  IFileSystem, FsStat, MkdirOptions, RmOptions, CpOptions,
  FileContent, BufferEncoding,
} from "just-bash";

interface ReadFileOptions { encoding?: BufferEncoding }
interface WriteFileOptions { encoding?: BufferEncoding }
interface DirentEntry { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

// ── constants ─────────────────────────────────────────────────────────────────
const BATCH_SIZE = 10;
const FLUSH_DEBOUNCE_MS = 200;
const TEXT_DETECT_BYTES = 4096;

// ── helpers ───────────────────────────────────────────────────────────────────
export function normPath(p: string): string {
  const r = posix.normalize(p.startsWith("/") ? p : "/" + p);
  return r === "/" ? r : r.replace(/\/$/, "");
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

import { sqlStr as esc } from "../utils/sql.js";

export function isText(buf: Buffer): boolean {
  const end = Math.min(buf.length, TEXT_DETECT_BYTES);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return false;
  return true;
}

export function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (
    ({
      json: "application/json", md: "text/markdown", txt: "text/plain",
      js: "text/javascript", ts: "text/typescript", html: "text/html",
      css: "text/css", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      pdf: "application/pdf", svg: "image/svg+xml", gz: "application/gzip",
      zip: "application/zip",
    } as Record<string, string>)[ext] ?? "application/octet-stream"
  );
}

function fsErr(code: string, msg: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${msg}, '${path}'`), { code });
}

// Decode content returned from SQL: PostgreSQL hex-encodes BYTEA as '\x...'
function decodeContent(raw: unknown): Buffer {
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") {
    return raw.startsWith("\\x")
      ? Buffer.from(raw.slice(2), "hex")
      : Buffer.from(raw, "base64");
  }
  throw new Error(`Unexpected content type: ${typeof raw}`);
}

// ── types ─────────────────────────────────────────────────────────────────────
interface FileMeta { size: number; mime: string; mtime: Date; }

interface PendingRow {
  path: string; filename: string; content: Buffer;
  contentText: string; mimeType: string; sizeBytes: number;
  project?: string; description?: string;
  creationDate?: string; lastUpdateDate?: string;
}

// ── DeeplakeFs ────────────────────────────────────────────────────────────────
export class DeeplakeFs implements IFileSystem {
  // path → Buffer (content) or null (exists but not fetched yet)
  private files = new Map<string, Buffer | null>();
  private meta  = new Map<string, FileMeta>();
  // dir path → Set of immediate child names
  private dirs  = new Map<string, Set<string>>();
  // batched writes pending SQL flush
  private pending = new Map<string, PendingRow>();
  // paths that have been flushed (INSERT) at least once — subsequent flushes use UPDATE
  private flushed = new Set<string>();

  /** Number of files loaded from the server during bootstrap. */
  get fileCount(): number { return this.files.size; }
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // serialize flushes
  private flushChain: Promise<void> = Promise.resolve();

  // Paths that live in the sessions table (multi-row, read by concatenation)
  private sessionPaths = new Set<string>();
  private sessionsTable: string | null = null;

  private constructor(
    private readonly client: DeeplakeApi,
    private readonly table: string,
    readonly mountPoint: string,
  ) {
    this.dirs.set(mountPoint, new Set());
    if (mountPoint !== "/") this.dirs.set("/", new Set([mountPoint.slice(1)]));
  }

  static async create(
    client: DeeplakeApi,
    table: string,
    mount = "/memory",
    sessionsTable?: string,
  ): Promise<DeeplakeFs> {
    const fs = new DeeplakeFs(client, table, mount);
    fs.sessionsTable = sessionsTable ?? null;
    // Ensure the table exists before bootstrapping.
    await client.ensureTable();
    // Sync table to ensure query engine sees latest writes.
    await client.query(`SELECT deeplake_sync_table('${table}')`);
    // Bootstrap: load path metadata from memory table.
    const sql = `SELECT path, size_bytes, mime_type FROM "${table}" ORDER BY path`;
    try {
      let rows: Record<string, unknown>[];
      try {
        rows = await client.query(sql);
      } catch {
        rows = await client.query(sql);
      }
      for (const row of rows) {
        const p = row["path"] as string;
        fs.files.set(p, null);
        fs.meta.set(p, {
          size: Number(row["size_bytes"] ?? 0),
          mime: (row["mime_type"] as string) ?? "application/octet-stream",
          mtime: new Date(),
        });
        fs.addToTree(p);
        fs.flushed.add(p);
      }
    } catch {
      // Table may not exist yet — start empty
    }

    // Bootstrap: load session paths from sessions table (distinct paths only).
    if (sessionsTable) {
      try {
        await client.query(`SELECT deeplake_sync_table('${sessionsTable}')`);
        const sessionRows = await client.query(
          `SELECT path, SUM(size_bytes) as total_size FROM "${sessionsTable}" GROUP BY path ORDER BY path`
        );
        for (const row of sessionRows) {
          const p = row["path"] as string;
          if (!fs.files.has(p)) {
            fs.files.set(p, null);
            fs.meta.set(p, {
              size: Number(row["total_size"] ?? 0),
              mime: "application/x-ndjson",
              mtime: new Date(),
            });
            fs.addToTree(p);
          }
          fs.sessionPaths.add(p);
        }
      } catch {
        // Sessions table may not exist yet
      }
    }

    return fs;
  }

  // ── tree management ───────────────────────────────────────────────────────
  private addToTree(filePath: string): void {
    const segs = filePath.split("/").filter(Boolean);
    for (let d = 0; d < segs.length; d++) {
      const dir = d === 0 ? "/" : "/" + segs.slice(0, d).join("/");
      if (!this.dirs.has(dir)) this.dirs.set(dir, new Set());
      this.dirs.get(dir)!.add(segs[d]);
    }
  }

  private removeFromTree(filePath: string): void {
    this.files.delete(filePath);
    this.meta.delete(filePath);
    this.pending.delete(filePath);
    this.flushed.delete(filePath);
    const parent = parentOf(filePath);
    this.dirs.get(parent)?.delete(basename(filePath));
  }

  // ── flush / write batching ────────────────────────────────────────────────
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flush().catch(() => {});
    }, FLUSH_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this._doFlush());
    return this.flushChain;
  }

  private async _doFlush(): Promise<void> {
    if (this.pending.size === 0) return;
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }

    const rows = [...this.pending.values()];
    this.pending.clear();

    // Upsert: UPDATE existing rows, INSERT new ones. Preserves stable id.
    for (const r of rows) {
      const hex   = r.content.toString("hex");
      const text  = esc(r.contentText);
      const p     = esc(r.path);
      const fname = esc(r.filename);
      const mime  = esc(r.mimeType);
      const ts = new Date().toISOString();
      const cd = r.creationDate ?? ts;
      const lud = r.lastUpdateDate ?? ts;
      if (this.flushed.has(r.path)) {
        let setClauses = `filename = '${fname}', content = E'\\\\x${hex}', summary = E'${text}', ` +
          `mime_type = '${mime}', size_bytes = ${r.sizeBytes}, last_update_date = '${esc(lud)}'`;
        if (r.project !== undefined) setClauses += `, project = '${esc(r.project)}'`;
        if (r.description !== undefined) setClauses += `, description = '${esc(r.description)}'`;
        await this.client.query(
          `UPDATE "${this.table}" SET ${setClauses} WHERE path = '${p}'`
        );
      } else {
        const id = randomUUID();
        const cols = "id, path, filename, content, summary, mime_type, size_bytes, creation_date, last_update_date" +
          (r.project !== undefined ? ", project" : "") +
          (r.description !== undefined ? ", description" : "");
        const vals = `'${id}', '${p}', '${fname}', E'\\\\x${hex}', E'${text}', '${mime}', ${r.sizeBytes}, '${esc(cd)}', '${esc(lud)}'` +
          (r.project !== undefined ? `, '${esc(r.project)}'` : "") +
          (r.description !== undefined ? `, '${esc(r.description)}'` : "");
        await this.client.query(
          `INSERT INTO "${this.table}" (${cols}) VALUES (${vals})`
        );
        this.flushed.add(r.path);
      }
    }
    // Sync so subsequent reads see the new data.
    await this.client.query(`SELECT deeplake_sync_table('${this.table}')`);
  }

  // ── Virtual index.md generation ────────────────────────────────────────────

  private async generateVirtualIndex(): Promise<string> {
    const rows = await this.client.query(
      `SELECT path, project, description, creation_date, last_update_date FROM "${this.table}" ` +
      `WHERE path LIKE '${esc("/summaries/")}%' ORDER BY last_update_date DESC`
    );
    const lines: string[] = [
      "# Session Index",
      "",
      "List of all Claude Code sessions with summaries.",
      "",
      "| Session | Created | Last Updated | Project | Description |",
      "|---------|---------|--------------|---------|-------------|",
    ];
    for (const row of rows) {
      const p = row["path"] as string;
      // Extract session ID from path: /summaries/<user>/<id>.md
      const match = p.match(/\/summaries\/([^/]+)\/([^/]+)\.md$/);
      if (!match) continue;
      const summaryUser = match[1];
      const sessionId = match[2];
      const relPath = `summaries/${summaryUser}/${sessionId}.md`;
      const project = (row["project"] as string) || "";
      const description = (row["description"] as string) || "";
      const creationDate = (row["creation_date"] as string) || "";
      const lastUpdateDate = (row["last_update_date"] as string) || "";
      lines.push(`| [${sessionId}](${relPath}) | ${creationDate} | ${lastUpdateDate} | ${project} | ${description} |`);
    }
    lines.push("");
    return lines.join("\n");
  }

  // ── IFileSystem: reads ────────────────────────────────────────────────────

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normPath(path);
    if (this.dirs.has(p) && !this.files.has(p)) throw fsErr("EISDIR", "illegal operation on a directory", p);
    if (!this.files.has(p)) throw fsErr("ENOENT", "no such file or directory", p);

    // 1. Content cache
    const cached = this.files.get(p);
    if (cached !== null && cached !== undefined) return cached;

    // 2. Pending batch (written but not yet flushed)
    const pend = this.pending.get(p);
    if (pend) { this.files.set(p, pend.content); return pend.content; }

    // 3. Session files: concatenate rows from sessions table
    if (this.sessionPaths.has(p) && this.sessionsTable) {
      const rows = await this.client.query(
        `SELECT message FROM "${this.sessionsTable}" WHERE path = '${esc(p)}' ORDER BY creation_date ASC`
      );
      if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
      const text = rows.map(r => typeof r["message"] === "string" ? r["message"] : JSON.stringify(r["message"])).join("\n");
      const buf = Buffer.from(text, "utf-8");
      this.files.set(p, buf);
      return buf;
    }

    // 4. SQL query — content column (BYTEA returned as hex '\x...')
    const rows = await this.client.query(
      `SELECT content FROM "${this.table}" WHERE path = '${esc(p)}' LIMIT 1`
    );
    if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
    const buf = decodeContent(rows[0]["content"]);
    this.files.set(p, buf);
    return buf;
  }

  async readFile(path: string, _opts?: ReadFileOptions | BufferEncoding): Promise<string> {
    const p = normPath(path);
    if (this.dirs.has(p) && !this.files.has(p)) throw fsErr("EISDIR", "illegal operation on a directory", p);

    // Virtual index.md: if no real row exists, generate from summary rows
    if (p === "/index.md" && !this.files.has(p)) {
      // Check if a real /index.md row exists in the table
      const realRows = await this.client.query(
        `SELECT summary FROM "${this.table}" WHERE path = '${esc("/index.md")}' LIMIT 1`
      );
      if (realRows.length > 0 && realRows[0]["summary"]) {
        const text = realRows[0]["summary"] as string;
        const buf = Buffer.from(text, "utf-8");
        this.files.set(p, buf);
        return text;
      }
      // No real row — generate virtual index
      return this.generateVirtualIndex();
    }

    if (!this.files.has(p)) throw fsErr("ENOENT", "no such file or directory", p);

    // Pending batch
    const pend = this.pending.get(p);
    if (pend) return pend.contentText || pend.content.toString("utf-8");

    // Session files: concatenate rows from sessions table, ordered by creation_date
    if (this.sessionPaths.has(p) && this.sessionsTable) {
      const rows = await this.client.query(
        `SELECT message FROM "${this.sessionsTable}" WHERE path = '${esc(p)}' ORDER BY creation_date ASC`
      );
      if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
      const text = rows.map(r => typeof r["message"] === "string" ? r["message"] : JSON.stringify(r["message"])).join("\n");
      const buf = Buffer.from(text, "utf-8");
      this.files.set(p, buf);
      return text;
    }

    // For text files prefer summary column (avoids decoding binary column)
    const rows = await this.client.query(
      `SELECT summary, content FROM "${this.table}" WHERE path = '${esc(p)}' LIMIT 1`
    );
    if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
    const row = rows[0];
    const text = row["summary"] as string;
    if (text && text.length > 0) {
      const buf = Buffer.from(text, "utf-8");
      this.files.set(p, buf);
      return text;
    }
    // Binary file: decode content column
    const buf = decodeContent(row["content"]);
    this.files.set(p, buf);
    return buf.toString("utf-8");
  }

  // ── IFileSystem: writes ───────────────────────────────────────────────────

  /** Write a file with optional row-level metadata (project, description, dates). */
  async writeFileWithMeta(
    path: string, content: FileContent,
    meta: { project?: string; description?: string; creationDate?: string; lastUpdateDate?: string },
  ): Promise<void> {
    const p = normPath(path);
    if (this.dirs.has(p) && !this.files.has(p)) throw fsErr("EISDIR", "illegal operation on a directory", p);

    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
    const mime = guessMime(basename(p));
    const contentText = isText(buf) ? buf.toString("utf-8") : "";

    this.files.set(p, buf);
    this.meta.set(p, { size: buf.length, mime, mtime: new Date() });
    this.addToTree(p);

    this.pending.set(p, {
      path: p, filename: basename(p), content: buf,
      contentText, mimeType: mime, sizeBytes: buf.length,
      ...meta,
    });

    if (this.pending.size >= BATCH_SIZE) await this.flush();
    else this.scheduleFlush();
  }

  async writeFile(path: string, content: FileContent, _opts?: WriteFileOptions | BufferEncoding): Promise<void> {
    const p = normPath(path);
    if (this.dirs.has(p) && !this.files.has(p)) throw fsErr("EISDIR", "illegal operation on a directory", p);

    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
    const mime = guessMime(basename(p));
    const contentText = isText(buf) ? buf.toString("utf-8") : "";

    this.files.set(p, buf);
    this.meta.set(p, { size: buf.length, mime, mtime: new Date() });
    this.addToTree(p);

    this.pending.set(p, {
      path: p, filename: basename(p), content: buf,
      contentText, mimeType: mime, sizeBytes: buf.length,
    });

    if (this.pending.size >= BATCH_SIZE) await this.flush();
    else this.scheduleFlush();
  }

  async appendFile(path: string, content: FileContent, opts?: WriteFileOptions | BufferEncoding): Promise<void> {
    const p = normPath(path);
    const add = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");

    // Fast path: SQL-level concat — no read-back, O(1) per append
    if (this.files.has(p) || await this.exists(p).catch(() => false)) {
      const addHex = Buffer.from(add, "utf-8").toString("hex");
      const ts = new Date().toISOString();
      await this.client.query(
        `UPDATE "${this.table}" SET ` +
        `summary = summary || E'${esc(add)}', ` +
        `content = content || E'\\\\x${addHex}', ` +
        `size_bytes = size_bytes + ${Buffer.byteLength(add, "utf-8")}, ` +
        `last_update_date = '${ts}' ` +
        `WHERE path = '${esc(p)}'`
      );
      // Update local metadata
      const m = this.meta.get(p);
      if (m) { m.size += Buffer.byteLength(add, "utf-8"); m.mtime = new Date(ts); }
    } else {
      // File doesn't exist yet — create it
      await this.writeFile(p, typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content), opts);
      await this.flush();
    }
  }

  // ── IFileSystem: metadata ─────────────────────────────────────────────────

  async exists(path: string): Promise<boolean> {
    const p = normPath(path);
    if (p === "/index.md") return true; // Virtual index always exists
    return this.files.has(p) || this.dirs.has(p);
  }

  async stat(path: string): Promise<FsStat> {
    const p = normPath(path);
    const isFile = this.files.has(p);
    const isDir  = this.dirs.has(p);
    // Virtual index.md: always exists as a file
    if (p === "/index.md" && !isFile && !isDir) {
      return {
        isFile: true, isDirectory: false, isSymbolicLink: false,
        mode: 0o644, size: 0, mtime: new Date(),
      };
    }
    if (!isFile && !isDir) throw fsErr("ENOENT", "no such file or directory", p);
    const m = this.meta.get(p);
    return {
      isFile: isFile && !isDir,
      isDirectory: isDir,
      isSymbolicLink: false,
      mode: isDir ? 0o755 : 0o644,
      size: m?.size ?? 0,
      mtime: m?.mtime ?? new Date(),
    };
  }

  async lstat(path: string): Promise<FsStat> { return this.stat(path); }

  async chmod(_path: string, _mode: number): Promise<void> {}
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {}
  async symlink(_target: string, linkPath: string): Promise<void> { throw fsErr("EPERM", "operation not permitted", linkPath); }
  async link(_src: string, destPath: string): Promise<void> { throw fsErr("EPERM", "operation not permitted", destPath); }
  async readlink(path: string): Promise<string> { throw fsErr("EINVAL", "invalid argument", path); }
  async realpath(path: string): Promise<string> {
    const p = normPath(path);
    if (p === "/index.md") return p; // Virtual index always exists
    if (!this.files.has(p) && !this.dirs.has(p)) throw fsErr("ENOENT", "no such file or directory", p);
    return p;
  }

  // ── IFileSystem: directories ──────────────────────────────────────────────

  async mkdir(path: string, opts?: MkdirOptions): Promise<void> {
    const p = normPath(path);
    if (this.files.has(p)) throw fsErr("EEXIST", "file exists", p);
    if (this.dirs.has(p)) {
      if (!opts?.recursive) throw fsErr("EEXIST", "file exists", p);
      return;
    }
    if (!opts?.recursive) {
      const parent = parentOf(p);
      if (!this.dirs.has(parent)) throw fsErr("ENOENT", "no such file or directory", parent);
    }
    this.dirs.set(p, new Set());
    const parent = parentOf(p);
    if (!this.dirs.has(parent)) this.dirs.set(parent, new Set());
    this.dirs.get(parent)!.add(basename(p));
  }

  async readdir(path: string): Promise<string[]> {
    const p = normPath(path);
    if (!this.dirs.has(p)) throw fsErr("ENOTDIR", "not a directory", p);
    const entries = [...(this.dirs.get(p) ?? [])];
    // Virtual index.md: always show in root listing even if no real row exists
    if (p === "/" && !entries.includes("index.md")) {
      entries.push("index.md");
    }
    return entries;
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const names = await this.readdir(path);
    const p = normPath(path);
    return names.map(name => {
      const child = p === "/" ? `/${name}` : `${p}/${name}`;
      return {
        name,
        isFile: (this.files.has(child) || child === "/index.md") && !this.dirs.has(child),
        isDirectory: this.dirs.has(child),
        isSymbolicLink: false,
      };
    });
  }

  // ── IFileSystem: structural mutations ─────────────────────────────────────

  async rm(path: string, opts?: RmOptions): Promise<void> {
    const p = normPath(path);
    if (!this.files.has(p) && !this.dirs.has(p)) {
      if (opts?.force) return;
      throw fsErr("ENOENT", "no such file or directory", p);
    }

    if (this.dirs.has(p)) {
      const children = this.dirs.get(p) ?? new Set();
      if (children.size > 0 && !opts?.recursive) throw fsErr("ENOTEMPTY", "directory not empty", p);

      // Collect all descendant files before mutating state
      const toDelete: string[] = [];
      const stack = [p];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const child of [...(this.dirs.get(cur) ?? [])]) {
          const childPath = cur === "/" ? `/${child}` : `${cur}/${child}`;
          if (this.files.has(childPath)) toDelete.push(childPath);
          if (this.dirs.has(childPath))  stack.push(childPath);
        }
      }
      for (const fp of toDelete) this.removeFromTree(fp);
      this.dirs.delete(p);
      this.dirs.get(parentOf(p))?.delete(basename(p));

      if (toDelete.length > 0) {
        const inList = toDelete.map(fp => `'${esc(fp)}'`).join(", ");
        await this.client.query(`DELETE FROM "${this.table}" WHERE path IN (${inList})`);
      }
    } else {
      await this.client.query(`DELETE FROM "${this.table}" WHERE path = '${esc(p)}'`);
      this.removeFromTree(p);
    }
  }

  async cp(src: string, dest: string, opts?: CpOptions): Promise<void> {
    const s = normPath(src), d = normPath(dest);
    if (this.dirs.has(s) && !this.files.has(s)) {
      if (!opts?.recursive) throw fsErr("EISDIR", "is a directory", s);
      for (const fp of [...this.files.keys()].filter(k => k === s || k.startsWith(s + "/"))) {
        await this.writeFile(d + fp.slice(s.length), await this.readFileBuffer(fp));
      }
    } else {
      await this.writeFile(d, await this.readFileBuffer(s));
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: true });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normPath(path);
    return normPath(posix.join(base, path));
  }

  getAllPaths(): string[] {
    return [...new Set([...this.files.keys(), ...this.dirs.keys()])];
  }
}
