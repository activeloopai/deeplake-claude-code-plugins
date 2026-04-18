import { describe, expect, it, vi } from "vitest";
import {
  buildVirtualIndexContent,
  findVirtualPaths,
  listVirtualPathRowsForDirs,
  listVirtualPathRows,
  readVirtualPathContents,
  readVirtualPathContent,
} from "../../src/hooks/virtual-table-query.js";

describe("virtual-table-query", () => {
  it("builds a synthetic virtual index", () => {
    const content = buildVirtualIndexContent([
      {
        path: "/summaries/alice/s1.md",
        project: "repo",
        description: "session summary",
        creation_date: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(content).toContain("# Memory Index");
    expect(content).toContain("/summaries/alice/s1.md");
  });

  it("builds index rows when project metadata is missing", () => {
    const content = buildVirtualIndexContent([
      {
        path: "/summaries/alice/s2.md",
      },
    ]);
    expect(content).toContain("/summaries/alice/s2.md");
    expect(content).toContain("# Memory Index");
  });

  it("prefers a memory-table hit for exact path reads", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/summaries/a.md", content: "summary body", source_order: 0 },
      ]),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/summaries/a.md");

    expect(content).toBe("summary body");
    expect(api.query).toHaveBeenCalledTimes(1);
  });

  it("returns an empty map when no virtual paths are requested", async () => {
    const api = { query: vi.fn() } as any;

    const content = await readVirtualPathContents(api, "memory", "sessions", []);

    expect(content).toEqual(new Map());
    expect(api.query).not.toHaveBeenCalled();
  });

  it("concatenates session rows for exact path reads", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/sessions/a.jsonl", content: "{\"a\":1}", source_order: 1 },
        { path: "/sessions/a.jsonl", content: "{\"b\":2}", source_order: 1 },
      ]),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/sessions/a.jsonl");

    expect(content).toBe("{\"a\":1}\n{\"b\":2}");
  });

  it("reads multiple exact paths in a single query and synthesizes /index.md when needed", async () => {
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([
          { path: "/summaries/a.md", content: "summary body", source_order: 0 },
        ])
        .mockResolvedValueOnce([
          {
            path: "/summaries/alice/s1.md",
            project: "repo",
            description: "session summary",
            creation_date: "2026-01-01T00:00:00.000Z",
          },
        ]),
    } as any;

    const content = await readVirtualPathContents(api, "memory", "sessions", ["/summaries/a.md", "/index.md"]);

    expect(content.get("/summaries/a.md")).toBe("summary body");
    expect(content.get("/index.md")).toContain("# Memory Index");
    expect(api.query).toHaveBeenCalledTimes(2);
  });

  it("ignores invalid exact-read rows before merging content", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: 42, content: "bad", source_order: 0 },
        { path: "/summaries/a.md", content: 7, source_order: 0 },
        { path: "/summaries/a.md", content: "summary body", source_order: 0 },
      ]),
    } as any;

    const content = await readVirtualPathContents(api, "memory", "sessions", ["/summaries/a.md"]);

    expect(content.get("/summaries/a.md")).toBe("summary body");
  });

  it("merges and de-duplicates rows for directory listings", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/summaries/a.md", size_bytes: 10, source_order: 0 },
        { path: "/shared.md", size_bytes: 11, source_order: 0 },
        { path: "/sessions/a.jsonl", size_bytes: 12, source_order: 1 },
        { path: "/shared.md", size_bytes: 13, source_order: 1 },
      ]),
    } as any;

    const rows = await listVirtualPathRows(api, "memory", "sessions", "/");

    expect(rows).toEqual([
      { path: "/summaries/a.md", size_bytes: 10 },
      { path: "/shared.md", size_bytes: 11 },
      { path: "/sessions/a.jsonl", size_bytes: 12 },
    ]);
  });

  it("batches directory listing rows for multiple directories", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/summaries/a/file1.md", size_bytes: 10, source_order: 0 },
        { path: "/summaries/b/file2.md", size_bytes: 20, source_order: 0 },
      ]),
    } as any;

    const rows = await listVirtualPathRowsForDirs(api, "memory", "sessions", ["/summaries/a", "/summaries/b"]);

    expect(rows.get("/summaries/a")).toEqual([{ path: "/summaries/a/file1.md", size_bytes: 10 }]);
    expect(rows.get("/summaries/b")).toEqual([{ path: "/summaries/b/file2.md", size_bytes: 20 }]);
    expect(api.query).toHaveBeenCalledTimes(1);
  });

  it("lists root directories without adding a path filter and ignores invalid row paths", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/summaries/a/file1.md", size_bytes: 10, source_order: 0 },
        { path: 42, size_bytes: 20, source_order: 0 },
      ]),
    } as any;

    const rows = await listVirtualPathRowsForDirs(api, "memory", "sessions", ["/"]);

    expect(rows.get("/")).toEqual([{ path: "/summaries/a/file1.md", size_bytes: 10 }]);
    expect((api.query.mock.calls[0]?.[0] as string) ?? "").not.toContain("WHERE path LIKE");
  });

  it("merges and de-duplicates path search results", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/summaries/a.md", source_order: 0 },
        { path: "/shared.md", source_order: 0 },
        { path: "/sessions/a.jsonl", source_order: 1 },
        { path: "/shared.md", source_order: 1 },
      ]),
    } as any;

    const paths = await findVirtualPaths(api, "memory", "sessions", "/", "%.md");

    expect(paths).toEqual(["/summaries/a.md", "/shared.md", "/sessions/a.jsonl"]);
  });

  it("falls back to per-table queries when the union query fails", async () => {
    const api = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error("bad union"))
        .mockResolvedValueOnce([{ path: "/summaries/a.md", content: "summary body", source_order: 0 }])
        .mockResolvedValueOnce([]),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/summaries/a.md");

    expect(content).toBe("summary body");
    expect(api.query).toHaveBeenCalledTimes(3);
  });

  it("returns null when union and fallback queries all fail", async () => {
    const api = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error("bad union"))
        .mockRejectedValueOnce(new Error("memory down"))
        .mockRejectedValueOnce(new Error("sessions down")),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/summaries/a.md");

    expect(content).toBeNull();
    expect(api.query).toHaveBeenCalledTimes(3);
  });

  it("filters invalid paths from find results", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/summaries/a.md", source_order: 0 },
        { path: "", source_order: 0 },
        { path: 123, source_order: 1 },
      ]),
    } as any;

    const paths = await findVirtualPaths(api, "memory", "sessions", "/", "%.md");

    expect(paths).toEqual(["/summaries/a.md"]);
  });

  it("normalizes non-root find directories before building the LIKE path", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([]),
    } as any;

    await findVirtualPaths(api, "memory", "sessions", "/summaries/a///", "%.md");

    expect(String(api.query.mock.calls[0]?.[0])).toContain("path LIKE '/summaries/a/%'");
  });
});
