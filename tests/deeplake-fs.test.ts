import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeeplakeFS, isText, guessMime } from "../src/shell/deeplake-fs.js";

// ── Mock ManagedClient ────────────────────────────────────────────────────────
type Row = {
  path: string; filename: string; content: Buffer;
  content_text: string; mime_type: string; size_bytes: number;
};

function makeClient(seed: Record<string, Buffer> = {}) {
  const rows: Row[] = Object.entries(seed).map(([path, content]) => ({
    path,
    filename: path.split("/").pop()!,
    content,
    content_text: isText(content) ? content.toString("utf-8") : "",
    mime_type: guessMime(path.split("/").pop()!),
    size_bytes: content.length,
  }));

  const client = {
    applyStorageCreds: vi.fn().mockResolvedValue(undefined),

    query: vi.fn().mockImplementation(async (sql: string) => {
      // Bootstrap: SELECT path, size_bytes, mime_type
      if (sql.includes("SELECT path, size_bytes, mime_type")) {
        return rows.map(r => ({ path: r.path, size_bytes: r.size_bytes, mime_type: r.mime_type }));
      }
      // Read: SELECT content FROM ... WHERE path = '...'
      if (sql.includes("SELECT content FROM")) {
        const match = sql.match(/path = '([^']+)'/);
        const row = match ? rows.find(r => r.path === match[1]) : undefined;
        // Return hex-encoded content like PostgreSQL BYTEA
        return row ? [{ content: `\\x${row.content.toString("hex")}` }] : [];
      }
      // Read: SELECT content_text, content FROM ... WHERE path = '...'
      if (sql.includes("SELECT content_text, content")) {
        const match = sql.match(/path = '([^']+)'/);
        const row = match ? rows.find(r => r.path === match[1]) : undefined;
        return row ? [{ content_text: row.content_text, content: `\\x${row.content.toString("hex")}` }] : [];
      }
      // BM25 / ILIKE for grep
      if (sql.includes("<#>") || sql.includes("LIKE")) {
        return [];
      }
      // DELETE WHERE path = '...'
      if (sql.match(/DELETE.*WHERE path = '([^']+)'/)) {
        const match = sql.match(/path = '([^']+)'/);
        if (match) {
          const idx = rows.findIndex(r => r.path === match[1]);
          if (idx >= 0) rows.splice(idx, 1);
        }
        return [];
      }
      // DELETE WHERE path IN (...)
      if (sql.includes("DELETE") && sql.includes("IN (")) {
        const match = sql.match(/IN \(([^)]+)\)/);
        if (match) {
          const paths = match[1].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
          for (const p of paths) {
            const idx = rows.findIndex(r => r.path === p);
            if (idx >= 0) rows.splice(idx, 1);
          }
        }
        return [];
      }
      // INSERT
      if (sql.startsWith("INSERT")) {
        const pathMatch = sql.match(/VALUES \('([^']+)'/);
        const filenameMatch = sql.match(/VALUES \('[^']+', '([^']+)'/);
        const hexMatch = sql.match(/E'\\\\x([0-9a-f]*)'/);
        const textMatch = sql.match(/E'\\\\x[0-9a-f]*', E'((?:[^']|'')*)'/);
        const mimeMatch = sql.match(/E'((?:[^']|'')*)', (\d+)\)$/);
        if (pathMatch) {
          const path = pathMatch[1];
          const filename = filenameMatch?.[1] ?? path.split("/").pop()!;
          const content = hexMatch ? Buffer.from(hexMatch[1], "hex") : Buffer.alloc(0);
          const content_text = textMatch?.[1]?.replace(/''/g, "'") ?? "";
          rows.push({ path, filename, content, content_text, mime_type: "text/plain", size_bytes: content.length });
        }
        return [];
      }
      return [];
    }),

    // Expose internal rows for test assertions
    _rows: rows,
  };

  return client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function makeFs(seed: Record<string, string | Buffer> = {}) {
  const bufSeed: Record<string, Buffer> = {};
  for (const [k, v] of Object.entries(seed)) {
    bufSeed[k] = typeof v === "string" ? Buffer.from(v, "utf-8") : v;
  }
  const client = makeClient(bufSeed);
  const fs = await DeeplakeFS.create(client as never, "test", "/memory");
  return { fs, client };
}

