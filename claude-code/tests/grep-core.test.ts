import { describe, it, expect, vi } from "vitest";
import {
  normalizeContent,
  buildPathFilter,
  compileGrepRegex,
  refineGrepMatches,
  searchDeeplakeTables,
  grepBothTables,
} from "../../src/shell/grep-core.js";

// ── normalizeContent ────────────────────────────────────────────────────────

describe("normalizeContent: passthrough for non-session paths", () => {
  it("leaves memory summary paths untouched", () => {
    const raw = "# summary\nSome markdown text.";
    expect(normalizeContent("/summaries/foo/abc.md", raw)).toBe(raw);
  });
  it("leaves non-JSON raw untouched", () => {
    const raw = "plain text not json";
    expect(normalizeContent("/sessions/u/x.jsonl", raw)).toBe(raw);
  });
  it("returns raw when path is empty", () => {
    expect(normalizeContent("", "{}")).toBe("{}");
  });
  it("returns raw on JSON parse failure", () => {
    const broken = "{not:valid,json";
    expect(normalizeContent("/sessions/u/x.jsonl", broken)).toBe(broken);
  });
  it("returns raw on unknown JSON shape", () => {
    const raw = JSON.stringify({ foo: "bar", baz: 1 });
    expect(normalizeContent("/sessions/u/x.jsonl", raw)).toBe(raw);
  });
});

describe("normalizeContent: LoCoMo benchmark shape", () => {
  const raw = JSON.stringify({
    date_time: "1:56 pm on 8 May, 2023",
    speakers: { speaker_a: "Caroline", speaker_b: "Melanie" },
    turns: [
      { dia_id: "D1:1", speaker: "Caroline", text: "Hey Mel!" },
      { dia_id: "D1:2", speaker: "Melanie", text: "Hi Caroline." },
    ],
  });

  it("emits date and speakers header", () => {
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    expect(out).toContain("date: 1:56 pm on 8 May, 2023");
    expect(out).toContain("speakers: Caroline, Melanie");
  });

  it("emits one line per turn with dia_id tag", () => {
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    expect(out).toContain("[D1:1] Caroline: Hey Mel!");
    expect(out).toContain("[D1:2] Melanie: Hi Caroline.");
  });

  it("falls back gracefully on turns without speaker/text", () => {
    const weird = JSON.stringify({ turns: [{}, { speaker: "X" }] });
    const out = normalizeContent("/sessions/conv_0_session_1.json", weird);
    // Must not crash; includes placeholder `?` for missing speaker
    expect(out).toContain("?: ");
    expect(out).toContain("X: ");
  });

  it("returns raw when turns produce an empty serialization", () => {
    const empty = JSON.stringify({ turns: [] });
    // No header, no turns → trimmed output is empty → fallback to raw
    const out = normalizeContent("/sessions/conv_0_session_1.json", empty);
    expect(out).toBe(empty);
  });
});

describe("normalizeContent: production user_message", () => {
  it("extracts content with [user] prefix", () => {
    const raw = JSON.stringify({ type: "user_message", content: "hello world" });
    expect(normalizeContent("/sessions/u/x.jsonl", raw)).toBe("[user] hello world");
  });

  it("returns raw when content is missing (would be bare prefix)", () => {
    const raw = JSON.stringify({ type: "user_message" });
    // output would be "[user] " → trimmed is "[user]" → safe fallback to raw
    expect(normalizeContent("/sessions/u/x.jsonl", raw)).toBe(raw);
  });
});

describe("normalizeContent: production assistant_message", () => {
  it("emits [assistant] prefix when no agent_type", () => {
    const raw = JSON.stringify({ type: "assistant_message", content: "hi" });
    expect(normalizeContent("/sessions/u/x.jsonl", raw)).toBe("[assistant] hi");
  });

  it("includes agent_type when present (SubagentStop)", () => {
    const raw = JSON.stringify({
      type: "assistant_message",
      content: "done",
      agent_type: "Explore",
    });
    expect(normalizeContent("/sessions/u/x.jsonl", raw)).toBe("[assistant (agent=Explore)] done");
  });
});

