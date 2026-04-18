import { describe, it, expect, vi } from "vitest";
import { createGrepCommand } from "../../src/shell/grep-interceptor.js";
import { DeeplakeFs } from "../../src/shell/deeplake-fs.js";

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

function makeCtx(fs: DeeplakeFs, cwd = "/memory") {
  return { fs, cwd, env: new Map<string, string>(), stdin: "" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// The interceptor now queries both `memory` and `sessions` in parallel with
// LIKE/ILIKE (no more BM25 — the `<#>` query returned 400 on every call),
// and each SQL row returns { path, content } so we no longer need a
// prefetch round-trip to read file content for the regex pass. Prefetch is
// only used as a fallback when SQL returns zero rows and we scan the FS
// cache. Tests below assert that new contract.

describe("grep interceptor", () => {
  it("returns exitCode=127 for paths outside mount (pass-through)", async () => {
    const client = makeClient();
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    client.query.mockClear(); // clear bootstrap calls
    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["foo", "/etc/hosts"], makeCtx(fs) as never);
    expect(result.exitCode).toBe(127);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("routes to the memory table when the target path is clearly memory-backed", async () => {
    const client = makeClient([{ path: "/memory/a.txt", content: "hello world" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    client.query.mockClear();
    client.query.mockResolvedValue([{ path: "/memory/a.txt", content: "hello world" }]);

    const cmd = createGrepCommand(client as never, fs, "test", "sessions");
    const result = await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    const sqls = client.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sqls.some(s => /FROM "test"/.test(s) && /ILIKE|LIKE/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM "sessions"/.test(s) && /ILIKE|LIKE/.test(s))).toBe(false);
    // No BM25 in the new path
    expect(sqls.some(s => s.includes("<#>"))).toBe(false);
    expect(result.stdout).toContain("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("falls back to in-memory scan when SQL returns nothing", async () => {
    const client = makeClient([]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "hello world");
    client.query.mockClear();
    client.query.mockResolvedValue([]); // SQL returns no rows for both tables

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    // SQL was attempted
    expect(client.query).toHaveBeenCalled();
    // Fallback still found the content via fs.readFile
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
    const client = makeClient([{ path: "/memory/a.txt", content: "Hello World" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["-i", "hello", "/memory"], makeCtx(fs) as never);

    expect(result.stdout).toContain("Hello World");
    expect(result.exitCode).toBe(0);
  });

  it("respects -l (files-only) flag", async () => {
    const client = makeClient([
      { path: "/memory/a.txt", content: "match here\nmatch again" },
      { path: "/memory/b.txt", content: "also match" },
    ]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["-l", "match", "/memory"], makeCtx(fs) as never);

    const lines = result.stdout.trim().split("\n");
    expect(lines).toContain("/memory/a.txt");
    expect(lines).toContain("/memory/b.txt");
    // Should list each file once, not each matching line
    expect(lines.length).toBe(2);
  });

  it("respects -v (invert-match) flag", async () => {
    const client = makeClient([
      { path: "/memory/a.txt", content: "keep this\nremove match\nkeep this too" },
    ]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["-v", "match", "/memory"], makeCtx(fs) as never);

    expect(result.stdout).toContain("keep this");
    expect(result.stdout).not.toContain("remove match");
  });

  it("SQL rows carry their own content — no prefetch when SQL hits", async () => {
    const client = makeClient([
      { path: "/memory/a.txt", content: "hello world" },
      { path: "/memory/b.txt", content: "hello there" },
    ]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");

    const prefetchSpy = vi.spyOn(fs, "prefetch");
    const readSpy = vi.spyOn(fs, "readFile");
    const cmd = createGrepCommand(client as never, fs, "test");
    await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    // The new path gets content from the SQL rows directly, so no FS
    // round-trips are needed on the happy path.
    expect(prefetchSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("fallback path prefetches the FS cache when SQL is empty", async () => {
    const client = makeClient([]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "hello world");
    await fs.writeFile("/memory/b.txt", "hello there");
    client.query.mockClear();
    client.query.mockResolvedValue([]);

    const prefetchSpy = vi.spyOn(fs, "prefetch");
    const cmd = createGrepCommand(client as never, fs, "test");
    await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["/memory/a.txt", "/memory/b.txt"])
    );
  });
});
