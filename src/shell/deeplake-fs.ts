import { basename, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DeeplakeApi } from "../deeplake-api.js";
import type {
  IFileSystem, FsStat, MkdirOptions, RmOptions, CpOptions,
  FileContent, BufferEncoding,
} from "just-bash";
import { normalizeContent } from "./grep-core.js";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingSqlLiteral } from "../embeddings/sql.js";

interface ReadFileOptions { encoding?: BufferEncoding }
interface WriteFileOptions { encoding?: BufferEncoding }
interface DirentEntry { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

// ── constants ─────────────────────────────────────────────────────────────────
const BATCH_SIZE = 10;
const PREFETCH_BATCH_SIZE = 50;
const FLUSH_DEBOUNCE_MS = 200;

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

export function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (
    ({
      json: "application/json", md: "text/markdown", txt: "text/plain",
      js: "text/javascript", ts: "text/typescript", html: "text/html",
      css: "text/css",
    } as Record<string, string>)[ext] ?? "text/plain"
  );
}

function normalizeSessionMessage(path: string, message: unknown): string {
  const raw = typeof message === "string" ? message : JSON.stringify(message);
  return normalizeContent(path, raw);
}

function resolveEmbedDaemonPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
}

function joinSessionMessages(path: string, messages: unknown[]): string {
  return messages.map((message) => normalizeSessionMessage(path, message)).join("\n");
}