// ── Unit: helpers ─────────────────────────────────────────────────────────────
describe("isText", () => {
  it("returns true for plain UTF-8", () => {
    expect(isText(Buffer.from("hello world"))).toBe(true);
  });
  it("returns false for buffer containing null byte", () => {
    expect(isText(Buffer.from([0x68, 0x00, 0x6c]))).toBe(false);
  });
  it("returns false for buffer with null byte (binary marker)", () => {
    // Real binary files (PNG body, PDFs, zips) contain null bytes
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]);
    expect(isText(binary)).toBe(false);
  });
});

describe("guessMime", () => {
  it("returns application/json for .json", () => expect(guessMime("foo.json")).toBe("application/json"));
  it("returns image/png for .png",         () => expect(guessMime("image.png")).toBe("image/png"));
  it("returns octet-stream for .bin",      () => expect(guessMime("file.bin")).toBe("application/octet-stream"));
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
describe("DeeplakeFS bootstrap", () => {
  it("populates files and dirs from getColumnData", async () => {
    const { fs } = await makeFs({ "/memory/notes.txt": "hello" });
    expect(await fs.exists("/memory/notes.txt")).toBe(true);
    expect(await fs.exists("/memory")).toBe(true);
  });

  it("handles empty table gracefully", async () => {
    const { fs } = await makeFs({});
    expect(await fs.exists("/memory")).toBe(true);
    expect(await fs.readdir("/memory")).toEqual([]);
  });

  it("builds nested dir tree", async () => {
    const { fs } = await makeFs({
      "/memory/a/b/c.txt": "deep",
      "/memory/a/d.txt": "shallow",
    });
    expect(await fs.exists("/memory/a")).toBe(true);
    expect(await fs.exists("/memory/a/b")).toBe(true);
    const top = await fs.readdir("/memory");
    expect(top).toContain("a");
    const mid = await fs.readdir("/memory/a");
    expect(mid).toContain("b");
    expect(mid).toContain("d.txt");
  });
});

// ── Text reads ────────────────────────────────────────────────────────────────
describe("readFile", () => {
  it("reads text via content_text SQL column", async () => {
    const { fs, client } = await makeFs({ "/memory/hello.txt": "hello" });
    const content = await fs.readFile("/memory/hello.txt");
    expect(content).toBe("hello");
    // Should use the content_text+content SELECT, not content-only SELECT
    const calls = (client.query.mock.calls as [string][]);
    expect(calls.some(c => (c[0] as string).includes("content_text, content"))).toBe(true);
  });

  it("throws ENOENT for missing file", async () => {
    const { fs } = await makeFs({});
    await expect(fs.readFile("/memory/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws EISDIR when reading a directory", async () => {
    const { fs } = await makeFs({ "/memory/sub/file.txt": "x" });
    await expect(fs.readFile("/memory/sub")).rejects.toMatchObject({ code: "EISDIR" });
  });
});

// ── Binary reads ──────────────────────────────────────────────────────────────
describe("readFileBuffer", () => {
  it("roundtrips binary content exactly", async () => {
    // PNG-like: has null bytes → binary
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    const { fs } = await makeFs({ "/memory/img.png": binary });

    const result = await fs.readFileBuffer("/memory/img.png");
    expect(Buffer.from(result)).toEqual(binary);
  });

  it("reads via SQL SELECT content query", async () => {
    const { fs, client } = await makeFs({ "/memory/data.bin": Buffer.from([1, 2, 3]) });
    await fs.readFileBuffer("/memory/data.bin");
    const selectCalls = (client.query.mock.calls as [string][]).filter(c =>
      (c[0] as string).includes("SELECT content FROM")
    );
    expect(selectCalls.length).toBeGreaterThan(0);
  });

  it("throws ENOENT for missing file", async () => {
    const { fs } = await makeFs({});
    await expect(fs.readFileBuffer("/memory/nope.bin")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ── Writes ────────────────────────────────────────────────────────────────────
describe("writeFile", () => {
  it("is immediately readable before flush", async () => {
    const { fs } = await makeFs({});
    await fs.writeFile("/memory/new.txt", "world");
    const content = await fs.readFile("/memory/new.txt");
    expect(content).toBe("world");
  });

  it("adds file to dir listing immediately", async () => {
    const { fs } = await makeFs({});
    await fs.writeFile("/memory/sub/file.txt", "x");
    expect(await fs.exists("/memory/sub")).toBe(true);
    expect(await fs.readdir("/memory/sub")).toContain("file.txt");
  });

  it("batches and flushes on BATCH_SIZE writes (DELETE+INSERT per row)", async () => {
    const { fs, client } = await makeFs({});
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(fs.writeFile(`/memory/file${i}.txt`, `content ${i}`));
    }
    await Promise.all(promises);
    // 10 rows × 2 SQL calls (DELETE + INSERT) = 20 calls minimum
    // Plus 1 bootstrap SELECT = 21 total, but bootstrap is during create()
    const insertCalls = (client.query.mock.calls as [string][]).filter(c => (c[0] as string).startsWith("INSERT"));
    expect(insertCalls.length).toBe(10);
  });

  it("overwrites existing file", async () => {
    const { fs } = await makeFs({ "/memory/a.txt": "old" });
    await fs.writeFile("/memory/a.txt", "new");
    expect(await fs.readFile("/memory/a.txt")).toBe("new");
  });

  it("stores contentText='' for binary files (INSERT has empty E'' for content_text)", async () => {
    const { fs, client } = await makeFs({});
    const binary = Buffer.from([0x89, 0x50, 0x00, 0x01]);
    // Write 10 to trigger flush
    for (let i = 0; i < 9; i++) await fs.writeFile(`/memory/dummy${i}.txt`, "x");
    await fs.writeFile("/memory/img.png", binary);

    const insertCalls = (client.query.mock.calls as [string][])
      .filter(c => (c[0] as string).startsWith("INSERT") && (c[0] as string).includes("img.png"));
    expect(insertCalls.length).toBe(1);
    // content_text should be E'' (empty string) for binary
    expect(insertCalls[0][0]).toMatch(/E'\\\\x[0-9a-f]+', E''/);
  });
});

// ── appendFile ────────────────────────────────────────────────────────────────
describe("appendFile", () => {
  it("appends to existing file", async () => {
    const { fs } = await makeFs({ "/memory/log.txt": "line1\n" });
    await fs.appendFile("/memory/log.txt", "line2\n");
    expect(await fs.readFile("/memory/log.txt")).toBe("line1\nline2\n");
  });

  it("creates file if it does not exist", async () => {
    const { fs } = await makeFs({});
    await fs.appendFile("/memory/new.txt", "hello");
    expect(await fs.readFile("/memory/new.txt")).toBe("hello");
  });
});

// ── Directories ───────────────────────────────────────────────────────────────
describe("mkdir", () => {
  it("creates directory in parent listing", async () => {
    const { fs } = await makeFs({});
    await fs.mkdir("/memory/docs");
    expect(await fs.exists("/memory/docs")).toBe(true);
    expect(await fs.readdir("/memory")).toContain("docs");
  });

  it("throws ENOENT if parent missing and not recursive", async () => {
    const { fs } = await makeFs({});
    await expect(fs.mkdir("/memory/a/b")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates full path with recursive", async () => {
    const { fs } = await makeFs({});
    await fs.mkdir("/memory/a/b/c", { recursive: true });
    expect(await fs.exists("/memory/a/b/c")).toBe(true);
  });

  it("is idempotent with recursive flag", async () => {
    const { fs } = await makeFs({});
    await fs.mkdir("/memory/docs", { recursive: true });
    await expect(fs.mkdir("/memory/docs", { recursive: true })).resolves.toBeUndefined();
  });
});

describe("readdir", () => {
  it("lists immediate children only", async () => {
    const { fs } = await makeFs({
      "/memory/a.txt": "a",
      "/memory/sub/b.txt": "b",
    });
    const entries = await fs.readdir("/memory");
    expect(entries).toContain("a.txt");
    expect(entries).toContain("sub");
    expect(entries).not.toContain("b.txt");
  });

  it("throws ENOTDIR for a file", async () => {
    const { fs } = await makeFs({ "/memory/file.txt": "x" });
    await expect(fs.readdir("/memory/file.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

// ── stat ──────────────────────────────────────────────────────────────────────
describe("stat", () => {
  it("returns isFile=true for a file", async () => {
    const { fs } = await makeFs({ "/memory/file.txt": "x" });
    const s = await fs.stat("/memory/file.txt");
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
  });

  it("returns isDirectory=true for a dir", async () => {
    const { fs } = await makeFs({ "/memory/sub/x.txt": "x" });
    const s = await fs.stat("/memory/sub");
    expect(s.isDirectory).toBe(true);
    expect(s.isFile).toBe(false);
  });

  it("throws ENOENT for missing path", async () => {
    const { fs } = await makeFs({});
    await expect(fs.stat("/memory/ghost")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ── rm ────────────────────────────────────────────────────────────────────────
describe("rm", () => {
  it("removes a file and issues DELETE query", async () => {
    const { fs, client } = await makeFs({ "/memory/del.txt": "bye" });
    await fs.rm("/memory/del.txt");
    expect(await fs.exists("/memory/del.txt")).toBe(false);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("DELETE"));
  });

  it("removes file from parent dir listing", async () => {
    const { fs } = await makeFs({ "/memory/del.txt": "bye", "/memory/keep.txt": "stay" });
    await fs.rm("/memory/del.txt");
    const entries = await fs.readdir("/memory");
    expect(entries).not.toContain("del.txt");
    expect(entries).toContain("keep.txt");
  });

  it("throws ENOTEMPTY on non-empty dir without recursive", async () => {
    const { fs } = await makeFs({ "/memory/sub/file.txt": "x" });
    await expect(fs.rm("/memory/sub")).rejects.toMatchObject({ code: "ENOTEMPTY" });
  });

  it("recursively removes dir and all descendants", async () => {
    const { fs, client } = await makeFs({
      "/memory/sub/a.txt": "a",
      "/memory/sub/b.txt": "b",
    });
    await fs.rm("/memory/sub", { recursive: true });
    expect(await fs.exists("/memory/sub")).toBe(false);
    expect(await fs.exists("/memory/sub/a.txt")).toBe(false);
    // One batch DELETE IN (...)
    const deleteCalls = (client.query.mock.calls as string[][]).filter(c =>
      (c[0] as string).includes("DELETE")
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toContain("IN");
  });

  it("force option suppresses ENOENT on missing path", async () => {
    const { fs } = await makeFs({});
    await expect(fs.rm("/memory/nope.txt", { force: true })).resolves.toBeUndefined();
  });
});

// ── cp / mv ───────────────────────────────────────────────────────────────────
describe("cp", () => {
  it("copies a file to a new path", async () => {
    const { fs } = await makeFs({ "/memory/src.txt": "copy me" });
    await fs.cp("/memory/src.txt", "/memory/dst.txt");
    expect(await fs.readFile("/memory/dst.txt")).toBe("copy me");
    expect(await fs.readFile("/memory/src.txt")).toBe("copy me");
  });

  it("throws EISDIR on dir without recursive", async () => {
    const { fs } = await makeFs({ "/memory/sub/file.txt": "x" });
    await expect(fs.cp("/memory/sub", "/memory/sub2")).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("mv", () => {
  it("moves file: available at dest, gone at src", async () => {
    const { fs } = await makeFs({ "/memory/old.txt": "move me" });
    await fs.mv("/memory/old.txt", "/memory/new.txt");
    expect(await fs.exists("/memory/new.txt")).toBe(true);
    expect(await fs.readFile("/memory/new.txt")).toBe("move me");
    expect(await fs.exists("/memory/old.txt")).toBe(false);
  });
});

// ── path resolution ───────────────────────────────────────────────────────────
describe("resolvePath", () => {
  it("resolves relative path against base", async () => {
    const { fs } = await makeFs({});
    expect(fs.resolvePath("/memory", "notes.txt")).toBe("/memory/notes.txt");
  });

  it("keeps absolute path unchanged", async () => {
    const { fs } = await makeFs({});
    expect(fs.resolvePath("/memory", "/other/path")).toBe("/other/path");
  });
});

describe("getAllPaths", () => {
  it("includes both files and dirs", async () => {
    const { fs } = await makeFs({ "/memory/sub/file.txt": "x" });
    const paths = fs.getAllPaths();
    expect(paths).toContain("/memory/sub/file.txt");
    expect(paths).toContain("/memory/sub");
    expect(paths).toContain("/memory");
  });
});

// ── no-op / unsupported ops ───────────────────────────────────────────────────
describe("unsupported ops", () => {
  it("chmod resolves without error", async () => {
    const { fs } = await makeFs({});
    await expect(fs.chmod("/memory", 0o755)).resolves.toBeUndefined();
  });

  it("symlink throws EPERM", async () => {
    const { fs } = await makeFs({});
    await expect(fs.symlink("/memory/a", "/memory/b")).rejects.toMatchObject({ code: "EPERM" });
  });

  it("readlink throws EINVAL", async () => {
    const { fs } = await makeFs({});
    await expect(fs.readlink("/memory/a")).rejects.toMatchObject({ code: "EINVAL" });
  });
});
