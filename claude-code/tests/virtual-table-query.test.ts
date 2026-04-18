import { describe, expect, it, vi } from "vitest";
import {
  findVirtualPaths,
  listVirtualPathRows,
  readVirtualPathContent,
} from "../../src/hooks/virtual-table-query.js";

describe("virtual-table-query", () => {
  it("prefers a memory-table hit for exact path reads", async () => {
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([{ content: "summary body" }])
        .mockResolvedValueOnce([]),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/summaries/a.md");

    expect(content).toBe("summary body");
    expect(api.query).toHaveBeenCalledTimes(2);
  });

  it("concatenates session rows for exact path reads", async () => {
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ content: "{\"a\":1}" }, { content: "{\"b\":2}" }]),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/sessions/a.jsonl");

    expect(content).toBe("{\"a\":1}\n{\"b\":2}");
  });

  it("merges and de-duplicates rows for directory listings", async () => {
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([
          { path: "/summaries/a.md", size_bytes: 10 },
          { path: "/shared.md", size_bytes: 11 },
        ])
        .mockResolvedValueOnce([
          { path: "/sessions/a.jsonl", size_bytes: 12 },
          { path: "/shared.md", size_bytes: 13 },
        ]),
    } as any;

    const rows = await listVirtualPathRows(api, "memory", "sessions", "/");

    expect(rows).toEqual([
      { path: "/summaries/a.md", size_bytes: 10 },
      { path: "/shared.md", size_bytes: 11 },
      { path: "/sessions/a.jsonl", size_bytes: 12 },
    ]);
  });

  it("merges and de-duplicates path search results", async () => {
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([{ path: "/summaries/a.md" }, { path: "/shared.md" }])
        .mockResolvedValueOnce([{ path: "/sessions/a.jsonl" }, { path: "/shared.md" }]),
    } as any;

    const paths = await findVirtualPaths(api, "memory", "sessions", "/", "%.md");

    expect(paths).toEqual(["/summaries/a.md", "/shared.md", "/sessions/a.jsonl"]);
  });
});
