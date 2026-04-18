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

describe("bash-command-compiler parsing", () => {
  it("splits top-level sequences while respecting quotes", () => {
    expect(splitTopLevel("cat /a && echo 'x && y' ; ls /b", ["&&", ";"])).toEqual([
      "cat /a",
      "echo 'x && y'",
      "ls /b",
    ]);
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
  });

  it("expands numeric and comma brace expressions", () => {
    expect(expandBraceToken("/conv_{1..3}.md")).toEqual([
      "/conv_1.md",
      "/conv_2.md",
      "/conv_3.md",
    ]);
    expect(expandBraceToken("/file_{a,b}.md")).toEqual([
      "/file_a.md",
      "/file_b.md",
    ]);
    expect(expandBraceToken("/plain.md")).toEqual(["/plain.md"]);
    expect(expandBraceToken("/conv_{3..1}.md")).toEqual([
      "/conv_3.md",
      "/conv_2.md",
      "/conv_1.md",
    ]);
  });

  it("strips allowed stderr modifiers and detects unsupported redirection", () => {
    expect(stripAllowedModifiers("cat /a 2>/dev/null")).toEqual({
      clean: "cat /a",
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
  });

  it("rejects unsupported segments and command shapes", () => {
    expect(parseCompiledSegment("echo ok > /x")).toBeNull();
    expect(parseCompiledSegment("cat /a | jq '.x'")).toBeNull();
    expect(parseCompiledSegment("cat /a /b | wc -l")).toBeNull();
    expect(parseCompiledSegment("cat /a | head -n nope")).toBeNull();
    expect(parseCompiledSegment("find /summaries -name '*.md' | sort")).toBeNull();
    expect(parseCompiledSegment("grep foo /a | tail -2")).toBeNull();
    expect(parseCompiledBashCommand("cat /a || cat /b")).toBeNull();
    expect(parseCompiledBashCommand("cat /a && echo ok > /x")).toBeNull();
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
});
