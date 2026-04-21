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
        summary: `# Session s1
- **Source**: /sessions/a/s1.jsonl
- **Date**: 2026-01-01
- **Participants**: Alice, Bob
- **Topics**: auth, retries

## Searchable Facts
- Auth tokens refresh automatically.
`,
      },
    ]);
    expect(content).toContain("# Memory Index");
    expect(content).toContain("## People");
    expect(content).toContain("## Summary To Session Catalog");
    expect(content).toContain("s1.md");
    expect(content).toContain("Alice, Bob");
    expect(content).toContain("[session](/sessions/a/s1.jsonl)");
  });

  it("builds index rows when project metadata is missing", () => {
    const content = buildVirtualIndexContent([
      {
        path: "/summaries/alice/s2.md",
      },
    ]);
    expect(content).toContain("s2.md");
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

  it("pretty-prints transcript session rows for exact path reads", async () => {
    const api = {
      query: vi.fn().mockResolvedValueOnce([
        {
          path: "/sessions/a.json",
          content: "{\"conversation_id\":0,\"session_number\":1,\"turns\":[{\"speaker\":\"Caroline\",\"text\":\"hello\"},{\"speaker\":\"Melanie\",\"text\":\"hi\"}]}",
          source_order: 1,
        },
      ]),
    } as any;

    const content = await readVirtualPathContent(api, "memory", "sessions", "/sessions/a.json");

    expect(content).toBe([
      "{",
      "  \"conversation_id\": 0,",
      "  \"session_number\": 1,",
      "  \"turns\": [",
      "    {",
      "      \"speaker\": \"Caroline\",",
      "      \"text\": \"hello\"",
      "    },",
      "    {",
      "      \"speaker\": \"Melanie\",",
      "      \"text\": \"hi\"",
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n"));
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
            summary: `# Session s1
- **Source**: /sessions/a/s1.jsonl
- **Date**: 2026-01-01
- **Participants**: Alice, Bob
`,
          },
        ])
        .mockResolvedValueOnce([]),
    } as any;

    const content = await readVirtualPathContents(api, "memory", "sessions", ["/summaries/a.md", "/index.md"]);

    expect(content.get("/summaries/a.md")).toBe("summary body");
    expect(content.get("/index.md")).toContain("# Memory Index");
    // 1 union query for exact paths + 2 parallel fallback queries (summaries + sessions) for /index.md
    expect(api.query).toHaveBeenCalledTimes(3);
  });

  it("skips memory and does not synthesize /index.md in sessions-only mode", async () => {
    const prev = process.env.HIVEMIND_SESSIONS_ONLY;
    process.env.HIVEMIND_SESSIONS_ONLY = "1";
    try {
      const api = {
        query: vi.fn().mockResolvedValueOnce([
          {
            path: "/sessions/a.json",
            content: "{\"conversation_id\":0,\"turns\":[{\"speaker\":\"Caroline\",\"text\":\"hello\"}]}",
            source_order: 1,
            creation_date: "",
          },
        ]),
      } as any;

      const content = await readVirtualPathContents(api, "memory", "sessions", ["/sessions/a.json", "/index.md"]);

      expect(content.get("/sessions/a.json")).toBe([
        "{",
        "  \"conversation_id\": 0,",
        "  \"turns\": [",
        "    {",
        "      \"speaker\": \"Caroline\",",
        "      \"text\": \"hello\"",
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"));
      expect(content.get("/index.md")).toBeNull();
      expect(api.query).toHaveBeenCalledTimes(1);
      expect(String(api.query.mock.calls[0]?.[0])).not.toContain('FROM "memory"');
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_SESSIONS_ONLY;
      else process.env.HIVEMIND_SESSIONS_ONLY = prev;
    }
  });

  it("does not synthesize /index.md when index is disabled but still reads summaries", async () => {
    const prev = process.env.HIVEMIND_DISABLE_INDEX;
    process.env.HIVEMIND_DISABLE_INDEX = "1";
    try {
      const api = {
        query: vi.fn().mockResolvedValueOnce([
          { path: "/summaries/a.md", content: "summary body", source_order: 0 },
        ]),
      } as any;

      const content = await readVirtualPathContents(api, "memory", "sessions", ["/summaries/a.md", "/index.md"]);

      expect(content.get("/summaries/a.md")).toBe("summary body");
      expect(content.get("/index.md")).toBeNull();
      expect(api.query).toHaveBeenCalledTimes(1);
      expect(String(api.query.mock.calls[0]?.[0])).not.toContain("'/index.md'");
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_DISABLE_INDEX;
      else process.env.HIVEMIND_DISABLE_INDEX = prev;
    }
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
          },
        ],
        [
          { path: "/sessions/conv_0_session_1.json", description: "session one" },
          { path: "/sessions/conv_0_session_2.json", description: "session two" },
        ],
      );

      expect(content).toContain("3 entries (1 summaries, 2 sessions):");
      expect(content).toContain("## Summaries");
      expect(content).toContain("## Sessions");
      expect(content).toContain("/summaries/alice/s1.md");
      expect(content).toContain("/sessions/conv_0_session_1.json");
      expect(content).toContain("/sessions/conv_0_session_2.json");
      // Summaries section comes before Sessions section
      expect(content.indexOf("## Summaries")).toBeLessThan(content.indexOf("## Sessions"));
    });

    it("renders only sessions when the memory table is empty (the baseline_cloud regression)", () => {
      const content = buildVirtualIndexContent(
        [],
        [
          { path: "/sessions/conv_0_session_1.json", description: "first" },
          { path: "/sessions/conv_0_session_2.json", description: "second" },
        ],
      );

      expect(content).toContain("2 entries (0 summaries, 2 sessions):");
      expect(content).toContain("## Sessions");
      expect(content).not.toContain("## Summaries");
      expect(content).toContain("/sessions/conv_0_session_1.json");
      // Guard against the old bug: must not report "0 sessions:" as the total.
      expect(content).not.toMatch(/\n0 sessions:/);
    });

    it("stays backwards-compatible when called with only summary rows", () => {
      const content = buildVirtualIndexContent([
        {
          path: "/summaries/alice/s1.md",
          project: "repo",
          description: "summary only",
          creation_date: "2026-01-01T00:00:00.000Z",
        },
      ]);

      expect(content).toContain("1 entries (1 summaries, 0 sessions):");
      expect(content).toContain("/summaries/alice/s1.md");
      expect(content).not.toContain("## Sessions");
    });

    it("produces a well-formed empty index when both tables are empty", () => {
      const content = buildVirtualIndexContent([], []);
      expect(content).toContain("# Memory Index");
      expect(content).toContain("0 entries (0 summaries, 0 sessions):");
      expect(content).not.toContain("## Summaries");
      expect(content).not.toContain("## Sessions");
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
      expect(sessionsSql).toContain('FROM "sessions"');
      expect(sessionsSql).toContain("path LIKE '/sessions/%'");

      expect(indexContent).toContain("2 entries (0 summaries, 2 sessions):");
      expect(indexContent).toContain("/sessions/conv_0_session_1.json");
      expect(indexContent).toContain("/sessions/conv_0_session_2.json");
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

      expect(indexContent).toContain("1 entries (1 summaries, 0 sessions):");
      expect(indexContent).toContain("/summaries/alice/s1.md");
    });
  });
});
