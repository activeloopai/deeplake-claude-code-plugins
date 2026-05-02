import { describe, it, expect, vi } from "vitest";
import {
  buildGrepSearchOptions,
  normalizeContent,
  buildPathFilter,
  buildPathFilterForTargets,
  compileGrepRegex,
  extractRegexAlternationPrefilters,
  extractRegexLiteralPrefilter,
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

describe("normalizeContent: turn-array session shape", () => {
  const raw = JSON.stringify({
    date_time: "1:56 pm on 8 May, 2023",
    speakers: { speaker_a: "Avery", speaker_b: "Jordan" },
    turns: [
      { dia_id: "D1:1", speaker: "Avery", text: "Hey Jordan!" },
      { dia_id: "D1:2", speaker: "Jordan", text: "Hi Avery." },
    ],
  });

  it("prefixes every turn with the session date inline", () => {
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    // Date lives inline on every turn so it survives the refineGrepMatches
    // line filter — a standalone `date:` header would be stripped whenever
    // the regex didn't match the header line itself.
    expect(out).toContain("(1:56 pm on 8 May, 2023) [D1:1] Avery: Hey Jordan!");
    expect(out).toContain("(1:56 pm on 8 May, 2023) [D1:2] Jordan: Hi Avery.");
  });

  it("emits one line per turn with dia_id tag", () => {
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain("[D1:1] Avery: Hey Jordan!");
    expect(out).toContain("[D1:2] Jordan: Hi Avery.");
  });

  it("falls back gracefully on turns without speaker/text", () => {
    const weird = JSON.stringify({ turns: [{}, { speaker: "X" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", weird);
    // Must not crash; includes placeholder `?` for missing speaker
    expect(out).toContain("?: ");
    expect(out).toContain("X: ");
  });

  it("skips the date prefix when date_time is absent", () => {
    const raw = JSON.stringify({
      turns: [{ speaker: "A", text: "hi" }],
    });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    // No leading "(...)" — the turn line starts with the dia_id or speaker.
    expect(out).toContain("A: hi");
    expect(out).not.toMatch(/^\(/);
  });

  it("still emits turn lines when only one speaker is set (date still inlined)", () => {
    const raw = JSON.stringify({
      date_time: "1:56 pm on 8 May, 2023",
      turns: [{ speaker: "A", text: "hi" }],
      speakers: { speaker_a: "Alice" },
    });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain("(1:56 pm on 8 May, 2023) A: hi");
  });

  it("falls back speaker->name when speaker field is absent on a turn", () => {
    const raw = JSON.stringify({ turns: [{ name: "Avery", text: "hi" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain("Avery: hi");
  });

  it("falls back text->content when text field is absent on a turn", () => {
    const raw = JSON.stringify({ turns: [{ speaker: "X", content: "fallback" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain("X: fallback");
  });

  it("omits dia_id prefix when the turn has no dia_id", () => {
    const raw = JSON.stringify({ turns: [{ speaker: "A", text: "hi" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).toContain("A: hi");
    expect(out).not.toMatch(/\[\]/);
  });

  it("emits turns without date/speakers when both are missing", () => {
    const raw = JSON.stringify({ turns: [{ speaker: "A", text: "hi" }] });
    const out = normalizeContent("/sessions/alice/chat_1.json", raw);
    expect(out).not.toContain("date:");
    expect(out).not.toContain("speakers:");
    expect(out).toContain("A: hi");
  });

  it("returns raw when turns produce an empty serialization", () => {
    const empty = JSON.stringify({ turns: [] });
    // No header, no turns → trimmed output is empty → fallback to raw
    const out = normalizeContent("/sessions/alice/chat_1.json", empty);
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
    // Fix #4 appends `ESCAPE '\'` so sqlLike-escaped underscores (`\_`) and
    // percent signs (`\%`) in the pattern match their literal characters on
    // the Deeplake backend. Without the ESCAPE clause `\_` was treated as
    // two literal characters and `/sessions/conv_0_session_*.json`-style
    // globs silently returned zero rows.
    expect(buildPathFilter("/summaries/projects/*.md")).toBe(
      " AND path LIKE '/summaries/projects/%.md' ESCAPE '\\'",
    );
    const filter = buildPathFilter("/sessions/alice/chat_?.json");
    expect(filter).toMatch(/^ AND path LIKE '\/sessions\/alice\/chat.*\.json' ESCAPE '\\'$/);
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
  });

  it("uses a safe literal prefilter for regex scans when available", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "LIKE",
      escapedPattern: "foo.*bar",
      prefilterPattern: "foo",
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("summary::text LIKE '%foo%'");
    expect(sql).toContain("message::text LIKE '%foo%'");
  });

  it("expands alternation prefilters into OR clauses instead of literal pipes", async () => {
    const api = mockApi([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "LIKE",
      escapedPattern: "relationship|partner|married",
      prefilterPatterns: ["relationship", "partner", "married"],
    });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("summary::text LIKE '%relationship%'");
    expect(sql).toContain("summary::text LIKE '%partner%'");
    expect(sql).toContain("summary::text LIKE '%married%'");
    expect(sql).not.toContain("relationship|partner|married");
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
    expect(sql).toContain("LIMIT 100");
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

  it("normalizes session JSON before refinement (turn-array sessions)", async () => {
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
    // Only the matching turn is returned, not the whole JSON blob
    expect(out.some(l => l.includes("[D1:1] Alice: project foo update"))).toBe(true);
    expect(out.some(l => l.includes("unrelated"))).toBe(false);
  });

  it("uses contentScanOnly when pattern has regex metacharacters", async () => {
    const api = mockApi([{ path: "/a", content: "this is a test" }]);
    await grepBothTables(api, "m", "s", { ...baseParams, pattern: "t.*t" }, "/");
    const [sql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql).not.toContain("summary::text LIKE");
    expect(sql).not.toContain("message::text LIKE");
    expect(sql).not.toContain("summary::text ILIKE");
    expect(sql).not.toContain("message::text ILIKE");
  });

  it("adds a safe literal prefilter for wildcard regexes with stable anchors", async () => {
    const api = mockApi([{ path: "/a", content: "foo middle bar" }]);
    await grepBothTables(api, "m", "s", { ...baseParams, pattern: "foo.*bar" }, "/");
    const [sql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    // Default likeOp is ILIKE (case-insensitive) — buildGrepSearchOptions
    // picks it unless HIVEMIND_GREP_LIKE=case-sensitive overrides.
    expect(sql).toContain("summary::text ILIKE '%foo%'");
  });

  it("routes to ILIKE regardless of ignoreCase (case-insensitive by default)", async () => {
    const api = mockApi([]);
    await grepBothTables(api, "m", "s", { ...baseParams, ignoreCase: true }, "/");
    const [sql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql).toContain("ILIKE");
  });

  it("switches to LIKE when HIVEMIND_GREP_LIKE=case-sensitive", async () => {
    const prev = process.env.HIVEMIND_GREP_LIKE;
    process.env.HIVEMIND_GREP_LIKE = "case-sensitive";
    try {
      const api = mockApi([{ path: "/a", content: "hi" }]);
      await grepBothTables(api, "m", "s", baseParams, "/");
      const [sql] = api.query.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(sql).toContain("summary::text LIKE");
      expect(sql).not.toMatch(/summary::text ILIKE/);
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_GREP_LIKE;
      else process.env.HIVEMIND_GREP_LIKE = prev;
    }
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

  it("emits every non-empty line when a query embedding is passed (semantic mode)", async () => {
    const api = mockApi([
      { path: "/summaries/a.md", content: "foo first line\nunrelated but kept\n\ntrailing" },
    ]);
    const out = await grepBothTables(api, "m", "s", baseParams, "/", [0.1, 0.2]);
    // Semantic mode short-circuits the refinement — every non-empty line on
    // the retrieved row survives, not just the pattern-matching ones.
    expect(out).toContain("/summaries/a.md:foo first line");
    expect(out).toContain("/summaries/a.md:unrelated but kept");
    expect(out).toContain("/summaries/a.md:trailing");
  });

  it("falls back to refined output when HIVEMIND_SEMANTIC_EMIT_ALL=false even with an embedding", async () => {
    const prev = process.env.HIVEMIND_SEMANTIC_EMIT_ALL;
    process.env.HIVEMIND_SEMANTIC_EMIT_ALL = "false";
    try {
      const api = mockApi([{ path: "/a", content: "foo line\nunrelated" }]);
      const out = await grepBothTables(api, "m", "s", baseParams, "/", [0.1]);
      // Refinement ran, so only the pattern-matching line is emitted.
      expect(out.some(l => l.includes("foo line"))).toBe(true);
      expect(out.some(l => l.includes("unrelated"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_SEMANTIC_EMIT_ALL;
      else process.env.HIVEMIND_SEMANTIC_EMIT_ALL = prev;
    }
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

  it("rejects alternation containing regex char classes or anchors", () => {
    expect(extractRegexAlternationPrefilters("a|b|c[xyz]")).toBeNull();
    expect(extractRegexAlternationPrefilters("foo|^bar")).toBeNull();
    expect(extractRegexAlternationPrefilters("foo|bar$")).toBeNull();
    expect(extractRegexAlternationPrefilters("foo|(bar)")).toBeNull();
    expect(extractRegexAlternationPrefilters("foo|{1,2}")).toBeNull();
  });

  it("rejects alternation with empty branch or trailing escape", () => {
    expect(extractRegexAlternationPrefilters("foo||bar")).toBeNull();
    expect(extractRegexAlternationPrefilters("|foo|bar")).toBeNull();
    expect(extractRegexAlternationPrefilters("foo|bar|")).toBeNull();
    expect(extractRegexAlternationPrefilters("foo\\")).toBeNull();
  });

  it("returns null when every alternation branch has no usable literal", () => {
    expect(extractRegexAlternationPrefilters("a|b")).toBeNull(); // each branch < 2 chars
    expect(extractRegexAlternationPrefilters(".|.|.")).toBeNull();
  });

  it("returns null when input has no alternation pipe", () => {
    expect(extractRegexAlternationPrefilters("foobar")).toBeNull();
  });

  it("preserves escaped literals across branches", () => {
    expect(extractRegexAlternationPrefilters("foo\\.bar|baz")).toEqual(["foo.bar", "baz"]);
  });

  it("dedupes duplicate literals in alternation", () => {
    expect(extractRegexAlternationPrefilters("cat|dog|cat")).toEqual(["cat", "dog"]);
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
    expect(opts.prefilterPattern).toBe("foo");
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
    expect(opts.prefilterPatterns).toEqual(["relationship", "partner", "married"]);
  });

  it("multi-word non-regex pattern populates multiWordPatterns", () => {
    const opts = buildGrepSearchOptions({
      pattern: "pottery Melanie Caroline",
      ignoreCase: false,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/");

    expect(opts.contentScanOnly).toBe(false);
    expect(opts.multiWordPatterns).toEqual(["pottery", "Melanie", "Caroline"]);
  });

  it("single-word non-regex pattern leaves multiWordPatterns undefined", () => {
    const opts = buildGrepSearchOptions({
      pattern: "Caroline",
      ignoreCase: false,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/");

    expect(opts.contentScanOnly).toBe(false);
    expect(opts.multiWordPatterns).toBeUndefined();
  });

  it("very short tokens (<= 2 chars) are filtered out of multiWordPatterns", () => {
    const opts = buildGrepSearchOptions({
      pattern: "a by the pottery",
      ignoreCase: false,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/");

    // "a", "by" filtered; "the", "pottery" kept
    expect(opts.multiWordPatterns).toEqual(["the", "pottery"]);
  });

  it("regex pattern does not populate multiWordPatterns", () => {
    const opts = buildGrepSearchOptions({
      pattern: "foo|bar baz",
      ignoreCase: false,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/");

    expect(opts.contentScanOnly).toBe(true);
    expect(opts.multiWordPatterns).toBeUndefined();
  });

  it("more than 4 words: only first 4 survive", () => {
    const opts = buildGrepSearchOptions({
      pattern: "one two three four five six",
      ignoreCase: false,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: false,
    }, "/");

    expect(opts.multiWordPatterns).toEqual(["one", "two", "three", "four"]);
  });

  it("rejects alternation prefilters when grouping makes them unsafe", () => {
    expect(extractRegexAlternationPrefilters("(foo|bar)")).toBeNull();
    expect(extractRegexAlternationPrefilters("foo|bar.*baz")).toEqual(["foo", "bar"]);
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
    expect(opts.prefilterPattern).toBeUndefined();
    expect(opts.pathFilter).toBe(" AND path = '/summaries/alice/s1.md'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Additional coverage: single-turn JSONB shape + hybrid semantic branch
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeContent: single-turn shape { turn: {...} }", () => {
  it("emits one line with date prefix when date_time is present", () => {
    const raw = JSON.stringify({
      date_time: "8:00 pm on 20 July, 2023",
      speakers: { speaker_a: "Alice", speaker_b: "Bob" },
      turn: { dia_id: "D5:3", speaker: "Alice", text: "hello world" },
    });
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    expect(out).toBe("(8:00 pm on 20 July, 2023) [D5:3] Alice: hello world");
  });

  it("omits the date prefix when date_time is absent", () => {
    const raw = JSON.stringify({
      turn: { dia_id: "D1:1", speaker: "X", text: "y" },
    });
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    expect(out).toBe("[D1:1] X: y");
  });

  it("falls back speaker->name on a single turn", () => {
    const raw = JSON.stringify({ turn: { name: "Only", text: "hi" } });
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    expect(out).toContain("Only: hi");
  });

  it("falls back text->content on a single turn", () => {
    const raw = JSON.stringify({ turn: { speaker: "X", content: "fallback" } });
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    expect(out).toContain("X: fallback");
  });

  it("emits placeholder `?: ` when the turn payload is empty", () => {
    const raw = JSON.stringify({ turn: {} });
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    // Empty turn → "?: " (placeholder speaker, empty text). Non-empty after
    // trim so the branch emits rather than falling back to raw.
    expect(out).toBe("?: ");
  });

  it("does not treat an array value in `turn` as single-turn", () => {
    // Defensive: older per-turn shapes might mistakenly pass an array; we
    // must not enter the singular branch because .speaker / .text would be
    // undefined on the array itself.
    const raw = JSON.stringify({
      turn: [{ speaker: "X", text: "y" }],
    });
    const out = normalizeContent("/sessions/conv_0_session_1.json", raw);
    // Falls through to raw — no branch matched.
    expect(out).toBe(raw);
  });
});

describe("searchDeeplakeTables: hybrid semantic + lexical branch", () => {
  function apiWithRows(rows: Record<string, unknown>[] = []) {
    const query = vi.fn().mockResolvedValue(rows);
    return { query, api: { query } as any };
  }

  it("issues a single UNION-ALL query mixing semantic + lexical on both tables", async () => {
    const { query, api } = apiWithRows([]);
    await searchDeeplakeTables(api, "mem", "sess", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "caroline",
      queryEmbedding: [0.1, 0.2, 0.3],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("summary_embedding <#> ARRAY[0.1,0.2,0.3]::float4[]");
    expect(sql).toContain("message_embedding <#> ARRAY[0.1,0.2,0.3]::float4[]");
    expect(sql).toContain("summary::text ILIKE '%caroline%'");
    expect(sql).toContain("message::text ILIKE '%caroline%'");
    expect(sql).toContain("ORDER BY score DESC");
  });

  it("uses 1.0 sentinel on lexical sub-queries so they stay above cosine (0..1)", async () => {
    const { query, api } = apiWithRows([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "x",
      queryEmbedding: [0.5],
    });
    const sql = query.mock.calls[0][0] as string;
    // Lexical branches carry the constant score; semantic uses the real cosine.
    expect(sql).toMatch(/1\.0 AS score/);
    expect(sql).toMatch(/\(summary_embedding <#>/);
  });

  it("skips the lexical branch entirely when contentScanOnly=true and no prefilter", async () => {
    const { query, api } = apiWithRows([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "ILIKE",
      escapedPattern: "(?:unused)",
      queryEmbedding: [0.1],
    });
    const sql = query.mock.calls[0][0] as string;
    // No usable literal → only the two semantic sub-queries are unioned.
    expect(sql).not.toContain("summary::text ILIKE");
    expect(sql).not.toContain("message::text ILIKE");
    expect(sql).toContain("summary_embedding <#>");
    expect(sql).toContain("message_embedding <#>");
  });

  it("falls back to prefilterPattern for regex grep with extractable literal", async () => {
    const { query, api } = apiWithRows([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "ILIKE",
      escapedPattern: "foo.*bar",
      prefilterPattern: "foo",
      queryEmbedding: [0.1],
    });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("summary::text ILIKE '%foo%'");
  });

  it("uses prefilterPatterns alternation instead of a single prefilterPattern", async () => {
    const { query, api } = apiWithRows([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: true,
      likeOp: "ILIKE",
      escapedPattern: "a|b",
      prefilterPattern: "a",
      prefilterPatterns: ["apple", "banana"],
      queryEmbedding: [0.1],
    });
    const sql = query.mock.calls[0][0] as string;
    // prefilterPatterns wins over prefilterPattern when both are present.
    expect(sql).toContain("%apple%");
    expect(sql).toContain("%banana%");
  });

  it("dedupes rows by path, keeping the first occurrence (highest score wins)", async () => {
    const { api } = apiWithRows([
      { path: "/a", content: "sem-first" },
      { path: "/a", content: "lex-dup" },
      { path: "/b", content: "other" },
    ]);
    const out = await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "x",
      queryEmbedding: [0.5],
    });
    expect(out.map(r => r.path)).toEqual(["/a", "/b"]);
    expect(out[0].content).toBe("sem-first");
  });

  it("honors HIVEMIND_SEMANTIC_LIMIT env override for the semantic sub-queries", async () => {
    const prev = process.env.HIVEMIND_SEMANTIC_LIMIT;
    process.env.HIVEMIND_SEMANTIC_LIMIT = "7";
    try {
      const { query, api } = apiWithRows([]);
      await searchDeeplakeTables(api, "m", "s", {
        pathFilter: "",
        contentScanOnly: false,
        likeOp: "ILIKE",
        escapedPattern: "x",
        queryEmbedding: [0.5],
      });
      const sql = query.mock.calls[0][0] as string;
      // Semantic LIMIT is 7; lexical still 20 (default).
      expect(sql).toMatch(/summary_embedding <#> [^)]+\) AS score FROM "m" WHERE ARRAY_LENGTH\(summary_embedding, 1\) > 0 ORDER BY score DESC LIMIT 7/);
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_SEMANTIC_LIMIT;
      else process.env.HIVEMIND_SEMANTIC_LIMIT = prev;
    }
  });

  it("skips the semantic branch entirely when queryEmbedding is an empty array", async () => {
    const { query, api } = apiWithRows([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "x",
      queryEmbedding: [],
    });
    const sql = query.mock.calls[0][0] as string;
    // Empty embedding → falls through to the pure-lexical branch below.
    expect(sql).not.toContain("<#>");
  });

  it("skips the semantic branch when queryEmbedding is null", async () => {
    const { query, api } = apiWithRows([]);
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "x",
      queryEmbedding: null,
    });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain("<#>");
  });
});

describe("serializeFloat4Array (indirect)", () => {
  it("returns NULL when the embedding contains a non-finite value", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const api = { query } as any;
    await searchDeeplakeTables(api, "m", "s", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "ILIKE",
      escapedPattern: "x",
      queryEmbedding: [1, NaN, 0.3],
    });
    const sql = query.mock.calls[0][0] as string;
    // Both semantic sub-queries degrade to NULL scoring; Deeplake accepts it
    // and returns 0 rows for those two sub-queries so the hybrid still runs.
    expect(sql).toContain("<#> NULL");
  });
});

// `bm25Term` was scaffolding for a BM25 lexical-ranker branch that was
// dropped during the original hybrid-grep work (see commit 7b51043 — BM25
// score scale was overpowering cosine in the UNION). The field was
// destructured by `searchDeeplakeTables` but never read. Removed in the
// PR review follow-up — its tests would have locked dead code in place.