describe("normalizeContent: production tool_call", () => {
  it("Bash with stdout/stderr — extracts stdout, drops boilerplate", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Bash",
      tool_input: JSON.stringify({ command: "ls", description: "list" }),
      tool_response: JSON.stringify({
        stdout: "foo\nbar",
        stderr: "",
        interrupted: false,
        isImage: false,
      }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("[tool:Bash]");
    expect(out).toContain("command: ls");
    expect(out).toContain("foo\nbar");
    expect(out).not.toContain("interrupted");
    expect(out).not.toContain("isImage");
  });

  it("Edit collapses response to [wrote <path>]", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Edit",
      tool_input: JSON.stringify({ file_path: "/x/y.ts", old_string: "a", new_string: "b" }),
      tool_response: JSON.stringify({
        filePath: "/x/y.ts",
        oldString: "a",
        newString: "b",
        originalFile: "huge content".repeat(1000),
        structuredPatch: "diff-stuff",
      }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("[tool:Edit]");
    expect(out).toContain("file_path: /x/y.ts");
    expect(out).toContain("[wrote /x/y.ts]");
    expect(out).not.toContain("huge content");
    expect(out).not.toContain("structuredPatch");
  });

  it("TaskUpdate drops duplicated input fields from response", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "TaskUpdate",
      tool_input: JSON.stringify({ taskId: "T1", status: "completed" }),
      tool_response: JSON.stringify({
        success: true,
        taskId: "T1",
        updatedFields: ["status"],
        statusChange: { from: "pending", to: "completed" },
      }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("taskId: T1");
    // response collapses to [ok] — taskId dropped as dup, everything else in DROP set
    expect(out).toContain("response: [ok]");
  });

  it("preserves stderr when stdout is absent (error-only response)", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Bash",
      tool_input: JSON.stringify({ command: "false" }),
      tool_response: JSON.stringify({ stderr: "command failed: exit 1" }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("command failed: exit 1");
  });

  it("Read extracts file.content with filePath header", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Read",
      tool_input: JSON.stringify({ file_path: "/a/b.ts" }),
      tool_response: JSON.stringify({ type: "text", file: { filePath: "/a/b.ts", content: "line 1\nline 2" } }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("[/a/b.ts]");
    expect(out).toContain("line 1");
  });

  it("Read response with base64 binary emits length placeholder", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Read",
      tool_input: JSON.stringify({ file_path: "/a/img.png" }),
      tool_response: JSON.stringify({ type: "image", file: { filePath: "/a/img.png", base64: "AAAA" } }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("[binary /a/img.png: 4 base64 chars]");
  });

  it("Grep response with filenames[] joins paths by newline", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Grep",
      tool_input: JSON.stringify({ pattern: "foo" }),
      tool_response: JSON.stringify({ mode: "files_with_matches", filenames: ["/x.ts", "/y.ts"] }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("/x.ts\n/y.ts");
  });

  it("Grep matches[] are serialized as lines", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Grep",
      tool_input: JSON.stringify({ pattern: "foo" }),
      tool_response: JSON.stringify({ matches: ["a.ts:1:foo", "b.ts:2:foo"] }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("a.ts:1:foo");
    expect(out).toContain("b.ts:2:foo");
  });

  it("WebSearch results[] reduced to title/url per entry", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "WebSearch",
      tool_input: JSON.stringify({ query: "q" }),
      tool_response: JSON.stringify({ results: [{ title: "T1", url: "u1" }, "plain"] }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("T1");
    expect(out).toContain("plain");
  });

  it("handles camel↔snake dedup: file_path input vs filePath response", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "SomeReadLikeTool",
      tool_input: JSON.stringify({ file_path: "/a/b" }),
      tool_response: JSON.stringify({ filePath: "/a/b", extra: "kept" }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).not.toMatch(/"filePath":"\/a\/b"/); // filePath dropped as snake dup
    expect(out).toContain("kept");
  });
});

