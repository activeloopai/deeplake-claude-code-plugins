import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeeplakeFs, guessMime } from "../../src/shell/deeplake-fs.js";

// ── Mock ManagedClient ────────────────────────────────────────────────────────
type Row = {
  id: string; path: string; filename: string;
  summary: string; mime_type: string; size_bytes: number;
  project: string; description: string; creation_date: string; last_update_date: string;
};

function makeClient(seed: Record<string, Buffer> = {}) {
  const rows: Row[] = Object.entries(seed).map(([path, content]) => ({
    id: `seed-${path}`,
    path,
    filename: path.split("/").pop()!,
    summary: content.toString("utf-8"),
    mime_type: guessMime(path.split("/").pop()!),
    size_bytes: content.length,
    project: "",
    description: "",
    creation_date: "",
    last_update_date: "",
  }));

  const client = {
    applyStorageCreds: vi.fn().mockResolvedValue(undefined),

    query: vi.fn().mockImplementation(async (sql: string) => {
      // Bootstrap: SELECT path, size_bytes, mime_type
      if (sql.includes("SELECT path, size_bytes, mime_type")) {
        return rows.map(r => ({ path: r.path, size_bytes: r.size_bytes, mime_type: r.mime_type }));
      }
      // Read: SELECT summary FROM ... WHERE path = '...'
      if (sql.includes("SELECT summary FROM")) {
        const match = sql.match(/path = '([^']+)'/);
        const row = match ? rows.find(r => r.path === match[1]) : undefined;
        return row ? [{ summary: row.summary }] : [];
      }
      // Prefetch: SELECT path, summary FROM ... WHERE path IN (...)
      if (sql.includes("SELECT path, summary") && sql.includes("IN (")) {
        const inMatch = sql.match(/IN \(([^)]+)\)/);
        if (inMatch) {
          const paths = inMatch[1].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
          return rows
            .filter(r => paths.includes(r.path))
            .map(r => ({ path: r.path, summary: r.summary }));
        }
        return [];
      }
      // Virtual index: SELECT path, project, description, creation_date, last_update_date FROM ... WHERE path LIKE '/summaries/%'
      if (sql.includes("SELECT path, project, description, creation_date, last_update_date")) {
        return rows
          .filter(r => r.path.startsWith("/summaries/"))
          .map(r => ({
            path: r.path, project: r.project, description: r.description,
            creation_date: r.creation_date, last_update_date: r.last_update_date,
          }));
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
      // UPDATE — distinguish append (summary || ) from full overwrite (summary = E'...')
      if (sql.startsWith("UPDATE")) {
        const match = sql.match(/WHERE path = '([^']+)'/);
        if (match) {
          const row = rows.find(r => r.path === match[1]);
          if (row) {
            // Extract dates if present
            const cdMatch2 = sql.match(/creation_date = '([^']+)'/);
            if (cdMatch2) row.creation_date = cdMatch2[1];
            const ludMatch2 = sql.match(/last_update_date = '([^']+)'/);
            if (ludMatch2) row.last_update_date = ludMatch2[1];

            if (sql.includes("summary = summary ||")) {
              // appendFile: SQL-level concat
              const appendMatch = sql.match(/summary \|\| E'((?:[^']|'')*)'/);
              if (appendMatch) {
                const appendText = appendMatch[1].replace(/''/g, "'");
                row.summary += appendText;
                row.size_bytes = Buffer.byteLength(row.summary, "utf-8");
              }
            } else {
              // Full overwrite UPDATE (_doFlush for existing paths)
              const textMatch = sql.match(/summary = E'((?:[^']|'')*)'/);
              if (textMatch) {
                row.summary = textMatch[1].replace(/''/g, "'");
                row.size_bytes = Buffer.byteLength(row.summary, "utf-8");
              }
            }
            // Handle new metadata columns in any UPDATE
            const projMatch = sql.match(/project = '([^']*)'/);
            if (projMatch) row.project = projMatch[1];
            const descMatch = sql.match(/description = '([^']*)'/);
            if (descMatch) row.description = descMatch[1];
            const cdMatch = sql.match(/creation_date = '([^']*)'/);
            if (cdMatch) row.creation_date = cdMatch[1];
            const ludMatch = sql.match(/last_update_date = '([^']*)'/);
            if (ludMatch) row.last_update_date = ludMatch[1];
          }
        }
        return [];
      }
      // INSERT
      if (sql.startsWith("INSERT")) {
        const hasId = sql.includes("(id,");
        const valuesMatch = sql.match(/VALUES \((.+)\)$/s);
        if (valuesMatch) {
          const idMatch = hasId ? sql.match(/VALUES \('([^']+)'/) : null;
          const pathMatch = hasId
            ? sql.match(/VALUES \('[^']+', '([^']+)'/)   // skip id
            : sql.match(/VALUES \('([^']+)'/);
          if (pathMatch) {
            const path = pathMatch[1];
            const filename = path.split("/").pop()!;
            const id = idMatch?.[1] ?? "";
            // Parse columns and values positionally
            const colsPart = sql.match(/\(([^)]+)\)\s+VALUES/)?.[1] ?? "";
            const colsList = colsPart.split(",").map(c => c.trim());
            // Extract all quoted values from VALUES(...)
            const valsStr = valuesMatch[1];
            const allVals: string[] = [];
            let i = 0;
            while (i < valsStr.length) {
              if (valsStr[i] === "'" || (valsStr.slice(i, i + 2) === "E'")) {
                // String value — find matching close quote (handle '' escapes)
                const start = valsStr[i] === "E" ? i + 2 : i + 1;
                let end = start;
                while (end < valsStr.length) {
                  if (valsStr[end] === "'" && valsStr[end + 1] !== "'") break;
                  if (valsStr[end] === "'" && valsStr[end + 1] === "'") end++; // skip escaped
                  end++;
                }
                allVals.push(valsStr.slice(start, end).replace(/''/g, "'"));
                i = end + 1;
              } else if (/\d/.test(valsStr[i])) {
                const m = valsStr.slice(i).match(/^(\d+)/);
                if (m) { allVals.push(m[1]); i += m[1].length; }
                else i++;
              } else { i++; }
            }
            // Map column names to values
            const colMap: Record<string, string> = {};
            for (let c = 0; c < colsList.length; c++) {
              colMap[colsList[c]] = allVals[c] ?? "";
            }
            const project = colMap["project"] ?? "";
            const description = colMap["description"] ?? "";
            const creation_date = colMap["creation_date"] ?? "";
            const last_update_date = colMap["last_update_date"] ?? "";
            // Remove existing row if any (upsert)
            const idx = rows.findIndex(r => r.path === path);
            if (idx >= 0) rows.splice(idx, 1);
            const summary = colMap["summary"] ?? "";
            rows.push({ id, path, filename, summary, mime_type: "text/plain", size_bytes: Buffer.byteLength(summary, "utf-8"), project, description, creation_date, last_update_date });
          }
        }
        return [];
      }
      return [];
    }),

    listTables: vi.fn().mockResolvedValue(["test"]),
    ensureTable: vi.fn().mockResolvedValue(undefined),

    // Expose internal rows for test assertions
    _rows: rows,
  };

  return client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function makeFs(seed: Record<string, string | Buffer> = {}, mount = "/memory") {
  const bufSeed: Record<string, Buffer> = {};
  for (const [k, v] of Object.entries(seed)) {
    bufSeed[k] = typeof v === "string" ? Buffer.from(v, "utf-8") : v;
  }
  const client = makeClient(bufSeed);
  const fs = await DeeplakeFs.create(client as never, "test", mount);
  return { fs, client };
}


