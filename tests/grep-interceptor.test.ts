import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGrepCommand } from "../src/shell/grep-interceptor.js";
import { DeeplakeFs } from "../src/shell/deeplake-fs.js";

// ── Minimal mocks ─────────────────────────────────────────────────────────────
function makeClient(queryResults: Record<string, string>[] = []) {
  return {
    applyStorageCreds: vi.fn().mockResolvedValue(undefined),
    getNumRows:    vi.fn().mockResolvedValue(0),
    getColumnData: vi.fn().mockResolvedValue([]),
    getField:      vi.fn().mockResolvedValue(""),
    ingest:        vi.fn().mockResolvedValue({ tableName: "t", rowCount: 0, datasetPath: "" }),
    query:         vi.fn().mockResolvedValue(queryResults),
    listTables:    vi.fn().mockResolvedValue(["test"]),
    ensureTable:   vi.fn().mockResolvedValue(undefined),
  };
}

async function makeFs(files: Record<string, string> = {}) {
  const client = makeClient();
  const fs = await DeeplakeFs.create(client as never, "test", "/memory");
  for (const [path, content] of Object.entries(files)) {
    await fs.writeFile(path, content);
  }
  return { fs, client };
}

function makeCtx(fs: DeeplakeFs, cwd = "/memory") {
  return { fs, cwd, env: new Map<string, string>(), stdin: "" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("grep interceptor", () => {
  it("returns exitCode=127 for paths outside mount (pass-through)", async () => {
    const { fs, client } = await makeFs({});
    client.query.mockClear(); // clear bootstrap calls
    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["foo", "/etc/hosts"], makeCtx(fs) as never);
    expect(result.exitCode).toBe(127);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("uses BM25 query when pattern matches files", async () => {
    const { fs } = await makeFs({ "/memory/a.txt": "hello world", "/memory/b.txt": "goodbye" });

    const client = makeClient([{ path: "/memory/a.txt" }]);
    // Re-create fs with this client so getField works for readFile
    const fs2 = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs2.writeFile("/memory/a.txt", "hello world");
    await fs2.writeFile("/memory/b.txt", "goodbye");

    const cmd = createGrepCommand(client as never, fs2, "test");
    const result = await cmd.execute(["hello", "/memory"], makeCtx(fs2) as never);

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("<#>"));
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("falls back to in-memory search when BM25 returns nothing", async () => {
    const client = makeClient([]);

    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "hello world");
    client.query.mockClear(); // clear bootstrap + write calls
    // BM25 returns no results — should fall back to in-memory getAllPaths
    client.query.mockResolvedValueOnce([]);

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    const calls = client.query.mock.calls as [string][];
    expect(calls[0][0]).toContain("<#>");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
  });

  it("returns exitCode=1 when no matches found", async () => {
    const client = makeClient([]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["zzznomatch", "/memory"], makeCtx(fs) as never);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("respects -i (ignore-case) flag", async () => {
    const client = makeClient([{ path: "/memory/a.txt" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "Hello World");

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["-i", "hello", "/memory"], makeCtx(fs) as never);

    expect(result.stdout).toContain("Hello World");
    expect(result.exitCode).toBe(0);
  });

  it("respects -l (files-only) flag", async () => {
    const client = makeClient([
      { path: "/memory/a.txt" },
      { path: "/memory/b.txt" },
    ]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "match here\nmatch again");
    await fs.writeFile("/memory/b.txt", "also match");

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["-l", "match", "/memory"], makeCtx(fs) as never);

    const lines = result.stdout.trim().split("\n");
    expect(lines).toContain("/memory/a.txt");
    expect(lines).toContain("/memory/b.txt");
    // Should list each file once, not each matching line
    expect(lines.length).toBe(2);
  });

  it("respects -v (invert-match) flag", async () => {
    const client = makeClient([{ path: "/memory/a.txt" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "keep this\nremove match\nkeep this too");

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["-v", "match", "/memory"], makeCtx(fs) as never);

    expect(result.stdout).toContain("keep this");
    expect(result.stdout).not.toContain("remove match");
  });

  it("prefetches candidates into fs content cache before matching", async () => {
    const client = makeClient([{ path: "/memory/a.txt" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "cached content");

    const readFileSpy = vi.spyOn(fs, "readFile");
    const cmd = createGrepCommand(client as never, fs, "test");
    await cmd.execute(["cached", "/memory"], makeCtx(fs) as never);

    // readFile should have been called for the candidate (prefetch + match)
    expect(readFileSpy).toHaveBeenCalledWith("/memory/a.txt");
  });
});
