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
        last_update_date: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(content).toContain("# Session Index");
    expect(content).toContain("## memory");
    // Renderer emits a markdown table link with workspace-relative path
    expect(content).toContain("[s1](summaries/alice/s1.md)");
    expect(content).toContain("Last Updated");
  });

  it("builds index rows when project metadata is missing", () => {
    const content = buildVirtualIndexContent([
      {
        path: "/summaries/alice/s2.md",
      },
    ]);
    expect(content).toContain("[s2](summaries/alice/s2.md)");
    expect(content).toContain("# Session Index");
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

  it("normalizes session rows for exact path reads", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        { path: "/sessions/a.jsonl", content: "{\"type\":\"user_message\",\"content\":\"hello\"}", source_order: 1 },
        { path: "/sessions/a.jsonl", content: "{\"type\":\"assistant_message\",\"content\":\"hi\"}", source_order: 1 },
      ]),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/sessions/a.jsonl");

    expect(content).toBe("[user] hello\n[assistant] hi");
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
            last_update_date: "2026-01-02T00:00:00.000Z",
          },
        ])
        .mockResolvedValueOnce([]),
    } as any;

    const content = await readVirtualPathContents(api, "memory", "sessions", ["/summaries/a.md", "/index.md"]);

    expect(content.get("/summaries/a.md")).toBe("summary body");
    expect(content.get("/index.md")).toContain("# Session Index");
    expect(content.get("/index.md")).toContain("[s1](summaries/alice/s1.md)");
    // 1 union query for exact paths + 2 parallel fallback queries (summaries + sessions) for /index.md
    expect(api.query).toHaveBeenCalledTimes(3);
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

  // ── Regression coverage: /index.md must list session files too ───────────
  //
  // Bug: in workspaces where the `memory` table is empty or dropped (e.g. the
  // sessions-only `locomo_benchmark/baseline` workspace), the synthesized
  // /index.md used to report "0 sessions:" and list nothing, even when the
  // `sessions` table held hundreds of rows. Agents reading that index
  // concluded memory was empty and gave up on retrieval.

  describe("buildVirtualIndexContent: sessions + summaries", () => {
    it("renders both sections with a combined header when both tables have rows", () => {
      const content = buildVirtualIndexContent(
        [
          {
            path: "/summaries/alice/s1.md",
            project: "repo",
            description: "summary one",
            creation_date: "2026-01-01T00:00:00.000Z",
            last_update_date: "2026-01-02T00:00:00.000Z",
          },
        ],
        [
          { path: "/sessions/conv_0_session_1.json", description: "session one", creation_date: "2026-01-03", last_update_date: "2026-01-04" },
          { path: "/sessions/conv_0_session_2.json", description: "session two", creation_date: "2026-01-05", last_update_date: "2026-01-06" },
        ],
      );

      expect(content).toContain("# Session Index");
      expect(content).toContain("## memory");
      expect(content).toContain("## sessions");
      expect(content).toContain("[s1](summaries/alice/s1.md)");
      expect(content).toContain("[conv_0_session_1.json](sessions/conv_0_session_1.json)");
      expect(content).toContain("[conv_0_session_2.json](sessions/conv_0_session_2.json)");
      // memory section comes before sessions section
      expect(content.indexOf("## memory")).toBeLessThan(content.indexOf("## sessions"));
    });

    it("renders only sessions when the memory table is empty (the baseline_cloud regression)", () => {
      const content = buildVirtualIndexContent(
        [],
        [
          { path: "/sessions/conv_0_session_1.json", description: "first", creation_date: "2026-01-01", last_update_date: "2026-01-02" },
          { path: "/sessions/conv_0_session_2.json", description: "second", creation_date: "2026-01-03", last_update_date: "2026-01-04" },
        ],
      );

      // Both sections always render now (the empty-memory case shows an
      // explicit "_(empty — no summaries ingested yet)_" notice instead of
      // omitting the section). Guards against the old "0 sessions:" header
      // bug while keeping the fix for the baseline-cloud sessions-only case.
      expect(content).toContain("## memory");
      expect(content).toContain("_(empty — no summaries ingested yet)_");
      expect(content).toContain("## sessions");
      expect(content).toContain("[conv_0_session_1.json](sessions/conv_0_session_1.json)");
    });

    it("stays backwards-compatible when called with only summary rows", () => {
      const content = buildVirtualIndexContent([
        {
          path: "/summaries/alice/s1.md",
          project: "repo",
          description: "summary only",
          creation_date: "2026-01-01T00:00:00.000Z",
          last_update_date: "2026-01-02T00:00:00.000Z",
        },
      ]);

      expect(content).toContain("[s1](summaries/alice/s1.md)");
      // sessions section still emitted but reports empty
      expect(content).toContain("_(empty — no session records ingested yet)_");
    });

    it("produces a well-formed empty index when both tables are empty", () => {
      const content = buildVirtualIndexContent([], []);
      expect(content).toContain("# Session Index");
      expect(content).toContain("_(empty — no summaries ingested yet)_");
      expect(content).toContain("_(empty — no session records ingested yet)_");
    });

    it("emits the truncation notice when summary or session rows exceed the cap", () => {
      // Synthesise rows just to confirm the truncated:true branch in opts is
      // honoured by the renderer. The numbers don't matter; the notice text
      // is the regression guard.
      const content = buildVirtualIndexContent(
        [{ path: "/summaries/alice/s1.md", project: "p", description: "d", creation_date: "2026-01-01", last_update_date: "2026-01-02" }],
        [{ path: "/sessions/alice/x.jsonl", description: "d", creation_date: "2026-01-01", last_update_date: "2026-01-02" }],
        { summaryTruncated: true, sessionTruncated: true },
      );
      // Both sections show the "showing N most-recent of many" notice.
      const truncationNotices = (content.match(/most-recent of many/g) ?? []);
      expect(truncationNotices.length).toBe(2);
    });

    it("skips summary rows whose path doesn't match the /summaries/<user>/<id>.md shape", () => {
      // Defense-in-depth: if a row sneaks in with a malformed path (e.g. an
      // older write that stored the wrong shape), the renderer must skip
      // it rather than crash or emit a broken markdown link. Locks the
      // `if (!match) continue;` branch in the loop.
      const content = buildVirtualIndexContent(
        [
          { path: "/summaries/alice/good.md", project: "p", description: "d", creation_date: "2026-01-01", last_update_date: "2026-01-02" },
          { path: "/summaries/bad-shape-no-user", project: "p", description: "d", creation_date: "2026-01-01", last_update_date: "2026-01-02" },
          { path: "/totally/unrelated/path.md",  project: "p", description: "d", creation_date: "2026-01-01", last_update_date: "2026-01-02" },
        ],
        [],
      );
      expect(content).toContain("[good](summaries/alice/good.md)");
      expect(content).not.toContain("bad-shape-no-user");
      expect(content).not.toContain("totally/unrelated");
    });
  });

  describe("readVirtualPathContents: /index.md fallback queries both tables", () => {
    it("queries both memory and sessions tables in parallel when /index.md has no physical row", async () => {
      const api = {
        query: vi.fn()
          // 1. Union query for the exact-path read (no /index.md row present)
          .mockResolvedValueOnce([])
          // 2. Parallel fallback: summaries from memory (empty — baseline_cloud case)
          .mockResolvedValueOnce([])
          // 3. Parallel fallback: sessions table (272 rows)
          .mockResolvedValueOnce([
            { path: "/sessions/conv_0_session_1.json", description: "conv 0 sess 1" },
            { path: "/sessions/conv_0_session_2.json", description: "conv 0 sess 2" },
          ]),
      } as any;

      const result = await readVirtualPathContents(api, "memory", "sessions", ["/index.md"]);
      const indexContent = result.get("/index.md") ?? "";

      expect(api.query).toHaveBeenCalledTimes(3);

      const fallbackSqls = [
        String(api.query.mock.calls[1]?.[0] ?? ""),
        String(api.query.mock.calls[2]?.[0] ?? ""),
      ];
      const summarySql = fallbackSqls.find(sql => sql.includes("/summaries/%")) ?? "";
      const sessionsSql = fallbackSqls.find(sql => sql.includes("/sessions/%")) ?? "";

      expect(summarySql).toContain('FROM "memory"');
      expect(summarySql).toContain("path LIKE '/summaries/%'");
      // The fix for the index.md bottleneck: scope by recency + bound by LIMIT.
      expect(summarySql).toContain("ORDER BY last_update_date DESC");
      expect(summarySql).toMatch(/LIMIT \d+/);
      expect(summarySql).toContain("last_update_date");

      expect(sessionsSql).toContain('FROM "sessions"');
      expect(sessionsSql).toContain("path LIKE '/sessions/%'");
      // GROUP BY collapses the many-rows-per-conversation shape; ORDER BY +
      // LIMIT bound the response.
      expect(sessionsSql).toContain("GROUP BY path");
      expect(sessionsSql).toContain("ORDER BY MAX(last_update_date) DESC");
      expect(sessionsSql).toMatch(/LIMIT \d+/);

      expect(indexContent).toContain("# Session Index");
      expect(indexContent).toContain("[conv_0_session_1.json](sessions/conv_0_session_1.json)");
      expect(indexContent).toContain("[conv_0_session_2.json](sessions/conv_0_session_2.json)");
    });

    it("still produces an index when the sessions-table fallback query fails", async () => {
      const api = {
        query: vi.fn()
          .mockResolvedValueOnce([]) // union query for exact paths
          .mockResolvedValueOnce([
            {
              path: "/summaries/alice/s1.md",
              project: "repo",
              description: "summary",
              creation_date: "2026-01-01T00:00:00.000Z",
            },
          ])
          .mockRejectedValueOnce(new Error("sessions table down")),
      } as any;

      const result = await readVirtualPathContents(api, "memory", "sessions", ["/index.md"]);
      const indexContent = result.get("/index.md") ?? "";

      expect(indexContent).toContain("# Session Index");
      expect(indexContent).toContain("[s1](summaries/alice/s1.md)");
      // sessions table is down → renders the empty notice instead of crashing
      expect(indexContent).toContain("_(empty — no session records ingested yet)_");
    });
  });
});
