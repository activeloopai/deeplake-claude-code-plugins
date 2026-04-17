import { describe, it, expect } from "vitest";
import {
  normalizeContent,
  buildPathFilter,
  compileGrepRegex,
  refineGrepMatches,
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