describe("guessMime", () => {
  it("returns application/json for .json", () => expect(guessMime("foo.json")).toBe("application/json"));
  it("returns text/markdown for .md",       () => expect(guessMime("notes.md")).toBe("text/markdown"));
  it("returns text/plain for unknown ext", () => expect(guessMime("file.xyz")).toBe("text/plain"));
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
describe("DeeplakeFs bootstrap", () => {
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
  it("reads text via summary SQL column", async () => {
    const { fs, client } = await makeFs({ "/memory/hello.txt": "hello" });
    const content = await fs.readFile("/memory/hello.txt");
    expect(content).toBe("hello");
    const calls = (client.query.mock.calls as [string][]);
    expect(calls.some(c => (c[0] as string).includes("SELECT summary FROM"))).toBe(true);
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

// ── Buffer reads ──────────────────────────────────────────────────────────────
describe("readFileBuffer", () => {
  it("roundtrips text content as buffer", async () => {
    const { fs } = await makeFs({ "/memory/notes.txt": "hello world" });
    const result = await fs.readFileBuffer("/memory/notes.txt");
    expect(Buffer.from(result).toString("utf-8")).toBe("hello world");
  });

  it("reads via SQL SELECT summary query", async () => {
    const { fs, client } = await makeFs({ "/memory/data.txt": "test data" });
    await fs.readFileBuffer("/memory/data.txt");
    const selectCalls = (client.query.mock.calls as [string][]).filter(c =>
      (c[0] as string).includes("SELECT summary FROM")
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

  it("batches and flushes on BATCH_SIZE writes (INSERT per new row)", async () => {
    const { fs, client } = await makeFs({});
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(fs.writeFile(`/memory/file${i}.txt`, `content ${i}`));
    }
    await Promise.all(promises);
    const insertCalls = (client.query.mock.calls as [string][]).filter(c => (c[0] as string).startsWith("INSERT"));
    expect(insertCalls.length).toBe(10);
  });

  it("overwrites existing file", async () => {
    const { fs } = await makeFs({ "/memory/a.txt": "old" });
    await fs.writeFile("/memory/a.txt", "new");
    expect(await fs.readFile("/memory/a.txt")).toBe("new");
  });

  it("stores text content in summary column on INSERT", async () => {
    const { fs, client } = await makeFs({});
    // Write 10 to trigger flush
    for (let i = 0; i < 9; i++) await fs.writeFile(`/memory/dummy${i}.txt`, "x");
    await fs.writeFile("/memory/notes.md", "# Hello");

    const insertCalls = (client.query.mock.calls as [string][])
      .filter(c => (c[0] as string).startsWith("INSERT") && (c[0] as string).includes("notes.md"));
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0][0]).toContain("# Hello");
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

// ── prefetch ────────────────────────────────────────────────────────────────
describe("prefetch", () => {
  it("loads multiple uncached files in a single query", async () => {
    const { fs, client } = await makeFs({
      "/memory/a.txt": "alpha",
      "/memory/b.txt": "bravo",
      "/memory/c.txt": "charlie",
    });
    client.query.mockClear();

    await fs.prefetch(["/memory/a.txt", "/memory/b.txt", "/memory/c.txt"]);

    // Should issue exactly one SELECT ... WHERE path IN (...) query
    const prefetchCalls = (client.query.mock.calls as [string][]).filter(
      c => c[0].includes("SELECT path, summary") && c[0].includes("IN (")
    );
    expect(prefetchCalls.length).toBe(1);
    expect(prefetchCalls[0][0]).toContain("/memory/a.txt");
    expect(prefetchCalls[0][0]).toContain("/memory/b.txt");
    expect(prefetchCalls[0][0]).toContain("/memory/c.txt");

    // Subsequent readFile and readFileBuffer calls should hit cache (no more queries)
    client.query.mockClear();
    expect(await fs.readFile("/memory/a.txt")).toBe("alpha");
    expect(await fs.readFile("/memory/b.txt")).toBe("bravo");
    expect(await fs.readFile("/memory/c.txt")).toBe("charlie");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("skips already-cached files", async () => {
    const { fs, client } = await makeFs({ "/memory/a.txt": "alpha", "/memory/b.txt": "bravo" });
    // Read a.txt to cache it
    await fs.readFile("/memory/a.txt");
    client.query.mockClear();

    await fs.prefetch(["/memory/a.txt", "/memory/b.txt"]);

    // Only b.txt should be in the IN list
    const prefetchCalls = (client.query.mock.calls as [string][]).filter(
      c => c[0].includes("SELECT path, summary") && c[0].includes("IN (")
    );
    expect(prefetchCalls.length).toBe(1);
    expect(prefetchCalls[0][0]).not.toContain("/memory/a.txt");
    expect(prefetchCalls[0][0]).toContain("/memory/b.txt");
  });

  it("skips pending (unflushed) files", async () => {
    const { fs, client } = await makeFs({});
    await fs.writeFile("/memory/new.txt", "pending content");
    client.query.mockClear();

    await fs.prefetch(["/memory/new.txt"]);

    // No query should be issued — file is in pending batch
    const prefetchCalls = (client.query.mock.calls as [string][]).filter(
      c => c[0].includes("SELECT path, summary")
    );
    expect(prefetchCalls.length).toBe(0);
  });

  it("skips unknown paths not in the file tree", async () => {
    const { fs, client } = await makeFs({ "/memory/a.txt": "alpha" });
    client.query.mockClear();

    await fs.prefetch(["/memory/a.txt", "/memory/nonexistent.txt"]);

    // Only a.txt should be queried, nonexistent is not in the tree
    const prefetchCalls = (client.query.mock.calls as [string][]).filter(
      c => c[0].includes("SELECT path, summary") && c[0].includes("IN (")
    );
    expect(prefetchCalls.length).toBe(1);
    expect(prefetchCalls[0][0]).toContain("/memory/a.txt");
    expect(prefetchCalls[0][0]).not.toContain("nonexistent");
  });

  it("is a no-op when all files are cached", async () => {
    const { fs, client } = await makeFs({ "/memory/a.txt": "alpha" });
    await fs.readFile("/memory/a.txt"); // cache it
    client.query.mockClear();

    await fs.prefetch(["/memory/a.txt"]);

    expect(client.query).not.toHaveBeenCalled();
  });
});

// ── Upsert: id stability & dates ─────────────────────────────────────────────
describe("flush upsert", () => {
  it("INSERT for new file sets id, creation_date and last_update_date", async () => {
    const { fs, client } = await makeFs({});
    // Write 10 files to trigger flush
    for (let i = 0; i < 10; i++) await fs.writeFile(`/memory/f${i}.txt`, `v${i}`);
    const insertCalls = (client.query.mock.calls as [string][]).filter(c => (c[0] as string).startsWith("INSERT"));
    expect(insertCalls.length).toBe(10);
    // Every INSERT should include id, creation_date and last_update_date columns
    for (const [sql] of insertCalls) {
      expect(sql).toContain("(id,");
      expect(sql).toContain("creation_date");
      expect(sql).toContain("last_update_date");
    }
  });

  it("UPDATE for existing file preserves id", async () => {
    const { fs, client } = await makeFs({ "/memory/existing.txt": "old" });
    const originalId = client._rows.find(r => r.path === "/memory/existing.txt")!.id;

    // Overwrite and trigger flush
    for (let i = 0; i < 9; i++) await fs.writeFile(`/memory/pad${i}.txt`, "x");
    await fs.writeFile("/memory/existing.txt", "new");

    // Should emit UPDATE (not INSERT) for the existing path
    const updateCalls = (client.query.mock.calls as [string][]).filter(
      c => (c[0] as string).startsWith("UPDATE") && (c[0] as string).includes("existing.txt")
    );
    expect(updateCalls.length).toBe(1);
    // No DELETE for existing.txt
    const deleteCalls = (client.query.mock.calls as [string][]).filter(
      c => (c[0] as string).startsWith("DELETE") && (c[0] as string).includes("existing.txt")
    );
    expect(deleteCalls.length).toBe(0);
    // id should be preserved
    const row = client._rows.find(r => r.path === "/memory/existing.txt")!;
    expect(row.id).toBe(originalId);
    expect(row.summary).toBe("new");
  });

  it("UPDATE includes last_update_date", async () => {
    const { fs, client } = await makeFs({ "/memory/ts.txt": "old" });
    const originalLud = client._rows.find(r => r.path === "/memory/ts.txt")!.last_update_date;

    for (let i = 0; i < 9; i++) await fs.writeFile(`/memory/pad${i}.txt`, "x");
    await fs.writeFile("/memory/ts.txt", "new");

    const row = client._rows.find(r => r.path === "/memory/ts.txt")!;
    expect(row.last_update_date).not.toBe(originalLud);
    expect(row.last_update_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("multiple overwrites of same file never change id", async () => {
    const { fs, client } = await makeFs({ "/memory/stable.txt": "v0" });
    const originalId = client._rows.find(r => r.path === "/memory/stable.txt")!.id;

    for (let round = 1; round <= 3; round++) {
      for (let i = 0; i < 9; i++) await fs.writeFile(`/memory/pad${i}.txt`, "x");
      await fs.writeFile("/memory/stable.txt", `v${round}`);
    }

    const row = client._rows.find(r => r.path === "/memory/stable.txt")!;
    expect(row.id).toBe(originalId);
    expect(row.summary).toBe("v3");
  });

  it("new file after delete gets a new id", async () => {
    const { fs, client } = await makeFs({ "/memory/recycle.txt": "first" });
    const originalId = client._rows.find(r => r.path === "/memory/recycle.txt")!.id;

    await fs.rm("/memory/recycle.txt");
    // Write enough to flush
    for (let i = 0; i < 9; i++) await fs.writeFile(`/memory/pad${i}.txt`, "x");
    await fs.writeFile("/memory/recycle.txt", "second");

    const row = client._rows.find(r => r.path === "/memory/recycle.txt")!;
    expect(row.id).not.toBe(originalId);
    expect(row.summary).toBe("second");
  });
});

describe("appendFile upsert", () => {
  it("preserves id on append", async () => {
    const { fs, client } = await makeFs({ "/memory/log.txt": "line1\n" });
    const originalId = client._rows.find(r => r.path === "/memory/log.txt")!.id;

    await fs.appendFile("/memory/log.txt", "line2\n");

    const row = client._rows.find(r => r.path === "/memory/log.txt")!;
    expect(row.id).toBe(originalId);
  });

  it("updates last_update_date on append", async () => {
    const { fs, client } = await makeFs({ "/memory/log.txt": "line1\n" });
    const originalLud = client._rows.find(r => r.path === "/memory/log.txt")!.last_update_date;

    await fs.appendFile("/memory/log.txt", "line2\n");

    const row = client._rows.find(r => r.path === "/memory/log.txt")!;
    expect(row.last_update_date).not.toBe(originalLud);
    expect(row.last_update_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("multiple appends preserve same id", async () => {
    const { fs, client } = await makeFs({ "/memory/log.txt": "" });
    const originalId = client._rows.find(r => r.path === "/memory/log.txt")!.id;

    for (let i = 0; i < 5; i++) {
      await fs.appendFile("/memory/log.txt", `line${i}\n`);
    }

    const row = client._rows.find(r => r.path === "/memory/log.txt")!;
    expect(row.id).toBe(originalId);
    expect(row.summary).toBe("line0\nline1\nline2\nline3\nline4\n");
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

// ── Virtual index.md ─────────────────────────────────────────────────────────
describe("virtual index.md", () => {
  /** Helper: create FS mounted at "/" with summary rows that have metadata columns set. */
  async function makeFsWithSummaries(summaries: { id: string; userName: string; project: string; description: string; creationDate: string; lastUpdateDate: string; content: string }[], extraSeed: Record<string, string> = {}) {
    const seed: Record<string, string> = { ...extraSeed };
    for (const s of summaries) {
      seed[`/summaries/${s.userName}/${s.id}.md`] = s.content;
    }
    const { fs, client } = await makeFs(seed, "/");
    // Set metadata on summary rows
    for (const s of summaries) {
      const row = client._rows.find(r => r.path === `/summaries/${s.userName}/${s.id}.md`);
      if (row) {
        row.project = s.project;
        row.description = s.description;
        row.creation_date = s.creationDate;
        row.last_update_date = s.lastUpdateDate;
      }
    }
    return { fs, client };
  }

  it("generates virtual index when no /index.md row exists", async () => {
    const { fs } = await makeFsWithSummaries([
      { id: "aaa-111", userName: "alice", project: "my-project", description: "Fixed auth bug", creationDate: "2026-04-07T10:00:00.000Z", lastUpdateDate: "2026-04-07T11:00:00.000Z", content: "# Session aaa-111" },
      { id: "bbb-222", userName: "alice", project: "other-proj", description: "in progress", creationDate: "2026-04-07T12:00:00.000Z", lastUpdateDate: "2026-04-07T12:00:00.000Z", content: "# Session bbb-222" },
    ]);
    const content = await fs.readFile("/index.md");
    expect(content).toContain("# Session Index");
    expect(content).toContain("| Session | Conversation | Created | Last Updated | Project | Description |");
    expect(content).toContain("aaa-111");
    expect(content).toContain("bbb-222");
    expect(content).toContain("my-project");
    expect(content).toContain("Fixed auth bug");
    expect(content).toContain("2026-04-07");
  });

  it("serves real /index.md row when it exists", async () => {
    const { fs } = await makeFsWithSummaries(
      [{ id: "aaa-111", userName: "alice", project: "proj", description: "desc", creationDate: "2026-04-07T10:00:00.000Z", lastUpdateDate: "2026-04-07T10:00:00.000Z", content: "# Session" }],
      { "/index.md": "# My Custom Index\nHello" },
    );
    const content = await fs.readFile("/index.md");
    expect(content).toBe("# My Custom Index\nHello");
  });

  it("exists() returns true for /index.md even without a real row", async () => {
    const { fs } = await makeFs({}, "/");
    expect(await fs.exists("/index.md")).toBe(true);
  });

  it("readdir('/') includes index.md even without a real row", async () => {
    const { fs } = await makeFsWithSummaries([
      { id: "aaa-111", userName: "alice", project: "proj", description: "desc", creationDate: "2026-04-07T10:00:00.000Z", lastUpdateDate: "2026-04-07T10:00:00.000Z", content: "# Session" },
    ]);
    const entries = await fs.readdir("/");
    expect(entries).toContain("index.md");
    expect(entries).toContain("summaries");
  });

  it("stat('/index.md') returns file stat even without a real row", async () => {
    const { fs } = await makeFs({}, "/");
    const s = await fs.stat("/index.md");
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
  });

  it("virtual index shows all summary rows ordered", async () => {
    const { fs } = await makeFsWithSummaries([
      { id: "old-session", userName: "alice", project: "proj-a", description: "Old work", creationDate: "2026-04-01T10:00:00.000Z", lastUpdateDate: "2026-04-01T11:00:00.000Z", content: "# Old" },
      { id: "new-session", userName: "alice", project: "proj-b", description: "New work", creationDate: "2026-04-07T10:00:00.000Z", lastUpdateDate: "2026-04-07T12:00:00.000Z", content: "# New" },
    ]);
    const content = await fs.readFile("/index.md");
    // Both sessions should appear
    expect(content).toContain("old-session");
    expect(content).toContain("new-session");
    expect(content).toContain("proj-a");
    expect(content).toContain("proj-b");
  });

  it("virtual index handles empty summaries table", async () => {
    const { fs } = await makeFs({}, "/");
    const content = await fs.readFile("/index.md");
    expect(content).toContain("# Session Index");
    expect(content).toContain("| Session | Conversation | Created | Last Updated | Project | Description |");
    // No data rows
    const lines = content.split("\n").filter(l => l.startsWith("| ["));
    expect(lines.length).toBe(0);
  });

  it("readdir does not duplicate index.md when real row exists", async () => {
    const { fs } = await makeFs({ "/index.md": "real" }, "/");
    const entries = await fs.readdir("/");
    const indexEntries = entries.filter(e => e === "index.md");
    expect(indexEntries.length).toBe(1);
  });

  it("virtual index uses summaries/username/id.md links for new paths", async () => {
    const { fs } = await makeFsWithSummaries([
      { id: "sess-001", userName: "alice", project: "proj-a", description: "Did stuff", creationDate: "2026-04-07T10:00:00.000Z", lastUpdateDate: "2026-04-07T11:00:00.000Z", content: "# Session sess-001" },
    ]);
    const content = await fs.readFile("/index.md");
    expect(content).toContain("summaries/alice/sess-001.md");
    expect(content).toContain("sess-001");
    expect(content).toContain("Did stuff");
  });

  it("virtual index skips summaries without username in path", async () => {
    const { fs, client } = await makeFsWithSummaries([
      { id: "new-sess", userName: "bob", project: "proj-b", description: "New session", creationDate: "2026-04-07T10:00:00.000Z", lastUpdateDate: "2026-04-07T12:00:00.000Z", content: "# New" },
    ]);
    // Manually insert a legacy row (no username dir)
    client._rows.push({
      id: "legacy", path: "/summaries/old-sess.md", filename: "old-sess.md",
      summary: "# Old", mime_type: "text/markdown",
      size_bytes: 5, project: "proj-a", description: "Legacy", creation_date: "2026-04-01", last_update_date: "2026-04-01",
    });
    const content = await fs.readFile("/index.md");
    expect(content).toContain("summaries/bob/new-sess.md");
    expect(content).not.toContain("old-sess");
  });

  it("virtual index links multiple users correctly", async () => {
    const { fs } = await makeFsWithSummaries([
      { id: "s1", userName: "alice", project: "proj", description: "Alice work", creationDate: "2026-04-07T10:00:00.000Z", lastUpdateDate: "2026-04-07T10:00:00.000Z", content: "# S1" },
      { id: "s2", userName: "bob", project: "proj", description: "Bob work", creationDate: "2026-04-07T11:00:00.000Z", lastUpdateDate: "2026-04-07T11:00:00.000Z", content: "# S2" },
    ]);
    const content = await fs.readFile("/index.md");
    expect(content).toContain("summaries/alice/s1.md");
    expect(content).toContain("summaries/bob/s2.md");
  });
});

// ── writeFileWithMeta ────────────────────────────────────────────────────────
describe("writeFileWithMeta", () => {
  it("stores metadata columns on INSERT", async () => {
    const { fs, client } = await makeFs({}, "/");
    // Write enough to trigger flush (10 files)
    for (let i = 0; i < 9; i++) await fs.writeFile(`/pad${i}.txt`, "x");
    await fs.writeFileWithMeta("/summaries/test-123.md", "# Test", {
      project: "my-project",
      description: "in progress",
      creationDate: "2026-04-07T10:00:00.000Z",
      lastUpdateDate: "2026-04-07T10:00:00.000Z",
    });

    const row = client._rows.find(r => r.path === "/summaries/test-123.md");
    expect(row).toBeDefined();
    expect(row!.project).toBe("my-project");
    expect(row!.description).toBe("in progress");
    expect(row!.creation_date).toBe("2026-04-07T10:00:00.000Z");
    expect(row!.last_update_date).toBe("2026-04-07T10:00:00.000Z");
  });

  it("updates metadata columns on UPDATE of existing file", async () => {
    const { fs, client } = await makeFs({ "/summaries/existing.md": "# Old" }, "/");
    // Set initial metadata
    const row = client._rows.find(r => r.path === "/summaries/existing.md")!;
    row.project = "old-proj";
    row.description = "old desc";

    // Write enough to trigger flush
    for (let i = 0; i < 9; i++) await fs.writeFile(`/pad${i}.txt`, "x");
    await fs.writeFileWithMeta("/summaries/existing.md", "# New", {
      project: "new-proj",
      description: "new desc",
      lastUpdateDate: "2026-04-07T15:00:00.000Z",
    });

    const updated = client._rows.find(r => r.path === "/summaries/existing.md")!;
    expect(updated.project).toBe("new-proj");
    expect(updated.description).toBe("new desc");
    expect(updated.last_update_date).toBe("2026-04-07T15:00:00.000Z");
  });
});

// ── readdirWithFileTypes ─────────────────────────────────────────────────────
describe("readdirWithFileTypes", () => {
  it("returns entries with correct isFile/isDirectory", async () => {
    const { fs } = await makeFs({
      "/memory/file.txt": "hello",
      "/memory/sub/nested.txt": "deep",
    });
    const entries = await fs.readdirWithFileTypes("/memory");
    const file = entries.find(e => e.name === "file.txt");
    const dir = entries.find(e => e.name === "sub");
    expect(file).toBeDefined();
    expect(file!.isFile).toBe(true);
    expect(file!.isDirectory).toBe(false);
    expect(dir).toBeDefined();
    expect(dir!.isFile).toBe(false);
    expect(dir!.isDirectory).toBe(true);
  });

  it("includes virtual index.md in root listing", async () => {
    const { fs } = await makeFs({ "/summaries/test.md": "x" }, "/");
    const entries = await fs.readdirWithFileTypes("/");
    const idx = entries.find(e => e.name === "index.md");
    expect(idx).toBeDefined();
    expect(idx!.isFile).toBe(true);
  });
});

// ── cp recursive ─────────────────────────────────────────────────────────────
describe("cp recursive", () => {
  it("copies directory recursively", async () => {
    const { fs } = await makeFs({
      "/memory/src/a.txt": "aaa",
      "/memory/src/b.txt": "bbb",
    });
    await fs.cp("/memory/src", "/memory/dst", { recursive: true });
    expect(await fs.readFile("/memory/dst/a.txt")).toBe("aaa");
    expect(await fs.readFile("/memory/dst/b.txt")).toBe("bbb");
    // Source still exists
    expect(await fs.readFile("/memory/src/a.txt")).toBe("aaa");
  });
});
