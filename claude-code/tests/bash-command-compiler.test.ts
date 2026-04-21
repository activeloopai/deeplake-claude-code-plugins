import { describe, expect, it, vi } from "vitest";
import {
  executeCompiledBashCommand,
  expandBraceToken,
  hasUnsupportedRedirection,
  parseCompiledBashCommand,
  parseCompiledSegment,
  splitTopLevel,
  stripAllowedModifiers,
  tokenizeShellWords,
} from "../../src/hooks/bash-command-compiler.js";

const originalPsqlMode = process.env.HIVEMIND_PSQL_MODE;
const originalFactsSessionsOnlyPsqlMode = process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY;

function restorePsqlMode(): void {
  if (originalPsqlMode === undefined) delete process.env.HIVEMIND_PSQL_MODE;
  else process.env.HIVEMIND_PSQL_MODE = originalPsqlMode;
  if (originalFactsSessionsOnlyPsqlMode === undefined) delete process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY;
  else process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = originalFactsSessionsOnlyPsqlMode;
}

describe("bash-command-compiler parsing", () => {
  it("splits top-level sequences while respecting quotes", () => {
    expect(splitTopLevel("cat /a && echo 'x && y' ; ls /b", ["&&", ";"])).toEqual([
      "cat /a",
      "echo 'x && y'",
      "ls /b",
    ]);
    expect(splitTopLevel(" && echo hi ; ", ["&&", ";"])).toEqual(["echo hi"]);
  });

  it("returns null on unterminated quotes", () => {
    expect(splitTopLevel("echo 'oops", ["&&"])).toBeNull();
    expect(tokenizeShellWords("echo \"oops")).toBeNull();
  });

  it("tokenizes shell words with quotes and escapes", () => {
    expect(tokenizeShellWords("echo \"hello world\" 'again' plain")).toEqual([
      "echo",
      "hello world",
      "again",
      "plain",
    ]);
    expect(tokenizeShellWords("echo \"hello \\\"world\\\"\"")).toEqual([
      "echo",
      "hello \"world\"",
    ]);
  });

  it("expands numeric and comma brace expressions", () => {
    expect(expandBraceToken("/part_{1..3}.md")).toEqual([
      "/part_1.md",
      "/part_2.md",
      "/part_3.md",
    ]);
    expect(expandBraceToken("/file_{a,b}.md")).toEqual([
      "/file_a.md",
      "/file_b.md",
    ]);
    expect(expandBraceToken("/plain.md")).toEqual(["/plain.md"]);
    expect(expandBraceToken("/part_{3..1}.md")).toEqual([
      "/part_3.md",
      "/part_2.md",
      "/part_1.md",
    ]);
  });

  it("strips allowed stderr modifiers and detects unsupported redirection", () => {
    expect(stripAllowedModifiers("cat /a 2>/dev/null")).toEqual({
      clean: "cat /a",
      ignoreMissing: true,
    });
    expect(stripAllowedModifiers("find /sessions -name '*.json' -exec grep -l 'Melanie' {} \\; 2>/dev/null | head -10")).toEqual({
      clean: "find /sessions -name '*.json' -exec grep -l 'Melanie' {} \\; | head -10",
      ignoreMissing: true,
    });
    expect(stripAllowedModifiers("cat /a 2>&1 | head -2")).toEqual({
      clean: "cat /a | head -2",
      ignoreMissing: false,
    });
    expect(hasUnsupportedRedirection("echo ok > /x")).toBe(true);
    expect(hasUnsupportedRedirection("echo '>'")).toBe(false);
  });

  it("parses supported read-only segments", () => {
    restorePsqlMode();
    expect(parseCompiledSegment("echo ---")).toEqual({ kind: "echo", text: "---" });
    expect(parseCompiledSegment("cat /a /b | head -2")).toEqual({
      kind: "cat",
      paths: ["/a", "/b"],
      lineLimit: 2,
      fromEnd: false,
      countLines: false,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("head /a")).toEqual({
      kind: "cat",
      paths: ["/a"],
      lineLimit: 10,
      fromEnd: false,
      countLines: false,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("head -2 /a")).toEqual({
      kind: "cat",
      paths: ["/a"],
      lineLimit: 2,
      fromEnd: false,
      countLines: false,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("tail -n 3 /a")).toEqual({
      kind: "cat",
      paths: ["/a"],
      lineLimit: 3,
      fromEnd: true,
      countLines: false,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("tail -2 /a")).toEqual({
      kind: "cat",
      paths: ["/a"],
      lineLimit: 2,
      fromEnd: true,
      countLines: false,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("head -n 2 /a")).toEqual({
      kind: "cat",
      paths: ["/a"],
      lineLimit: 2,
      fromEnd: false,
      countLines: false,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("wc -l /a")).toEqual({
      kind: "cat",
      paths: ["/a"],
      lineLimit: 0,
      fromEnd: false,
      countLines: true,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("cat /a | wc -l")).toEqual({
      kind: "cat",
      paths: ["/a"],
      lineLimit: 0,
      fromEnd: false,
      countLines: true,
      ignoreMissing: false,
    });
    expect(parseCompiledSegment("ls -la /summaries/{a,b}")).toEqual({
      kind: "ls",
      dirs: ["/summaries/a", "/summaries/b"],
      longFormat: true,
    });
    expect(parseCompiledSegment("ls -l")).toEqual({
      kind: "ls",
      dirs: ["/"],
      longFormat: true,
    });
    expect(parseCompiledSegment("ls -a")).toEqual({
      kind: "ls",
      dirs: ["/"],
      longFormat: false,
    });
    expect(parseCompiledSegment("find /summaries -name '*.md' | wc -l")).toEqual({
      kind: "find",
      dir: "/summaries",
      pattern: "*.md",
      countOnly: true,
    });
    expect(parseCompiledSegment("grep foo /summaries | head -5")).toEqual({
      kind: "grep",
      params: {
        pattern: "foo",
        targetPath: "/summaries",
        recursive: false,
        ignoreCase: false,
        wordMatch: false,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 5,
    });
    expect(parseCompiledSegment("grep foo /summaries | head")).toEqual({
      kind: "grep",
      params: {
        pattern: "foo",
        targetPath: "/summaries",
        recursive: false,
        ignoreCase: false,
        wordMatch: false,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 10,
    });
    expect(parseCompiledSegment("grep foo /summaries")).toEqual({
      kind: "grep",
      params: {
        pattern: "foo",
        targetPath: "/summaries",
        recursive: false,
        ignoreCase: false,
        wordMatch: false,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 0,
    });
    expect(parseCompiledSegment("find /summaries -type f -name '*.md' -o -name '*.json' | xargs grep -l 'launch' | head -5")).toEqual({
      kind: "find_grep",
      dir: "/summaries",
      patterns: ["*.md", "*.json"],
      params: {
        pattern: "launch",
        targetPath: "/",
        recursive: false,
        ignoreCase: false,
        wordMatch: false,
        filesOnly: true,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 5,
    });
    expect(parseCompiledSegment("find /summaries -type f -name '*.md' | xargs -r grep -l launch | head -1")).toEqual({
      kind: "find_grep",
      dir: "/summaries",
      patterns: ["*.md"],
      params: {
        pattern: "launch",
        targetPath: "/",
        recursive: false,
        ignoreCase: false,
        wordMatch: false,
        filesOnly: true,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 1,
    });
    expect(parseCompiledSegment("find /sessions -name '*.json' -exec grep -l 'Melanie' {} \\; 2>/dev/null | head -10")).toEqual({
      kind: "find_grep",
      dir: "/sessions",
      patterns: ["*.json"],
      params: {
        pattern: "Melanie",
        targetPath: "{}",
        recursive: false,
        ignoreCase: false,
        wordMatch: false,
        filesOnly: true,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 10,
    });
    expect(parseCompiledSegment("find /sessions -name '*.json' -exec grep -Eli 'support group|lgbtq support' {} \\; | head -10")).toEqual({
      kind: "find_grep",
      dir: "/sessions",
      patterns: ["*.json"],
      params: {
        pattern: "support group|lgbtq support",
        targetPath: "{}",
        recursive: false,
        ignoreCase: true,
        wordMatch: false,
        filesOnly: true,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 10,
    });
    expect(parseCompiledSegment("grep -i 'age\\|birthday\\|born.*19\\|born.*20' /sessions/*.json 2>/dev/null | head -3")).toEqual({
      kind: "grep",
      params: {
        pattern: "age\\|birthday\\|born.*19\\|born.*20",
        targetPath: "/sessions/*.json",
        recursive: false,
        ignoreCase: true,
        wordMatch: false,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      },
      lineLimit: 3,
    });
  });

  it("parses psql segments only when psql mode is enabled", () => {
    delete process.env.HIVEMIND_PSQL_MODE;
    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT path, summary FROM memory LIMIT 2\"")).toBeNull();

    process.env.HIVEMIND_PSQL_MODE = "1";
    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT path, summary FROM memory LIMIT 2\" | head -1")).toEqual({
      kind: "psql",
      query: "SELECT path, summary FROM memory LIMIT 2",
      lineLimit: 1,
      tuplesOnly: true,
      fieldSeparator: "|",
    });

    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT path, summary FROM hivemind.memory LIMIT 2\"")).toEqual({
      kind: "psql",
      query: "SELECT path, summary FROM hivemind.memory LIMIT 2",
      lineLimit: 0,
      tuplesOnly: true,
      fieldSeparator: "|",
    });

    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT path, creation_date, turn_index, speaker, text FROM sessions WHERE text ILIKE '%camp%' LIMIT 2\"")).toEqual({
      kind: "psql",
      query: "SELECT path, creation_date, turn_index, speaker, text FROM sessions WHERE text ILIKE '%camp%' LIMIT 2",
      lineLimit: 0,
      tuplesOnly: true,
      fieldSeparator: "|",
    });

    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT node_id, canonical_name, relation FROM graph_nodes JOIN graph_edges ON graph_edges.source_node_id = graph_nodes.node_id LIMIT 2\"")).toEqual({
      kind: "psql",
      query: "SELECT node_id, canonical_name, relation FROM graph_nodes JOIN graph_edges ON graph_edges.source_node_id = graph_nodes.node_id LIMIT 2",
      lineLimit: 0,
      tuplesOnly: true,
      fieldSeparator: "|",
    });

    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT fact_id, subject_name, predicate, object_name FROM memory_facts LIMIT 2\"")).toEqual({
      kind: "psql",
      query: "SELECT fact_id, subject_name, predicate, object_name FROM memory_facts LIMIT 2",
      lineLimit: 0,
      tuplesOnly: true,
      fieldSeparator: "|",
    });

    restorePsqlMode();
  });

  it("parses only facts-and-sessions psql segments when the mode is enabled", () => {
    process.env.HIVEMIND_PSQL_MODE = "1";
    process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = "1";

    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT path, summary FROM memory LIMIT 2\"")).toBeNull();
    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT node_id, canonical_name FROM graph_nodes LIMIT 2\"")).toBeNull();

    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT path, creation_date, turn_index, speaker, text FROM sessions WHERE text ILIKE '%camp%' LIMIT 2\"")).toEqual({
      kind: "psql",
      query: "SELECT path, creation_date, turn_index, speaker, text FROM sessions WHERE text ILIKE '%camp%' LIMIT 2",
      lineLimit: 0,
      tuplesOnly: true,
      fieldSeparator: "|",
    });

    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT fact_id, subject_name, predicate, object_name FROM memory_facts LIMIT 2\"")).toEqual({
      kind: "psql",
      query: "SELECT fact_id, subject_name, predicate, object_name FROM memory_facts LIMIT 2",
      lineLimit: 0,
      tuplesOnly: true,
      fieldSeparator: "|",
    });

    restorePsqlMode();
  });

  it("rejects unsupported segments and command shapes", () => {
    process.env.HIVEMIND_PSQL_MODE = "1";
    expect(parseCompiledSegment("cat")).toBeNull();
    expect(parseCompiledSegment("echo ok > /x")).toBeNull();
    expect(parseCompiledSegment("cat /a | jq '.x'")).toBeNull();
    expect(parseCompiledSegment("cat /a /b | wc -l")).toBeNull();
    expect(parseCompiledSegment("cat /a | head -n nope")).toBeNull();
    expect(parseCompiledSegment("head -n nope /a")).toBeNull();
    expect(parseCompiledSegment("head -n 2")).toBeNull();
    expect(parseCompiledSegment("wc -l")).toBeNull();
    expect(parseCompiledSegment("find")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' | sort")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' -o -name '*.json'")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' -o -name '*.json' | wc -l")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' | xargs")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' | xargs grep -l foo | head nope")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' | xargs -z grep -l foo")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' | xargs grep -l foo | tail -2")).toBeNull();
    expect(parseCompiledSegment("grep foo /a | tail -2")).toBeNull();
    expect(parseCompiledSegment("grep foo /a | head nope")).toBeNull();
    expect(parseCompiledSegment("psql -At -F '|' -c \"SELECT * FROM memory\" | tail -2")).toBeNull();
    expect(parseCompiledBashCommand("cat /a || cat /b")).toBeNull();
    expect(parseCompiledBashCommand("cat /a && echo ok > /x")).toBeNull();
    restorePsqlMode();
  });
});