describe("normalizeContent: <recalled-memories> stripping", () => {
  it("strips a single wrapper block", () => {
    const raw = JSON.stringify({
      type: "user_message",
      content: "\n\n<recalled-memories>\npast stuff here\n</recalled-memories>\nReal prompt.",
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).not.toContain("<recalled-memories>");
    expect(out).not.toContain("past stuff here");
    expect(out).toContain("Real prompt.");
  });

  it("greedy from first open to last close handles nested duplicates", () => {
    const inner = '{"content":"\\n\\n<recalled-memories>\\n[nested1]\\n"}';
    const raw = JSON.stringify({
      type: "user_message",
      content:
        "<recalled-memories>\n[p1] " + inner + "\n[p2] " + inner + "\n</recalled-memories>\nActual message.",
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).not.toContain("<recalled-memories>");
    expect(out).not.toContain("nested1");
    expect(out).toContain("Actual message.");
  });

  it("leaves content intact when close tag is missing (malformed)", () => {
    const raw = JSON.stringify({
      type: "user_message",
      content: "<recalled-memories>\nno close\nActual message.",
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    // malformed → we leave the block alone rather than truncate
    expect(out).toContain("<recalled-memories>");
    expect(out).toContain("Actual message.");
  });
});

// ── buildPathFilter ─────────────────────────────────────────────────────────

describe("buildPathFilter", () => {
  it("returns empty string for root", () => {
    expect(buildPathFilter("/")).toBe("");
    expect(buildPathFilter("")).toBe("");
  });
  it("emits equality + prefix match for subpaths", () => {
    const f = buildPathFilter("/summaries/locomo");
    expect(f).toContain("path = '/summaries/locomo'");
    expect(f).toContain("path LIKE '/summaries/locomo/%'");
  });
  it("strips trailing slashes", () => {
    const f = buildPathFilter("/sessions///");
    expect(f).toContain("path = '/sessions'");
    expect(f).toContain("path LIKE '/sessions/%'");
  });
});

// ── compileGrepRegex ────────────────────────────────────────────────────────

describe("compileGrepRegex", () => {
  const base = { pattern: "foo", ignoreCase: false, wordMatch: false, filesOnly: false, countOnly: false, lineNumber: false, invertMatch: false, fixedString: false };

  it("returns a case-insensitive regex when ignoreCase is set", () => {
    const re = compileGrepRegex({ ...base, ignoreCase: true });
    expect(re.flags).toContain("i");
    expect(re.test("FOO")).toBe(true);
  });

  it("wraps pattern in \\b boundaries when wordMatch is set", () => {
    const re = compileGrepRegex({ ...base, wordMatch: true });
    expect(re.test("foo bar")).toBe(true);
    expect(re.test("foobar")).toBe(false);
  });

  it("escapes regex metacharacters when fixedString is set", () => {
    const re = compileGrepRegex({ ...base, pattern: "a.b*c", fixedString: true });
    expect(re.test("a.b*c")).toBe(true);
    expect(re.test("axbxc")).toBe(false);
  });

  it("falls back to an escaped literal regex on bad user input", () => {
    // `[` alone is invalid as a regex when not fixedString
    const re = compileGrepRegex({ ...base, pattern: "[unclosed" });
    expect(re.test("[unclosed")).toBe(true);
  });
});

// ── refineGrepMatches ───────────────────────────────────────────────────────

describe("refineGrepMatches", () => {
  const base = { pattern: "foo", ignoreCase: false, wordMatch: false, filesOnly: false, countOnly: false, lineNumber: false, invertMatch: false, fixedString: false };

  it("returns matching lines with path prefix when multi-file", () => {
    const out = refineGrepMatches(
      [
        { path: "/a", content: "foo\nbar" },
        { path: "/b", content: "baz\nfoo" },
      ],
      base,
    );
    expect(out).toContain("/a:foo");
    expect(out).toContain("/b:foo");
    expect(out).not.toContain("/a:bar");
  });

  it("omits path prefix for single-file result", () => {
    const out = refineGrepMatches([{ path: "/only", content: "foo\nbar" }], base);
    expect(out).toContain("foo");
    expect(out.every(l => !l.startsWith("/only:"))).toBe(true);
  });

  it("filesOnly emits each file at most once", () => {
    const out = refineGrepMatches(
      [
        { path: "/a", content: "foo\nfoo\nfoo" },
        { path: "/b", content: "foo" },
      ],
      { ...base, filesOnly: true },
    );
    expect(out).toEqual(["/a", "/b"]);
  });

  it("countOnly emits a count per file with multi-file prefix", () => {
    const out = refineGrepMatches(
      [
        { path: "/a", content: "foo\nfoo\nbar" },
        { path: "/b", content: "bar" },
      ],
      { ...base, countOnly: true },
    );
    expect(out).toContain("/a:2");
    expect(out).toContain("/b:0");
  });

  it("invertMatch returns the non-matching lines", () => {
    const out = refineGrepMatches(
      [{ path: "/a", content: "foo\nbar\nbaz" }],
      { ...base, invertMatch: true },
    );
    expect(out).toContain("bar");
    expect(out).toContain("baz");
    expect(out).not.toContain("foo");
  });

  it("lineNumber prefixes the 1-based line index", () => {
    const out = refineGrepMatches(
      [{ path: "/a", content: "xxx\nfoo\nyyy\nfoo" }],
      { ...base, lineNumber: true },
    );
    expect(out).toContain("2:foo");
    expect(out).toContain("4:foo");
  });

  // (searchDeeplakeTables + grepBothTables tests below)

  it("skips rows with empty content", () => {
    const out = refineGrepMatches(
      [
        { path: "/a", content: "" },
        { path: "/b", content: "foo" },
      ],
      base,
    );
    // multi-file prefix kicks in whenever rows.length > 1, regardless of
    // whether some rows are empty. The empty-content row is skipped, but
    // the non-empty one still gets the path prefix.
    expect(out).toEqual(["/b:foo"]);
  });
});

// ── searchDeeplakeTables ─────────────────────────────────────────────────────

describe("searchDeeplakeTables", () => {
  function mockApi(memRows: unknown[], sessRows: unknown[]) {
    const query = vi.fn()
      .mockImplementationOnce(async () => memRows)
      .mockImplementationOnce(async () => sessRows);
    return { query } as any;
  }

  it("issues one LIKE query per table with the escaped pattern and path filter", async () => {
    const api = mockApi([], []);
    await searchDeeplakeTables(api, "memory", "sessions", {
      pathFilter: " AND (path = '/x' OR path LIKE '/x/%')",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "foo",
      limit: 50,
    });
    expect(api.query).toHaveBeenCalledTimes(2);
    const [memCall, sessCall] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(memCall).toContain('FROM "memory"');
    expect(memCall).toContain("summary::text ILIKE '%foo%'");
    expect(memCall).toContain("LIMIT 50");
    expect(sessCall).toContain('FROM "sessions"');
    expect(sessCall).toContain("message::text ILIKE '%foo%'");
  });

  it("skips LIKE filter when contentScanOnly is true (regex-in-memory mode)", async () => {
    const api = mockApi([], []);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "LIKE",
      escapedPattern: "anything",
    });
    const [memCall, sessCall] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(memCall).not.toContain("LIKE");
    expect(sessCall).not.toContain("LIKE");
  });

  it("concatenates rows from both tables into {path, content}", async () => {
    const api = mockApi(
      [{ path: "/summaries/a", content: "aaa" }],
      [{ path: "/sessions/b", content: "bbb" }],
    );
    const rows = await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    });
    expect(rows).toEqual([
      { path: "/summaries/a", content: "aaa" },
      { path: "/sessions/b", content: "bbb" },
    ]);
  });

  it("tolerates null content (coerces to empty string)", async () => {
    const api = mockApi([{ path: "/a", content: null }], []);
    const rows = await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    });
    expect(rows[0]).toEqual({ path: "/a", content: "" });
  });

  it("returns partial results when one table query fails", async () => {
    const api = {
      query: vi.fn()
        .mockImplementationOnce(async () => [{ path: "/a", content: "ok" }])
        .mockImplementationOnce(async () => { throw new Error("boom"); }),
    } as any;
    const rows = await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    });
    expect(rows).toEqual([{ path: "/a", content: "ok" }]);
  });
});

