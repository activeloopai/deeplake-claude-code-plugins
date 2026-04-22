import { describe, it, expect, vi, afterEach } from "vitest";

// Mock EmbedClient BEFORE importing the interceptor so the shared singleton
// inside grep-interceptor picks up our stub (not the real daemon client).
// `vi.hoisted` lets us share the spy across mock factory + tests — plain
// top-level consts aren't visible inside the hoisted vi.mock factory.
const { mockEmbed } = vi.hoisted(() => ({ mockEmbed: vi.fn() }));
vi.mock("../../src/embeddings/client.js", () => {
  class MockEmbedClient {
    async embed(text: string, kind: string) { return mockEmbed(text, kind); }
  }
  return { EmbedClient: MockEmbedClient };
});

import { createGrepCommand } from "../../src/shell/grep-interceptor.js";
import { DeeplakeFs } from "../../src/shell/deeplake-fs.js";
import * as grepCore from "../../src/shell/grep-core.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
    mockEmbed.mockReset();
  });

  it("returns exitCode=1 when the pattern is missing", async () => {
    const client = makeClient();
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    client.query.mockClear();
    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute([], makeCtx(fs) as never);
    expect(result).toEqual({
      stdout: "",
      stderr: "grep: missing pattern\n",
      exitCode: 1,
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("returns exitCode=1 when all target paths resolve to nothing", async () => {
    const client = makeClient();
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    vi.spyOn(fs, "resolvePath").mockReturnValue("");
    client.query.mockClear();
    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["foo", "missing"], makeCtx(fs) as never);
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 1 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("returns exitCode=127 for paths outside mount (pass-through)", async () => {
    const client = makeClient();
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    client.query.mockClear(); // clear bootstrap calls
    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["foo", "/etc/hosts"], makeCtx(fs) as never);
    expect(result.exitCode).toBe(127);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("queries both memory and sessions tables with LIKE and returns matches", async () => {
    const client = makeClient([{ path: "/memory/a.txt", content: "hello world" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    client.query.mockClear();
    client.query.mockResolvedValue([{ path: "/memory/a.txt", content: "hello world" }]);

    const cmd = createGrepCommand(client as never, fs, "test", "sessions");
    const result = await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    const sqls = client.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sqls.some(s => /FROM "test"/.test(s) && /ILIKE|LIKE/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM "sessions"/.test(s) && /ILIKE|LIKE/.test(s))).toBe(true);
    // No BM25 in the new path
    expect(sqls.some(s => s.includes("<#>"))).toBe(false);
    expect(result.stdout).toContain("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("uses one SQL query even when grep receives multiple target paths", async () => {
    const client = makeClient([{ path: "/memory/a.txt", content: "hello world" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    client.query.mockClear();
    client.query.mockResolvedValue([{ path: "/memory/a.txt", content: "hello world" }]);

    const cmd = createGrepCommand(client as never, fs, "test", "sessions");
    const result = await cmd.execute(["hello", "/memory/a", "/memory/b"], makeCtx(fs) as never);

    expect(client.query).toHaveBeenCalledTimes(1);
    const sql = client.query.mock.calls[0][0] as string;
    expect(sql).toContain('FROM "test"');
    expect(sql).toContain('FROM "sessions"');
    expect(sql).toContain("path = '/memory/a'");
    expect(sql).toContain("path = '/memory/b'");
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

  it("falls back to the FS cache when the SQL search rejects", async () => {
    const client = makeClient();
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    await fs.writeFile("/memory/a.txt", "hello world");
    vi.spyOn(grepCore, "searchDeeplakeTables").mockRejectedValueOnce(new Error("timeout"));

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
  });

  // ── Semantic path (HIVEMIND_SEMANTIC_SEARCH default=on) ─────────────────
  // These tests exercise the daemon-backed embed + UNION ALL branch of
  // searchDeeplakeTables. They mock the shared EmbedClient singleton so we
  // don't actually spawn nomic.
  it("passes the query embedding into searchDeeplakeTables for semantic-friendly patterns", async () => {
    mockEmbed.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    const client = makeClient([{ path: "/memory/a.txt", content: "deploy failed" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    const searchSpy = vi.spyOn(grepCore, "searchDeeplakeTables")
      .mockResolvedValue([{ path: "/memory/a.txt", content: "deploy failed" }]);

    const cmd = createGrepCommand(client as never, fs, "test", "sessions");
    const result = await cmd.execute(["deploy", "/memory"], makeCtx(fs) as never);

    expect(mockEmbed).toHaveBeenCalledWith("deploy", "query");
    const opts = searchSpy.mock.calls[0][3] as { queryEmbedding: number[] | null };
    expect(opts.queryEmbedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.exitCode).toBe(0);
    searchSpy.mockRestore();
  });

  it("skips embedding on regex-heavy patterns (too many metachars)", async () => {
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValue([0.5]);
    const client = makeClient([]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    const cmd = createGrepCommand(client as never, fs, "test");
    // Three metachars should disqualify the pattern from semantic.
    await cmd.execute(["(foo|bar|baz)\\+", "/memory"], makeCtx(fs) as never);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("skips embedding on very short patterns (< 2 chars)", async () => {
    mockEmbed.mockClear();
    const client = makeClient([]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    const cmd = createGrepCommand(client as never, fs, "test");
    await cmd.execute(["a", "/memory"], makeCtx(fs) as never);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("treats a thrown embed() as a null embedding and continues lexically", async () => {
    mockEmbed.mockClear();
    mockEmbed.mockRejectedValueOnce(new Error("daemon down"));
    const client = makeClient([{ path: "/memory/a.txt", content: "hello world" }]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    client.query.mockClear();
    client.query.mockResolvedValue([{ path: "/memory/a.txt", content: "hello world" }]);

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

    expect(mockEmbed).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
  });

  it("retries with a lexical-only search when semantic returns zero rows", async () => {
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValueOnce([0.1]);
    const client = makeClient([]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    const searchSpy = vi.spyOn(grepCore, "searchDeeplakeTables")
      .mockResolvedValueOnce([]) // first call (semantic+lexical hybrid) → empty
      .mockResolvedValueOnce([{ path: "/memory/a.txt", content: "hi" }]); // lexical retry

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["hi", "/memory"], makeCtx(fs) as never);

    expect(searchSpy).toHaveBeenCalledTimes(2);
    // First call carried the embedding, retry did not.
    const firstOpts = searchSpy.mock.calls[0][3] as { queryEmbedding: number[] | null };
    const secondOpts = searchSpy.mock.calls[1][3] as { queryEmbedding?: number[] | null };
    expect(firstOpts.queryEmbedding).toEqual([0.1]);
    expect(secondOpts.queryEmbedding).toBeUndefined();
    expect(result.exitCode).toBe(0);
    searchSpy.mockRestore();
  });

  it("emits all non-empty lines per row when the semantic path returned an embedding", async () => {
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValueOnce([0.1, 0.2]);
    const client = makeClient([]);
    const fs = await DeeplakeFs.create(client as never, "test", "/memory");
    const searchSpy = vi.spyOn(grepCore, "searchDeeplakeTables")
      .mockResolvedValue([{ path: "/memory/a.txt", content: "line A\nline B\n\nline C" }]);

    const cmd = createGrepCommand(client as never, fs, "test");
    const result = await cmd.execute(["deploy", "/memory"], makeCtx(fs) as never);

    // All three non-empty lines are emitted verbatim — no regex refinement.
    expect(result.stdout).toContain("/memory/a.txt:line A");
    expect(result.stdout).toContain("/memory/a.txt:line B");
    expect(result.stdout).toContain("/memory/a.txt:line C");
    expect(result.exitCode).toBe(0);
    searchSpy.mockRestore();
  });

  it("hits the 3s timeout rejector when searchDeeplakeTables hangs", async () => {
    // Force the SQL search to hang forever so Promise.race's setTimeout
    // callback (line 131 of grep-interceptor.ts) fires with a timeout error,
    // covering the reject() arrow function. Use fake timers to fast-forward
    // past the 3s window without actually sleeping.
    vi.useFakeTimers();
    try {
      mockEmbed.mockResolvedValue(null); // skip semantic for a cleaner timeout.
      const client = makeClient([]);
      const fs = await DeeplakeFs.create(client as never, "test", "/memory");
      await fs.writeFile("/memory/a.txt", "hello world"); // fallback content.

      vi.spyOn(grepCore, "searchDeeplakeTables")
        .mockImplementation(() => new Promise(() => { /* never resolves */ }));

      const cmd = createGrepCommand(client as never, fs, "test");
      const pending = cmd.execute(["hello", "/memory"], makeCtx(fs) as never);
      // Advance past the 3s timeout so the reject arrow runs, then drain
      // microtasks so the catch branch takes over and the FS fallback runs.
      await vi.advanceTimersByTimeAsync(3001);
      const result = await pending;
      // Fallback path should have kicked in and found the FS content.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello world");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables the semantic path when HIVEMIND_SEMANTIC_EMIT_ALL=false", async () => {
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValueOnce([0.1]);
    const prev = process.env.HIVEMIND_SEMANTIC_EMIT_ALL;
    process.env.HIVEMIND_SEMANTIC_EMIT_ALL = "false";
    try {
      const client = makeClient([{ path: "/memory/a.txt", content: "hello world\ngoodbye" }]);
      const fs = await DeeplakeFs.create(client as never, "test", "/memory");
      client.query.mockClear();
      client.query.mockResolvedValue([{ path: "/memory/a.txt", content: "hello world\ngoodbye" }]);

      const cmd = createGrepCommand(client as never, fs, "test");
      const result = await cmd.execute(["hello", "/memory"], makeCtx(fs) as never);

      // Refinement active → only the hello line is emitted.
      expect(result.stdout).toContain("hello world");
      expect(result.stdout).not.toContain("goodbye");
      expect(result.exitCode).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_SEMANTIC_EMIT_ALL;
      else process.env.HIVEMIND_SEMANTIC_EMIT_ALL = prev;
    }
  });
});