describe("bash-command-compiler execution", () => {
  it("batches exact reads and directory listings across compound commands", async () => {
    const readVirtualPathContentsFn = vi.fn(async () => new Map([
      ["/a.md", "line1\nline2\nline3\n"],
      ["/b.md", "tail1\ntail2\n"],
    ]));
    const listVirtualPathRowsForDirsFn = vi.fn(async () => new Map([
      ["/summaries/a", [{ path: "/summaries/a/group/file1.md", size_bytes: 10 }]],
      ["/summaries/b", [{ path: "/summaries/b/file2.md", size_bytes: 20 }]],
    ]));
    const findVirtualPathsFn = vi.fn(async () => ["/summaries/a/file1.md", "/summaries/a/file2.md"]);
    const handleGrepDirectFn = vi.fn(async () => "/summaries/a/file1.md:needle\n/summaries/a/file2.md:needle");

    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "cat /{a,b}.md | head -3 && echo --- && ls -la /summaries/{a,b} && find /summaries/a -name '*.md' | wc -l && grep needle /summaries/a | head -1",
      {
        readVirtualPathContentsFn: readVirtualPathContentsFn as any,
        listVirtualPathRowsForDirsFn: listVirtualPathRowsForDirsFn as any,
        findVirtualPathsFn: findVirtualPathsFn as any,
        handleGrepDirectFn: handleGrepDirectFn as any,
      },
    );

    expect(readVirtualPathContentsFn).toHaveBeenCalledWith(expect.anything(), "memory", "sessions", ["/a.md", "/b.md"]);
    expect(listVirtualPathRowsForDirsFn).toHaveBeenCalledWith(expect.anything(), "memory", "sessions", ["/summaries/a", "/summaries/b"]);
    expect(handleGrepDirectFn).toHaveBeenCalledTimes(1);
    expect(output).toContain("line1\nline2\nline3");
    expect(output).toContain("---");
    expect(output).toContain("drwxr-xr-x");
    expect(output).toContain("group/");
    expect(output).toContain("2");
    expect(output).toContain("/summaries/a/file1.md:needle");
  });

  it("returns null when a required path is missing", async () => {
    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "cat /missing.md",
      {
        readVirtualPathContentsFn: vi.fn(async () => new Map([["/missing.md", null]])) as any,
      },
    );
    expect(output).toBeNull();
  });

  it("ignores missing files when stderr is redirected to /dev/null", async () => {
    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "cat /missing.md 2>/dev/null",
      {
        readVirtualPathContentsFn: vi.fn(async () => new Map([["/missing.md", null]])) as any,
      },
    );
    expect(output).toBe("");
  });

  it("ignores only the missing cat inputs and keeps present content", async () => {
    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "cat /missing.md /present.md 2>/dev/null",
      {
        readVirtualPathContentsFn: vi.fn(async () => new Map([
          ["/missing.md", null],
          ["/present.md", "ok"],
        ])) as any,
      },
    );
    expect(output).toBe("ok");
  });

  it("renders missing directories and supports line-counting", async () => {
    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "wc -l /a.md && ls /missing",
      {
        readVirtualPathContentsFn: vi.fn(async () => new Map([["/a.md", "x\ny\nz"]])) as any,
        listVirtualPathRowsForDirsFn: vi.fn(async () => new Map([["/missing", []]])) as any,
      },
    );
    expect(output).toContain("3 /a.md");
    expect(output).toContain("No such file or directory");
  });

  it("renders short ls output, no-match find output, and raw grep output", async () => {
    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "ls /summaries/a && find /summaries/a -name '*.txt' && grep needle /summaries/a",
      {
        listVirtualPathRowsForDirsFn: vi.fn(async () => new Map([
          ["/summaries/a", [{ path: "/summaries/a/file1.md", size_bytes: 10 }]],
        ])) as any,
        findVirtualPathsFn: vi.fn(async () => []) as any,
        handleGrepDirectFn: vi.fn(async () => "/summaries/a/file1.md:needle") as any,
      },
    );

    expect(output).toContain("file1.md");
    expect(output).toContain("(no matches)");
    expect(output).toContain("/summaries/a/file1.md:needle");
  });

  it("returns joined find results, line-limited grep, and no-match compiled find+grep output", async () => {
    const joinedFind = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "find /summaries/a -name '*.md'",
      {
        findVirtualPathsFn: vi.fn(async () => ["/summaries/a/file1.md", "/summaries/a/file2.md"]) as any,
      },
    );
    expect(joinedFind).toBe("/summaries/a/file1.md\n/summaries/a/file2.md");

    const grepLimited = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "grep needle /summaries/a | head -1",
      {
        handleGrepDirectFn: vi.fn(async () => "/summaries/a/file1.md:needle\n/summaries/a/file2.md:needle") as any,
      },
    );
    expect(grepLimited).toBe("/summaries/a/file1.md:needle");

    const noMatchFindGrep = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "find /summaries -name '*.md' | xargs grep -l launch",
      {
        findVirtualPathsFn: vi.fn(async () => []) as any,
      },
    );
    expect(noMatchFindGrep).toBe("(no matches)");
  });

  it("returns null when a compiled grep returns null", async () => {
    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "grep needle /summaries/a",
      {
        handleGrepDirectFn: vi.fn(async () => null) as any,
      },
    );
    expect(output).toBeNull();
  });

  it("executes psql queries against normalized memory and sessions table names", async () => {
    const query = vi.fn(async (sql: string) => {
      if (
        sql.includes('FROM "graph_nodes') ||
        sql.includes('FROM "graph_edges') ||
        sql.includes('FROM "memory_entities') ||
        sql.includes('FROM "memory_facts') ||
        (sql.includes('FROM "memory_actual"') && !sql.includes('JOIN "sessions_actual"'))
      ) {
        return [];
      }
      expect(sql).toContain('FROM "memory_actual"');
      expect(sql).toContain('JOIN "sessions_actual"');
      return [
        { path: "/summaries/locomo/conv_0_session_6_summary.md", summary: "Caroline keeps classic kids books" },
      ];
    });

    process.env.HIVEMIND_PSQL_MODE = "1";
    const output = await executeCompiledBashCommand(
      { query } as any,
      "memory_actual",
      "sessions_actual",
      "psql -At -F '|' -c \"SELECT m.path, m.summary FROM memory m JOIN sessions s ON s.path = m.path WHERE m.summary ILIKE '%Caroline%' LIMIT 1\"",
    );
    expect(output).toBe("/summaries/locomo/conv_0_session_6_summary.md|Caroline keeps classic kids books");
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM "memory_actual"'))).toBe(true);
    restorePsqlMode();
  });

  it("executes direct sessions queries against physical per-message rows", async () => {
    const query = vi.fn(async (sql: string) => {
      if (
        sql.includes('FROM "graph_nodes') ||
        sql.includes('FROM "graph_edges') ||
        sql.includes('FROM "memory_entities') ||
        sql.includes('FROM "memory_facts') ||
        sql.includes('FROM "memory_actual"')
      ) {
        return [];
      }
      expect(sql).toContain('FROM "sessions_actual"');
      expect(sql).toContain("WHERE path = '/sessions/conv_0_session_8.json'");
      return [
        {
          path: "/sessions/conv_0_session_8.json",
          creation_date: "2023-08-10",
          turn_index: 1,
          speaker: "Melanie",
          text: "We planned a camping trip",
        },
      ];
    });

    process.env.HIVEMIND_PSQL_MODE = "1";
    const output = await executeCompiledBashCommand(
      { query } as any,
      "memory_actual",
      "sessions_actual",
      "psql -At -F '|' -c \"SELECT path, creation_date, turn_index, speaker, text FROM sessions WHERE path = '/sessions/conv_0_session_8.json' AND text ILIKE '%camp%' ORDER BY turn_index ASC LIMIT 1\"",
    );
    expect(output).toBe("/sessions/conv_0_session_8.json|2023-08-10|1|Melanie|We planned a camping trip");
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM "sessions_actual"'))).toBe(true);
    restorePsqlMode();
  });

  it("matches psql tuples-only empty output semantics", async () => {
    process.env.HIVEMIND_PSQL_MODE = "1";
    const tuplesOnly = await executeCompiledBashCommand(
      { query: vi.fn(async () => []) } as any,
      "memory",
      "sessions",
      "psql -At -F '|' -c \"SELECT path FROM memory WHERE summary ILIKE '%missing%'\"",
    );
    expect(tuplesOnly).toBe("");

    const withHeader = await executeCompiledBashCommand(
      { query: vi.fn(async () => []) } as any,
      "memory",
      "sessions",
      "psql -F '|' -c \"SELECT path FROM memory WHERE summary ILIKE '%missing%'\"",
    );
    expect(withHeader).toBe("(0 rows)");
    restorePsqlMode();
  });

  it("does not compile unrelated psql commands and rejects invalid hivemind writes", async () => {
    process.env.HIVEMIND_PSQL_MODE = "1";
    await expect(executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "psql -At -F '|' -c \"DELETE FROM memory\"",
    )).rejects.toThrow("psql mode only supports SELECT queries");

    const unrelated = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "psql -At -F '|' -c \"SELECT * FROM users\"",
    );
    expect(unrelated).toBeNull();

    process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = "1";
    const summaryQuery = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "psql -At -F '|' -c \"SELECT * FROM memory\"",
    );
    expect(summaryQuery).toBeNull();

    restorePsqlMode();
  });

  it("executes facts-and-sessions-only psql queries without summary or graph helper queries", async () => {
    process.env.HIVEMIND_PSQL_MODE = "1";
    process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = "1";

    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toContain('FROM "memory_actual"');
      expect(sql).not.toContain('FROM "graph_nodes');
      expect(sql).not.toContain('FROM "graph_edges');
      expect(sql).not.toContain("__hm_graph_candidates");
      expect(sql).toContain('FROM "memory_facts_actual"');
      return [
        { fact_id: "f1", subject_name: "Caroline", predicate: "home_country", object_name: "Sweden" },
      ];
    });

    const output = await executeCompiledBashCommand(
      { query } as any,
      "memory_actual",
      "sessions_actual",
      "psql -At -F '|' -c \"SELECT fact_id, subject_name, predicate, object_name FROM memory_facts WHERE subject_name ILIKE '%Caroline%' LIMIT 1\"",
    );

    expect(output).toBe("f1|Caroline|home_country|Sweden");
    expect(query).toHaveBeenCalledTimes(1);
    restorePsqlMode();
  });

  it("compiles find | xargs grep -l | head into batched path reads", async () => {
    const findVirtualPathsFn = vi.fn()
      .mockResolvedValueOnce(["/summaries/a.md", "/summaries/shared.json"])
      .mockResolvedValueOnce(["/summaries/b.json", "/summaries/shared.json"]);
    const readVirtualPathContentsFn = vi.fn(async () => new Map([
      ["/summaries/a.md", "launch timeline and notes"],
      ["/summaries/shared.json", "{\"turns\":[{\"speaker\":\"Alice\",\"text\":\"launch update\"}]}"],
      ["/summaries/b.json", "No match here"],
    ]));

    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "find /summaries -type f -name '*.md' -o -name '*.json' | xargs grep -l 'launch' | head -1",
      {
        findVirtualPathsFn: findVirtualPathsFn as any,
        readVirtualPathContentsFn: readVirtualPathContentsFn as any,
      },
    );

    expect(findVirtualPathsFn).toHaveBeenCalledTimes(2);
    expect(readVirtualPathContentsFn).toHaveBeenCalledWith(
      expect.anything(),
      "memory",
      "sessions",
      ["/summaries/a.md", "/summaries/shared.json", "/summaries/b.json"],
    );
    expect(output).toBe("/summaries/a.md");
  });

  it("compiles benchmark trace find -exec grep -l pipelines into the same find_grep plan", async () => {
    const findVirtualPathsFn = vi.fn(async () => [
      "/sessions/conv_0_session_2.json",
      "/sessions/conv_0_session_5.json",
      "/sessions/conv_0_session_8.json",
    ]);
    const readVirtualPathContentsFn = vi.fn(async () => new Map([
      ["/sessions/conv_0_session_2.json", "{\"dialogue\":[{\"speaker\":\"Melanie\",\"text\":\"camping next month\"}]}"],
      ["/sessions/conv_0_session_5.json", "{\"dialogue\":[{\"speaker\":\"Caroline\",\"text\":\"book club\"}]}"],
      ["/sessions/conv_0_session_8.json", "{\"dialogue\":[{\"speaker\":\"Melanie\",\"text\":\"museum trip\"}]}"],
    ]));

    const output = await executeCompiledBashCommand(
      { query: vi.fn() } as any,
      "memory",
      "sessions",
      "find /sessions -name '*.json' -exec grep -l 'Melanie' {} \\; 2>/dev/null | head -10",
      {
        findVirtualPathsFn: findVirtualPathsFn as any,
        readVirtualPathContentsFn: readVirtualPathContentsFn as any,
      },
    );

    expect(findVirtualPathsFn).toHaveBeenCalledWith(
      expect.anything(),
      "memory",
      "sessions",
      "/sessions",
      "%.json",
    );
    expect(readVirtualPathContentsFn).toHaveBeenCalledWith(
      expect.anything(),
      "memory",
      "sessions",
      [
        "/sessions/conv_0_session_2.json",
        "/sessions/conv_0_session_5.json",
        "/sessions/conv_0_session_8.json",
      ],
    );
    expect(output).toBe("/sessions/conv_0_session_2.json\n/sessions/conv_0_session_8.json");
  });
});
