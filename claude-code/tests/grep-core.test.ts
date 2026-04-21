import { describe, it, expect, vi } from "vitest";
import { HarrierEmbedder } from "../../src/embeddings/harrier.js";
import {
  buildGrepSearchOptions,
  buildSummaryBm25QueryText,
  normalizeContent,
  buildPathFilter,
  buildPathFilterForTargets,
  compileGrepRegex,
  extractRegexAlternationPrefilters,
  extractRegexLiteralPrefilter,
  normalizeGrepRegexPattern,
  refineGrepMatches,
  searchDeeplakeTables,
  grepBothTables,
  toSqlRegexPattern,
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

describe("normalizeContent: transcript session shape", () => {
  const raw = JSON.stringify({
    date_time: "1:56 pm on 8 May, 2023",
    speakers: { speaker_a: "Avery", speaker_b: "Jordan" },
    turns: [
      { dia_id: "D1:1", speaker: "Avery", text: "Hey Jordan!" },
      { dia_id: "D1:2", speaker: "Jordan", text: "Hi Avery." },
    ],
  });

  it("pretty-prints transcript JSON", () => {
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
  });

  it("preserves dia_id and turn text in the raw JSON view", () => {
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain('"dia_id": "D1:1"');
    expect(out).toContain('"text": "Hey Jordan!"');
    expect(out).toContain('"speaker": "Jordan"');
  });

  it("keeps sparse turns as canonical JSON", () => {
    const weird = JSON.stringify({ turns: [{}, { speaker: "X" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", weird);
    expect(out).toBe(`${JSON.stringify(JSON.parse(weird), null, 2)}\n`);
  });

  it("preserves empty speaker metadata instead of synthesizing headers", () => {
    const raw = JSON.stringify({
      turns: [{ speaker: "A", text: "hi" }],
      speakers: { speaker_a: "", speaker_b: "" },
    });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain('"speaker_a": ""');
    expect(out).toContain('"text": "hi"');
  });

  it("preserves single-speaker metadata", () => {
    const raw = JSON.stringify({
      turns: [{ speaker: "A", text: "hi" }],
      speakers: { speaker_a: "Alice" },
    });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain('"speaker_a": "Alice"');
  });

  it("keeps alternate turn keys in the raw JSON view", () => {
    const raw = JSON.stringify({ turns: [{ name: "Avery", text: "hi" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain('"name": "Avery"');
  });

  it("keeps content fallback fields in the raw JSON view", () => {
    const raw = JSON.stringify({ turns: [{ speaker: "X", content: "fallback" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain('"content": "fallback"');
  });

  it("leaves missing dia_id fields absent", () => {
    const raw = JSON.stringify({ turns: [{ speaker: "A", text: "hi" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain('"speaker": "A"');
    expect(out).not.toContain('"dia_id"');
  });

  it("keeps transcript rows without date or speakers", () => {
    const raw = JSON.stringify({ turns: [{ speaker: "A", text: "hi" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).not.toContain("date:");
    expect(out).not.toContain("speakers:");
    expect(out).toContain('"speaker": "A"');
  });

  it("pretty-prints empty transcript arrays", () => {
    const empty = JSON.stringify({ turns: [] });
    const out = normalizeContent("/sessions/alice/chat_1.json", empty);
    expect(out).toBe(`${JSON.stringify(JSON.parse(empty), null, 2)}\n`);
  });

  it("pretty-prints dialogue-array transcripts too", () => {
    const dialogue = JSON.stringify({
      dialogue: [{ speaker: "Melanie", text: "camping next month" }],
    });
    const out = normalizeContent("/sessions/conv_0_session_2.json", dialogue);
    expect(out).toBe(`${JSON.stringify(JSON.parse(dialogue), null, 2)}\n`);
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

  it("Bash stdout with no stderr does not append stderr line", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Bash",
      tool_input: JSON.stringify({ command: "true" }),
      tool_response: JSON.stringify({ stdout: "hello", stderr: "", interrupted: false }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("hello");
    expect(out).not.toContain("stderr:");
  });

  it("extractInput falls back to JSON.stringify when no pick fields match", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "CustomTool",
      tool_input: JSON.stringify({ weird: "payload", answer: 42 }),
      tool_response: JSON.stringify({ stdout: "ok" }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain('weird');
    expect(out).toContain('answer');
  });

  it("extractInput handles scalar tool_input (not object)", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Ping",
      tool_input: "hello",
      tool_response: JSON.stringify({ stdout: "pong" }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("input: hello");
    expect(out).toContain("pong");
  });

  it("extractResponse handles scalar tool_response (not object)", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Raw",
      tool_input: JSON.stringify({ command: "x" }),
      tool_response: "just a string",
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("just a string");
  });

  it("uses '?' when tool_name is missing", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_input: JSON.stringify({ x: 1 }),
      tool_response: JSON.stringify({ stdout: "done" }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("[tool:?]");
  });

  it("generic cleanup still works when tool_input is scalar (not an object)", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "OddTool",
      tool_input: "plain string input",
      tool_response: JSON.stringify({ extra: "kept-field" }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).toContain("kept-field");
  });

  it("drops response key that is a camelCase duplicate of a snake_case input", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "Ghost",
      tool_input: JSON.stringify({ some_field: "v" }),
      tool_response: JSON.stringify({ someField: "v", keep: "yes" }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
    expect(out).not.toMatch(/"someField":"v"/);
    expect(out).toContain("keep");
  });

  it("collapses response to [ok] when every field is noise or duplicated", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool_name: "NoopTool",
      tool_input: JSON.stringify({ taskId: "T" }),
      tool_response: JSON.stringify({
        success: true,
        taskId: "T",
        interrupted: false,
        isImage: false,
      }),
    });
    const out = normalizeContent("/sessions/u/x.jsonl", raw);
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
    const f = buildPathFilter("/summaries/projects");
    expect(f).toContain("path = '/summaries/projects'");
    expect(f).toContain("path LIKE '/summaries/projects/%'");
  });
  it("strips trailing slashes", () => {
    const f = buildPathFilter("/sessions///");
    expect(f).toContain("path = '/sessions'");
    expect(f).toContain("path LIKE '/sessions/%'");
  });
  it("uses exact matching for likely file targets", () => {
    expect(buildPathFilter("/summaries/alice/s1.md")).toBe(
      " AND path = '/summaries/alice/s1.md'",
    );
  });
  it("uses LIKE matching for glob targets instead of exact file matching", () => {
    expect(buildPathFilter("/summaries/projects/*.md")).toBe(
      " AND path LIKE '/summaries/projects/%.md'",
    );
    const filter = buildPathFilter("/sessions/alice/chat_?.json");
    expect(filter).toMatch(/^ AND path LIKE '\/sessions\/alice\/chat.*\.json'$/);
  });
});

describe("buildPathFilterForTargets", () => {
  it("returns empty string when any target is root", () => {
    expect(buildPathFilterForTargets(["/summaries", "/"])).toBe("");
  });

  it("joins multiple target filters into one OR clause", () => {
    const filter = buildPathFilterForTargets([
      "/summaries/alice",
      "/sessions/bob/chat.jsonl",
    ]);
    expect(filter).toContain("path = '/summaries/alice'");
    expect(filter).toContain("path LIKE '/summaries/alice/%'");
    expect(filter).toContain("path = '/sessions/bob/chat.jsonl'");
    expect(filter).toContain(" OR ");
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

  it("fallback regex still honours ignoreCase flag", () => {
    const re = compileGrepRegex({ ...base, pattern: "[UNCLOSED", ignoreCase: true });
    expect(re.test("[unclosed")).toBe(true);
    expect(re.flags).toContain("i");
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

  it("countOnly on a single-file input omits the path prefix", () => {
    const out = refineGrepMatches(
      [{ path: "/only", content: "foo\nfoo\nbar" }],
      { ...base, countOnly: true },
    );
    expect(out).toEqual(["2"]);
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
  function mockApi(rows: unknown[]) {
    const query = vi.fn()
      .mockImplementationOnce(async () => rows);
    return { query } as any;
  }

  it("issues one UNION ALL query with the escaped pattern and path filter", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "memory", "sessions", {
      pathFilter: " AND (path = '/x' OR path LIKE '/x/%')",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "foo",
      limit: 50,
    });
    expect(api.query).toHaveBeenCalledTimes(1);
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain('FROM "memory"');
    expect(sql).toContain('FROM "sessions"');
    expect(sql).toContain("summary::text ILIKE '%foo%'");
    expect(sql).toContain("message::text ILIKE '%foo%'");
    expect(sql).toContain("LIMIT 50");
    expect(sql).toContain("UNION ALL");
  });

  it("uses text BM25 operator for summary searches before ILIKE fallback", async () => {
    const api = {
      query: vi.fn().mockImplementationOnce(async () => []),
      ensureSummaryBm25Index: vi.fn().mockResolvedValue(undefined),
    } as any;
    await searchDeeplakeTables(api, "memory", "sessions", {
      pathFilter: " AND (path = '/x' OR path LIKE '/x/%')",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "book",
      bm25QueryText: "book novel literature",
      limit: 50,
    });
    expect(api.ensureSummaryBm25Index).toHaveBeenCalledWith("memory");
    expect(api.query).toHaveBeenCalledTimes(1);
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY (summary <#> 'book novel literature') DESC");
    expect(sql).toContain('FROM "sessions"');
  });

  it("uses vector similarity on embedding columns when retrieval mode is embedding", async () => {
    const prev = process.env.HIVEMIND_GREP_RETRIEVAL_MODE;
    process.env.HIVEMIND_GREP_RETRIEVAL_MODE = "embedding";
    const embedSpy = vi.spyOn(HarrierEmbedder.prototype, "embedQueries").mockResolvedValue([[0.25, -0.5]]);
    try {
      const api = mockApi([]);
      await searchDeeplakeTables(api, "memory", "sessions", {
        pathFilter: "",
        contentScanOnly: false,
        likeOp: "ILIKE",
        escapedPattern: "book",
        queryText: "book novel literature",
        bm25QueryText: "book novel literature",
        limit: 50,
      });
      const sql = api.query.mock.calls[0][0] as string;
      expect(embedSpy).toHaveBeenCalledWith(["book novel literature"]);
      expect(sql).toContain("embedding <#> ARRAY[0.25, -0.5]::float4[]");
      expect(sql).not.toContain("summary::text ILIKE");
      expect(sql).not.toContain("message::text ILIKE");
    } finally {
      embedSpy.mockRestore();
      if (prev === undefined) delete process.env.HIVEMIND_GREP_RETRIEVAL_MODE;
      else process.env.HIVEMIND_GREP_RETRIEVAL_MODE = prev;
    }
  });

  it("runs separate lexical and vector queries then fuses them when retrieval mode is hybrid", async () => {
    const prevMode = process.env.HIVEMIND_GREP_RETRIEVAL_MODE;
    const prevVector = process.env.HIVEMIND_HYBRID_VECTOR_WEIGHT;
    const prevText = process.env.HIVEMIND_HYBRID_TEXT_WEIGHT;
    process.env.HIVEMIND_GREP_RETRIEVAL_MODE = "hybrid";
    process.env.HIVEMIND_HYBRID_VECTOR_WEIGHT = "0.6";
    process.env.HIVEMIND_HYBRID_TEXT_WEIGHT = "0.4";
    const embedSpy = vi.spyOn(HarrierEmbedder.prototype, "embedQueries").mockResolvedValue([[0.1, 0.2, 0.3]]);
    try {
      const api = {
        query: vi.fn()
          .mockResolvedValueOnce([
            { path: "/summaries/shared.md", content: "shared", source_order: 0, creation_date: "", score: 5 },
            { path: "/sessions/vector.json", content: "vector", source_order: 1, creation_date: "2024-01-01", score: 1 },
          ])
          .mockResolvedValueOnce([
            { path: "/summaries/shared.md", content: "shared", source_order: 0, creation_date: "", score: 4 },
            { path: "/sessions/text.json", content: "text", source_order: 1, creation_date: "2024-01-02", score: 3 },
          ]),
      } as any;
      const rows = await searchDeeplakeTables(api, "memory", "sessions", {
        pathFilter: "",
        contentScanOnly: false,
        likeOp: "ILIKE",
        escapedPattern: "book",
        queryText: "book novel literature",
        bm25QueryText: "book novel literature",
        limit: 50,
      });
      expect(embedSpy).toHaveBeenCalledWith(["book novel literature"]);
      expect(api.query).toHaveBeenCalledTimes(2);
      const [vectorSql, textSql] = api.query.mock.calls.map((call: unknown[]) => call[0] as string);
      expect(vectorSql).toContain("embedding <#> ARRAY[0.10000000149011612");
      expect(textSql).toContain("summary::text <#> 'book novel literature'");
      expect(textSql).toContain("message::text <#> 'book novel literature'");
      expect(vectorSql).not.toContain("deeplake_hybrid_record");
      expect(textSql).not.toContain("deeplake_hybrid_record");
      expect(rows.map((row) => row.path)).toEqual([
        "/summaries/shared.md",
        "/sessions/text.json",
        "/sessions/vector.json",
      ]);
    } finally {
      embedSpy.mockRestore();
      if (prevMode === undefined) delete process.env.HIVEMIND_GREP_RETRIEVAL_MODE;
      else process.env.HIVEMIND_GREP_RETRIEVAL_MODE = prevMode;
      if (prevVector === undefined) delete process.env.HIVEMIND_HYBRID_VECTOR_WEIGHT;
      else process.env.HIVEMIND_HYBRID_VECTOR_WEIGHT = prevVector;
      if (prevText === undefined) delete process.env.HIVEMIND_HYBRID_TEXT_WEIGHT;
      else process.env.HIVEMIND_HYBRID_TEXT_WEIGHT = prevText;
    }
  });

  it("skips LIKE filter when contentScanOnly is true (regex-in-memory mode)", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "LIKE",
      escapedPattern: "anything",
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).not.toContain("summary::text LIKE");
    expect(sql).not.toContain("message::text LIKE");
    expect(sql).not.toContain("message::text ~");
  });

  it("uses a safe literal prefilter for regex scans when available", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "LIKE",
      escapedPattern: "foo.*bar",
      regexPattern: "foo.*bar",
      prefilterPattern: "foo",
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("summary::text ~ 'foo.*bar'");
    expect(sql).toContain("message::text ~ 'foo.*bar'");
    expect(sql).toContain("LIKE '%foo%'");
  });

  it("uses regex predicates for alternation patterns instead of literal pipes", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "LIKE",
      escapedPattern: "relationship|partner|married",
      regexPattern: "relationship|partner|married",
      prefilterPatterns: ["relationship", "partner", "married"],
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("summary::text ~ 'relationship|partner|married'");
    expect(sql).toContain("message::text ~ 'relationship|partner|married'");
  });

  it("uses case-insensitive regex pushdown for ignore-case regex scans", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "ILIKE",
      escapedPattern: "relationship|partner|married",
      regexPattern: "relationship|partner|married",
      prefilterPatterns: ["relationship", "partner", "married"],
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("summary::text ILIKE '%relationship%'");
    expect(sql).toContain("summary::text ~* 'relationship|partner|married'");
    expect(sql).toContain("message::text ~* 'relationship|partner|married'");
  });

  it("uses OR ILIKE prefilters for grep BRE alternation patterns", async () => {
    const api = mockApi([]);
    const opts = buildGrepSearchOptions({
      pattern: "book\\|novel\\|literature",
      ignoreCase: true,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/");
    await searchDeeplakeTables(api, "m", "s", opts);
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY (summary <#> 'book novel literature') DESC");
    expect(sql).toContain("message::text");
    expect(sql).toContain("ILIKE '%book%'");
    expect(sql).toContain("ILIKE '%novel%'");
    expect(sql).toContain("ILIKE '%literature%'");
    expect(sql).not.toContain("ILIKE '%book|novel|literature%'");
  });

  it("pushes down escaped regex literals for invalid bracketed patterns", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: " AND path = '/index.md'",
      contentScanOnly: true,
      likeOp: "LIKE",
      escapedPattern: "^- [conv_0_session_.*\\]",
      regexPattern: "^- [conv_0_session_.*\\]",
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("path = '/index.md'");
    expect(sql).toContain("summary::text ~ '\\\\^- \\\\[conv_0_session_\\\\.\\\\*\\\\\\\\\\\\]'");
    expect(sql).toContain("message::text ~ '\\\\^- \\\\[conv_0_session_\\\\.\\\\*\\\\\\\\\\\\]'");
  });

  it("falls back to summary ILIKE when BM25 query is rejected", async () => {
    const api = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error("bm25 operator not supported"))
        .mockResolvedValueOnce([]),
      ensureSummaryBm25Index: vi.fn().mockResolvedValue(undefined),
    } as any;
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "book",
      bm25QueryText: "book novel literature",
    });
    expect(api.query).toHaveBeenCalledTimes(2);
    const fallbackSql = api.query.mock.calls[1][0] as string;
    expect(fallbackSql).toContain("summary::text ILIKE '%book%'");
    expect(fallbackSql).not.toContain("<#>");
  });

  it("concatenates rows from both tables into {path, content}", async () => {
    const api = mockApi([
      { path: "/summaries/a", content: "aaa" },
      { path: "/sessions/b", content: "bbb" },
    ]);
    const rows = await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    });
    expect(rows).toEqual([
      { path: "/summaries/a", content: "aaa" },
      { path: "/sessions/b", content: "bbb" },
    ]);
  });

  it("tolerates null content on memory row (coerces to empty string)", async () => {
    const api = mockApi([{ path: "/a", content: null }]);
    const rows = await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    });
    expect(rows[0]).toEqual({ path: "/a", content: "" });
  });

  it("tolerates null content on sessions row too", async () => {
    const api = mockApi([{ path: "/b", content: null }]);
    const rows = await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    });
    expect(rows[0]).toEqual({ path: "/b", content: "" });
  });

  it("keeps grep on a single SQL query when the union query fails", async () => {
    const api = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error("bad union"))
        .mockRejectedValueOnce(new Error("bad union")),
    } as any;
    await expect(searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    })).rejects.toThrow("bad union");
    expect(api.query).toHaveBeenCalledTimes(1);
  });

  it("defaults limit to 100 when omitted", async () => {
    const api = { query: vi.fn().mockResolvedValue([]) } as any;
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "x",
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("LIMIT 500");
  });

  it("queries only the sessions table in sessions-only mode", async () => {
    const prev = process.env.HIVEMIND_SESSIONS_ONLY;
    process.env.HIVEMIND_SESSIONS_ONLY = "1";
    try {
      const api = { query: vi.fn().mockResolvedValue([]) } as any;
      await searchDeeplakeTables(api, "m", "s", {
        pathFilter: "", contentScanOnly: false, likeOp: "ILIKE", escapedPattern: "foo",
      });
      const sql = api.query.mock.calls[0][0] as string;
      expect(sql).not.toContain('FROM "m"');
      expect(sql).toContain('FROM "s"');
      expect(sql).not.toContain("UNION ALL");
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_SESSIONS_ONLY;
      else process.env.HIVEMIND_SESSIONS_ONLY = prev;
    }
  });
});

// ── grepBothTables (end-to-end convenience wrapper) ─────────────────────────

describe("grepBothTables", () => {
  function mockApi(rows: unknown[]) {
    return {
      query: vi.fn()
        .mockResolvedValueOnce(rows),
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
        .mockResolvedValueOnce([{ path: "/shared", content: "foo" }, { path: "/shared", content: "foo" }]),
    } as any;
    const out = await grepBothTables(api, "m", "s", baseParams, "/");
    // only one line for the shared path
    expect(out.length).toBe(1);
  });

  it("greps against canonical raw JSON for transcript sessions", async () => {
    const sessionContent = JSON.stringify({
      turns: [
        { dia_id: "D1:1", speaker: "Alice", text: "project foo update" },
        { dia_id: "D1:2", speaker: "Bob", text: "unrelated" },
      ],
    });
    const api = {
      query: vi.fn()
        .mockResolvedValueOnce([{ path: "/sessions/alice/chat_1.json", content: sessionContent }]),
    } as any;
    const out = await grepBothTables(api, "m", "s", baseParams, "/");
    expect(out.some(l => l.includes('"text": "project foo update"'))).toBe(true);
    expect(out.some(l => l.includes("unrelated"))).toBe(false);
  });

  it("uses contentScanOnly when pattern has regex metacharacters", async () => {
    const api = mockApi([{ path: "/a", content: "this is a test" }]);
    await grepBothTables(api, "m", "s", { ...baseParams, pattern: "t.*t" }, "/");
    const [sql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql).not.toContain("summary::text LIKE");
    expect(sql).not.toContain("message::text LIKE");
  });

  it("adds a safe literal prefilter for wildcard regexes with stable anchors", async () => {
    const api = mockApi([{ path: "/a", content: "foo middle bar" }]);
    await grepBothTables(api, "m", "s", { ...baseParams, pattern: "foo.*bar" }, "/");
    const [sql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql).toContain("ORDER BY (summary <#> 'foo') DESC");
    expect(sql).toContain("message::text LIKE '%foo%'");
  });

  it("routes to ILIKE when ignoreCase is set", async () => {
    const api = mockApi([]);
    await grepBothTables(api, "m", "s", { ...baseParams, ignoreCase: true }, "/");
    const [sql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql).toContain("ILIKE");
  });

  it("uses a single union query even for scoped target paths", async () => {
    const api = mockApi([{ path: "/summaries/a.md", content: "foo line" }]);
    await grepBothTables(api, "memory", "sessions", baseParams, "/summaries");
    expect(api.query).toHaveBeenCalledTimes(1);
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain('FROM "memory"');
    expect(sql).toContain('FROM "sessions"');
    expect(sql).toContain("UNION ALL");
  });
});

describe("regex literal prefilter", () => {
  it("returns null for an empty pattern", () => {
    expect(extractRegexLiteralPrefilter("")).toBeNull();
  });

  it("extracts a literal from simple wildcard regexes", () => {
    expect(extractRegexLiteralPrefilter("foo.*bar")).toBe("foo");
    expect(extractRegexLiteralPrefilter("prefix.*suffix")).toBe("prefix");
    expect(extractRegexLiteralPrefilter("x.*suffix")).toBe("suffix");
  });

  it("returns null for complex regex features", () => {
    expect(extractRegexLiteralPrefilter("colou?r")).toBeNull();
    expect(extractRegexLiteralPrefilter("foo|bar")).toBeNull();
    expect(extractRegexLiteralPrefilter("[ab]foo")).toBeNull();
  });

  it("handles escaped literals and rejects dangling escapes or bare dots", () => {
    expect(extractRegexLiteralPrefilter("foo\\.bar")).toBe("foo.bar");
    expect(extractRegexLiteralPrefilter("\\d+foo")).toBeNull();
    expect(extractRegexLiteralPrefilter("foo\\")).toBeNull();
    expect(extractRegexLiteralPrefilter("foo.bar")).toBeNull();
  });

  it("builds grep search options with regex prefilter when safe", () => {
    const opts = buildGrepSearchOptions({
      pattern: "foo.*bar",
      ignoreCase: true,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/summaries");

    expect(opts.contentScanOnly).toBe(true);
    expect(opts.likeOp).toBe("ILIKE");
    expect(opts.regexPattern).toBe("foo.*bar");
    expect(opts.prefilterPattern).toBe("foo");
    expect(opts.bm25QueryText).toBe("foo");
    expect(opts.pathFilter).toContain("/summaries");
  });

  it("extracts safe alternation anchors and carries them into grep search options", () => {
    expect(extractRegexAlternationPrefilters("relationship|partner|married")).toEqual([
      "relationship",
      "partner",
      "married",
    ]);

    const opts = buildGrepSearchOptions({
      pattern: "relationship|partner|married",
      ignoreCase: false,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/summaries");

    expect(opts.contentScanOnly).toBe(true);
    expect(opts.regexPattern).toBe("relationship|partner|married");
    expect(opts.prefilterPatterns).toEqual(["relationship", "partner", "married"]);
    expect(opts.bm25QueryText).toBe("relationship partner married");
  });

  it("unwraps simple grouping around alternations", () => {
    expect(extractRegexAlternationPrefilters("(foo|bar)")).toEqual(["foo", "bar"]);
    expect(extractRegexAlternationPrefilters("(?:foo|bar)")).toEqual(["foo", "bar"]);
  });

  it("normalizes grep BRE alternation before building search options", () => {
    expect(normalizeGrepRegexPattern("book\\|novel\\|literature")).toBe("book|novel|literature");

    const opts = buildGrepSearchOptions({
      pattern: "book\\|novel\\|literature",
      ignoreCase: true,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/summaries");

    expect(opts.contentScanOnly).toBe(true);
    expect(opts.regexPattern).toBe("book|novel|literature");
    expect(opts.prefilterPatterns).toEqual(["book", "novel", "literature"]);
    expect(opts.bm25QueryText).toBe("book novel literature");
  });

  it("rejects alternation prefilters when grouping makes them unsafe", () => {
    expect(extractRegexAlternationPrefilters("foo|bar.*baz")).toEqual(["foo", "bar"]);
  });

  it("extracts literals through word-boundary escapes", () => {
    expect(extractRegexLiteralPrefilter("\\bcountry\\b")).toBe("country");
  });

  it("preserves escaped alternation characters inside a literal branch", () => {
    expect(extractRegexAlternationPrefilters("foo\\|bar|baz")).toEqual(["foo|bar", "baz"]);
    expect(extractRegexAlternationPrefilters("foo|bar\\.md")).toEqual(["foo", "bar.md"]);
  });

  it("keeps fixed-string searches on the SQL-filtered path even with regex metacharacters", () => {
    const opts = buildGrepSearchOptions({
      pattern: "foo.*bar",
      ignoreCase: false,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: true,
    }, "/summaries/alice/s1.md");

    expect(opts.contentScanOnly).toBe(false);
    expect(opts.regexPattern).toBeUndefined();
    expect(opts.prefilterPattern).toBeUndefined();
    expect(opts.bm25QueryText).toBe("foo bar");
    expect(opts.pathFilter).toBe(" AND path = '/summaries/alice/s1.md'");
  });

  it("builds BM25 query text from regex literals conservatively", () => {
    expect(buildSummaryBm25QueryText("home country", false, null, null)).toBe("home country");
    expect(buildSummaryBm25QueryText("book|novel|literature", false, null, ["book", "novel", "literature"])).toBe("book novel literature");
    expect(buildSummaryBm25QueryText(".*", false, null, null)).toBeNull();
  });

  it("builds SQL-safe regex patterns conservatively", () => {
    expect(toSqlRegexPattern("foo.*bar", false)).toBe("foo.*bar");
    expect(toSqlRegexPattern("foo.*bar", true)).toBe("foo.*bar");
    expect(toSqlRegexPattern("^- [conv_0_session_.*\\]", false)).toBe("\\^- \\[conv_0_session_\\.\\*\\\\\\]");
    expect(toSqlRegexPattern("\\bitem\\d+", false)).toBe("\\yitem[[:digit:]]+");
    expect(toSqlRegexPattern("foo(?=bar)", false)).toBeNull();
  });

  it("compiles grep BRE alternation as real alternation", () => {
    const re = compileGrepRegex({
      pattern: "book\\|novel\\|literature",
      ignoreCase: true,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    });

    expect(re.test("She loves literature")).toBe(true);
    expect(re.test("A novel inspired her")).toBe(true);
    expect(re.test("No match here")).toBe(false);
  });

  describe("benchmark parity", () => {
    function mockQueryRows(rows: { path: string; content: string }[]) {
      return { query: vi.fn().mockResolvedValueOnce(rows) } as any;
    }

    async function runParityCase(
      rows: { path: string; content: string }[],
      params: {
        pattern: string;
        ignoreCase: boolean;
        wordMatch: boolean;
        filesOnly: boolean;
        countOnly: boolean;
        lineNumber: boolean;
        invertMatch: boolean;
        fixedString: boolean;
      },
      targetPath = "/",
    ) {
      const api = mockQueryRows(rows);
      const remote = await grepBothTables(api, "memory", "sessions", params, targetPath);
      const local = refineGrepMatches(
        rows.map((row) => ({ path: row.path, content: normalizeContent(row.path, row.content) })),
        params,
      );
      return { api, remote, local };
    }

    it("matches local grep for LoCoMo-style relationship status lookups", async () => {
      const rows = [
        {
          path: "/summaries/locomo/conv_0_session_3_summary.md",
          content: "## Searchable Facts\n- Relationship status: Single.\n- Caroline is researching adoption agencies.\n",
        },
        {
          path: "/sessions/conv_0_session_3.json",
          content: JSON.stringify({
            turns: [
              { dia_id: "D1:1", speaker: "Caroline", text: "I'm single and still planning to adopt on my own." },
              { dia_id: "D1:2", speaker: "Melanie", text: "That sounds like a good plan." },
            ],
          }),
        },
      ];

      const params = {
        pattern: "single",
        ignoreCase: true,
        wordMatch: true,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      };

      const { api, remote, local } = await runParityCase(rows, params, "/summaries");
      expect(remote).toEqual(local);
      const sql = api.query.mock.calls[0][0] as string;
      expect(sql).toContain("ORDER BY (summary <#> 'single') DESC");
      expect(sql).toContain("message::text ILIKE '%single%'");
    });

    it("matches local grep for LoCoMo-style title and reading mentions", async () => {
      const rows = [
        {
          path: "/sessions/conv_0_session_6.json",
          content: JSON.stringify({
            turns: [
              { dia_id: "D6:1", speaker: "Melanie", text: "Charlotte's Web was my favorite book as a kid." },
              { dia_id: "D6:2", speaker: "Caroline", text: "I can recommend another book if you want." },
            ],
          }),
        },
      ];

      const params = {
        pattern: "Charlotte\\|book",
        ignoreCase: true,
        wordMatch: false,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      };

      const { api, remote, local } = await runParityCase(rows, params, "/sessions");
      expect(remote).toEqual(local);
      expect(remote.some((line) => line.includes("Charlotte's Web"))).toBe(true);
      const sql = api.query.mock.calls[0][0] as string;
      expect(sql).toContain("ILIKE '%Charlotte%'");
      expect(sql).toContain("ILIKE '%book%'");
    });

    it("matches local grep for LoCoMo-style relative-time phrases", async () => {
      const rows = [
        {
          path: "/sessions/conv_0_session_12.json",
          content: JSON.stringify({
            turns: [
              { dia_id: "D12:1", speaker: "Caroline", text: "A friend made it for my 18th birthday ten years ago." },
              { dia_id: "D12:2", speaker: "Melanie", text: "That's really thoughtful." },
            ],
          }),
        },
      ];

      const params = {
        pattern: "ten years ago",
        ignoreCase: true,
        wordMatch: false,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      };

      const { api, remote, local } = await runParityCase(rows, params, "/sessions");
      expect(remote).toEqual(local);
      const sql = api.query.mock.calls[0][0] as string;
      expect(sql).toContain("message::text ILIKE '%ten years ago%'");
    });

    it("uses SQL regex pushdown for bracket-anchored patterns and matches the raw-json local output", async () => {
      const rows = [
        {
          path: "/sessions/conv_0_session_2.json",
          content: JSON.stringify({
            turns: [
              { dia_id: "D2:1", speaker: "Melanie", text: "We're thinking about going camping next month." },
              { dia_id: "D2:2", speaker: "Caroline", text: "That should be fun." },
            ],
          }),
        },
      ];

      const params = {
        pattern: "^\\[D2:1\\]",
        ignoreCase: false,
        wordMatch: false,
        filesOnly: false,
        countOnly: false,
        lineNumber: false,
        invertMatch: false,
        fixedString: false,
      };

      const { api, remote, local } = await runParityCase(rows, params, "/sessions");
      expect(remote).toEqual(local);
      expect(remote).toEqual([]);
      const sql = api.query.mock.calls[0][0] as string;
      expect(sql).toContain("ORDER BY (summary <#> 'D2:1') DESC");
      expect(sql).toContain("message::text ~ '^\\\\[D2:1\\\\]'");
    });
  });

  it("compiles word-boundary alternation with grouping", () => {
    const re = compileGrepRegex({
      pattern: "book\\|novel",
      ignoreCase: true,
      wordMatch: true,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    });

    expect(re.test("book club")).toBe(true);
    expect(re.test("graphic novel")).toBe(true);
    expect(re.test("storybook")).toBe(false);
  });
});