// ── grepBothTables (end-to-end convenience wrapper) ─────────────────────────

describe("grepBothTables", () => {
  function mockApi(rows: unknown[]) {
    return {
      query: vi.fn()
        .mockResolvedValueOnce(rows)  // memory
        .mockResolvedValueOnce([]),   // sessions (empty in these tests)
    } as any;
  }

  const baseParams = {
    pattern: "foo", ignoreCase: false, wordMatch: false,
    filesOnly: false, countOnly: false, lineNumber: false,
    invertMatch: false, fixedString: false,
  };

  it("returns matched lines from memory rows", async () => {
    const api = mockApi([{ path: "/summaries/a", content: "foo line\nbar" }]);
    const out = await grepBothTables(api, "memory", "sessions", baseParams, "/");
    expect(out).toContain("foo line");
    expect(out).not.toContain("bar");
  });

  it("deduplicates rows by path when memory and sessions return the same path", async () => {
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([{ path: "/shared", content: "foo" }])
        .mockResolvedValueOnce([{ path: "/shared", content: "foo" }]),
    } as any;
    const out = await grepBothTables(api, "m", "s", baseParams, "/");
    // only one line for the shared path
    expect(out.length).toBe(1);
  });

  it("normalizes session JSON before refinement (LoCoMo turns)", async () => {
    const sessionContent = JSON.stringify({
      turns: [
        { dia_id: "D1:1", speaker: "Alice", text: "greeting foo here" },
        { dia_id: "D1:2", speaker: "Bob", text: "unrelated" },
      ],
    });
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ path: "/sessions/conv_0_session_1.json", content: sessionContent }]),
    } as any;
    const out = await grepBothTables(api, "m", "s", baseParams, "/");
    // Only the matching turn is returned, not the whole JSON blob
    expect(out.some(l => l.includes("[D1:1] Alice: greeting foo here"))).toBe(true);
    expect(out.some(l => l.includes("unrelated"))).toBe(false);
  });

  it("uses contentScanOnly when pattern has regex metacharacters", async () => {
    const api = mockApi([{ path: "/a", content: "this is a test" }]);
    await grepBothTables(api, "m", "s", { ...baseParams, pattern: "t.*t" }, "/");
    const [memSql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(memSql).not.toContain("ILIKE");
    expect(memSql).not.toContain("summary::text LIKE");
  });
});