function fsErr(code: string, msg: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${msg}, '${path}'`), { code });
}

// ── types ─────────────────────────────────────────────────────────────────────
interface FileMeta { size: number; mime: string; mtime: Date; }

interface PendingRow {
  path: string; filename: string;
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

  // Embedding client lazily created on first flush. Lives as long as the process.
  private embedClient: EmbedClient | null = null;

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

    // Bootstrap memory + sessions metadata in parallel.
    let sessionSyncOk = true;
    const memoryBootstrap = (async () => {
      const sql = `SELECT path, size_bytes, mime_type FROM "${table}" ORDER BY path`;
      try {
        const rows = await client.query(sql);
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
    })();

    const sessionsBootstrap = (sessionsTable && sessionSyncOk) ? (async () => {
      try {
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
    })() : Promise.resolve();

    await Promise.all([memoryBootstrap, sessionsBootstrap]);

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

    const embeddings = await this.computeEmbeddings(rows);

    // Upsert in parallel — the semaphore in DeeplakeApi.query() handles concurrency.
    // Re-queue any rows that failed so they are retried on the next flush.
    const results = await Promise.allSettled(rows.map((r, i) => this.upsertRow(r, embeddings[i])));
    let failures = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        // Re-queue for next flush — don't overwrite if the caller wrote a newer version
        if (!this.pending.has(rows[i].path)) {
          this.pending.set(rows[i].path, rows[i]);
        }
        failures++;
      }
    }
    if (failures > 0) {
      throw new Error(`flush: ${failures}/${rows.length} writes failed and were re-queued`);
    }
  }

  private async computeEmbeddings(rows: PendingRow[]): Promise<(number[] | null)[]> {
    if (rows.length === 0) return [];
    if (!this.embedClient) {
      this.embedClient = new EmbedClient({ daemonEntry: resolveEmbedDaemonPath() });
    }
    // One request per row over the same daemon — daemon batches internally if
    // ONNX is configured to do so. We fire in parallel; the Unix socket + daemon
    // queue handles ordering. null entries are silently stored as empty.
    return Promise.all(rows.map(r => this.embedClient!.embed(r.contentText, "document")));
  }

  private async upsertRow(r: PendingRow, embedding: number[] | null): Promise<void> {
    const text  = esc(r.contentText);
    const p     = esc(r.path);
    const fname = esc(r.filename);
    const mime  = esc(r.mimeType);
    const ts = new Date().toISOString();
    const cd = r.creationDate ?? ts;
    const lud = r.lastUpdateDate ?? ts;
    const embSql = embeddingSqlLiteral(embedding);
    if (this.flushed.has(r.path)) {
      let setClauses = `filename = '${fname}', summary = E'${text}', summary_embedding = ${embSql}, ` +
        `mime_type = '${mime}', size_bytes = ${r.sizeBytes}, last_update_date = '${esc(lud)}'`;
      if (r.project !== undefined) setClauses += `, project = '${esc(r.project)}'`;
      if (r.description !== undefined) setClauses += `, description = '${esc(r.description)}'`;
      await this.client.query(
        `UPDATE "${this.table}" SET ${setClauses} WHERE path = '${p}'`
      );
    } else {
      const id = randomUUID();
      const cols = "id, path, filename, summary, summary_embedding, mime_type, size_bytes, creation_date, last_update_date" +
        (r.project !== undefined ? ", project" : "") +
        (r.description !== undefined ? ", description" : "");
      const vals = `'${id}', '${p}', '${fname}', E'${text}', ${embSql}, '${mime}', ${r.sizeBytes}, '${esc(cd)}', '${esc(lud)}'` +
        (r.project !== undefined ? `, '${esc(r.project)}'` : "") +
        (r.description !== undefined ? `, '${esc(r.description)}'` : "");
      await this.client.query(
        `INSERT INTO "${this.table}" (${cols}) VALUES (${vals})`
      );
      this.flushed.add(r.path);
    }
  }

  // ── Virtual index.md generation ────────────────────────────────────────────

  private async generateVirtualIndex(): Promise<string> {
    // Memory (summaries) section — high-level wikipage per session.
    const summaryRows = await this.client.query(
      `SELECT path, project, description, creation_date, last_update_date FROM "${this.table}" ` +
      `WHERE path LIKE '${esc("/summaries/")}%' ORDER BY last_update_date DESC`
    );

    // Sessions section — raw session records (dialogue / events). Pulled
    // directly from the sessions table so the index is never empty just
    // because memory has no summaries yet.
    let sessionRows: Record<string, unknown>[] = [];
    if (this.sessionsTable) {
      try {
        sessionRows = await this.client.query(
          `SELECT path, MAX(description) AS description, MIN(creation_date) AS creation_date, MAX(last_update_date) AS last_update_date ` +
          `FROM "${this.sessionsTable}" WHERE path LIKE '${esc("/sessions/")}%' ` +
          `GROUP BY path ORDER BY path`
        );
      } catch {
        // sessions table absent or schema mismatch — leave empty, emit memory-only index.
        sessionRows = [];
      }
    }

    const lines: string[] = [
      "# Session Index",
      "",
      "Two sources are available. Consult the section relevant to the question.",
      "",
    ];

    // ── ## memory ────────────────────────────────────────────────────────────
    lines.push("## memory");
    lines.push("");
    if (summaryRows.length === 0) {
      lines.push("_(empty — no summaries ingested yet)_");
    } else {
      lines.push("AI-generated summaries per session. Read these first for topic-level overviews.");
      lines.push("");
      lines.push("| Session | Created | Last Updated | Project | Description |");
      lines.push("|---------|---------|--------------|---------|-------------|");
      for (const row of summaryRows) {
        const p = row["path"] as string;
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
    }
    lines.push("");

    // ── ## sessions ─────────────────────────────────────────────────────────
    lines.push("## sessions");
    lines.push("");
    if (sessionRows.length === 0) {
      lines.push("_(empty — no session records ingested yet)_");
    } else {
      lines.push("Raw session records (dialogue, tool calls). Read for exact detail / quotes.");
      lines.push("");
      lines.push("| Session | Created | Last Updated | Description |");
      lines.push("|---------|---------|--------------|-------------|");
      for (const row of sessionRows) {
        const p = (row["path"] as string) || "";
        // Show the path relative to /sessions/ so the table stays compact.
        const rel = p.startsWith("/") ? p.slice(1) : p;
        const filename = p.split("/").pop() ?? p;
        const description = (row["description"] as string) || "";
        const creationDate = (row["creation_date"] as string) || "";
        const lastUpdateDate = (row["last_update_date"] as string) || "";
        lines.push(`| [${filename}](${rel}) | ${creationDate} | ${lastUpdateDate} | ${description} |`);
      }
    }
    lines.push("");

    return lines.join("\n");
  }

  // ── batch prefetch ────────────────────────────────────────────────────────

  /**
   * Prefetch multiple files into the content cache with a single SQL query.
   * Skips paths that are already cached, pending, or session-backed.
   * After this call, subsequent readFile() calls for these paths hit cache.
   */
  async prefetch(paths: string[]): Promise<void> {
    const uncached: string[] = [];
    const uncachedSessions: string[] = [];
    for (const raw of paths) {
      const p = normPath(raw);
      if (this.files.get(p) !== null && this.files.get(p) !== undefined) continue;
      if (this.pending.has(p)) continue;
      if (!this.files.has(p)) continue; // unknown path
      if (this.sessionPaths.has(p)) {
        uncachedSessions.push(p);
      } else {
        uncached.push(p);
      }
    }

    for (let i = 0; i < uncached.length; i += PREFETCH_BATCH_SIZE) {
      const chunk = uncached.slice(i, i + PREFETCH_BATCH_SIZE);
      const inList = chunk.map(p => `'${esc(p)}'`).join(", ");
      const rows = await this.client.query(
        `SELECT path, summary FROM "${this.table}" WHERE path IN (${inList})`
      );
      for (const row of rows) {
        const p = row["path"] as string;
        const text = (row["summary"] as string) ?? "";
        this.files.set(p, Buffer.from(text, "utf-8"));
      }
    }

    if (!this.sessionsTable) return;

    for (let i = 0; i < uncachedSessions.length; i += PREFETCH_BATCH_SIZE) {
      const chunk = uncachedSessions.slice(i, i + PREFETCH_BATCH_SIZE);
      const inList = chunk.map(p => `'${esc(p)}'`).join(", ");
      const rows = await this.client.query(
        `SELECT path, message, creation_date FROM "${this.sessionsTable}" WHERE path IN (${inList}) ORDER BY path, creation_date ASC`
      );
      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        const p = row["path"] as string;
        const current = grouped.get(p) ?? [];
        current.push(normalizeSessionMessage(p, row["message"]));
        grouped.set(p, current);
      }
      for (const [p, parts] of grouped) {
        this.files.set(p, Buffer.from(parts.join("\n"), "utf-8"));
      }
    }
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
    if (pend) { const buf = Buffer.from(pend.contentText, "utf-8"); this.files.set(p, buf); return buf; }

    // 3. Session files: concatenate rows from sessions table
    if (this.sessionPaths.has(p) && this.sessionsTable) {
      const rows = await this.client.query(
        `SELECT message FROM "${this.sessionsTable}" WHERE path = '${esc(p)}' ORDER BY creation_date ASC`
      );
      if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
      const text = joinSessionMessages(p, rows.map((row) => row["message"]));
      const buf = Buffer.from(text, "utf-8");
      this.files.set(p, buf);
      return buf;
    }

    // 4. SQL query — summary column (text content)
    const rows = await this.client.query(
      `SELECT summary FROM "${this.table}" WHERE path = '${esc(p)}' LIMIT 1`
    );
    if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
    const buf = Buffer.from((rows[0]["summary"] as string) ?? "", "utf-8");
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

    // Content cache (populated by prefetch or prior reads)
    const cached = this.files.get(p);
    if (cached !== null && cached !== undefined) return cached.toString("utf-8");

    // Pending batch
    const pend = this.pending.get(p);
    if (pend) return pend.contentText;

    // Session files: concatenate rows from sessions table, ordered by creation_date
    if (this.sessionPaths.has(p) && this.sessionsTable) {
      const rows = await this.client.query(
        `SELECT message FROM "${this.sessionsTable}" WHERE path = '${esc(p)}' ORDER BY creation_date ASC`
      );
      if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
      const text = joinSessionMessages(p, rows.map((row) => row["message"]));
      const buf = Buffer.from(text, "utf-8");
      this.files.set(p, buf);
      return text;
    }

    const rows = await this.client.query(
      `SELECT summary FROM "${this.table}" WHERE path = '${esc(p)}' LIMIT 1`
    );
    if (rows.length === 0) throw fsErr("ENOENT", "no such file or directory", p);
    const text = (rows[0]["summary"] as string) ?? "";
    const buf = Buffer.from(text, "utf-8");
    this.files.set(p, buf);
    return text;
  }

  // ── IFileSystem: writes ───────────────────────────────────────────────────

  /** Write a file with optional row-level metadata (project, description, dates). */
  async writeFileWithMeta(
    path: string, content: FileContent,
    meta: { project?: string; description?: string; creationDate?: string; lastUpdateDate?: string },
  ): Promise<void> {
    const p = normPath(path);
    if (this.sessionPaths.has(p)) throw fsErr("EPERM", "session files are read-only", p);
    if (this.dirs.has(p) && !this.files.has(p)) throw fsErr("EISDIR", "illegal operation on a directory", p);

    const text = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
    const buf = Buffer.from(text, "utf-8");
    const mime = guessMime(basename(p));

    this.files.set(p, buf);
    this.meta.set(p, { size: buf.length, mime, mtime: new Date() });
    this.addToTree(p);

    this.pending.set(p, {
      path: p, filename: basename(p),
      contentText: text, mimeType: mime, sizeBytes: buf.length,
      ...meta,
    });

    if (this.pending.size >= BATCH_SIZE) await this.flush();
    else this.scheduleFlush();
  }

  async writeFile(path: string, content: FileContent, _opts?: WriteFileOptions | BufferEncoding): Promise<void> {
    const p = normPath(path);
    if (this.sessionPaths.has(p)) throw fsErr("EPERM", "session files are read-only", p);
    if (this.dirs.has(p) && !this.files.has(p)) throw fsErr("EISDIR", "illegal operation on a directory", p);

    const text = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
    const buf = Buffer.from(text, "utf-8");
    const mime = guessMime(basename(p));

    this.files.set(p, buf);
    this.meta.set(p, { size: buf.length, mime, mtime: new Date() });
    this.addToTree(p);

    this.pending.set(p, {
      path: p, filename: basename(p),
      contentText: text, mimeType: mime, sizeBytes: buf.length,
    });

    if (this.pending.size >= BATCH_SIZE) await this.flush();
    else this.scheduleFlush();
  }

  async appendFile(path: string, content: FileContent, opts?: WriteFileOptions | BufferEncoding): Promise<void> {
    const p = normPath(path);
    const add = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");

    // Session files are read-only (multi-row in sessions table, not memory table)
    if (this.sessionPaths.has(p)) throw fsErr("EPERM", "session files are read-only", p);

    // Fast path: SQL-level concat — no read-back, O(1) per append
    if (this.files.has(p) || await this.exists(p).catch(() => false)) {
      const ts = new Date().toISOString();
      await this.client.query(
        `UPDATE "${this.table}" SET ` +
        `summary = summary || E'${esc(add)}', ` +
        `size_bytes = size_bytes + ${Buffer.byteLength(add, "utf-8")}, ` +
        `last_update_date = '${ts}' ` +
        `WHERE path = '${esc(p)}'`
      );
      // Invalidate content cache so next read fetches fresh data from SQL
      this.files.set(p, null);
      const m = this.meta.get(p);
      if (m) { m.size += Buffer.byteLength(add, "utf-8"); m.mtime = new Date(ts); }
    } else {
      // File doesn't exist yet — create it
      await this.writeFile(p, content, opts);
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
    if (this.sessionPaths.has(p)) throw fsErr("EPERM", "session files are read-only", p);
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
      // Filter out session paths — they are read-only
      const safeToDelete = toDelete.filter(fp => !this.sessionPaths.has(fp));
      for (const fp of safeToDelete) this.removeFromTree(fp);
      this.dirs.delete(p);
      this.dirs.get(parentOf(p))?.delete(basename(p));

      if (safeToDelete.length > 0) {
        const inList = safeToDelete.map(fp => `'${esc(fp)}'`).join(", ");
        await this.client.query(`DELETE FROM "${this.table}" WHERE path IN (${inList})`);
      }
    } else {
      await this.client.query(`DELETE FROM "${this.table}" WHERE path = '${esc(p)}'`);
      this.removeFromTree(p);
    }
  }

  async cp(src: string, dest: string, opts?: CpOptions): Promise<void> {
    const s = normPath(src), d = normPath(dest);
    if (this.sessionPaths.has(d)) throw fsErr("EPERM", "session files are read-only", d);
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
    const s = normPath(src), d = normPath(dest);
    if (this.sessionPaths.has(s)) throw fsErr("EPERM", "session files are read-only", s);
    if (this.sessionPaths.has(d)) throw fsErr("EPERM", "session files are read-only", d);
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
