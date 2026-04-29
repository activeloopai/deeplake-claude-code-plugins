import { describe, it, expect, vi } from "vitest";

// The tests in this file exercise the *lexical* path of handleGrepDirect.
// Without this mock, the real EmbedClient would try to spawn / reach the
// nomic embed daemon over a Unix socket. If the daemon happens to be up
// (e.g. from a previous benchmark run), the semantic branch fires and
// returns a different shape, breaking every line-oriented assertion here.
// The mock forces queryEmbedding to stay null so the lexical refine path
// runs deterministically.
vi.mock("../../src/embeddings/client.js", () => ({
  EmbedClient: class {
    async embed() { return null; }
    async warmup() { return false; }
  },
}));

import { parseBashGrep, handleGrepDirect, type GrepParams } from "../../src/hooks/grep-direct.js";

describe("handleGrepDirect", () => {
  const baseParams: GrepParams = {
    pattern: "foo", targetPath: "/",
    ignoreCase: false, wordMatch: false, filesOnly: false, countOnly: false,
    lineNumber: false, invertMatch: false, fixedString: false,
  };

  function mockApi(rows: unknown[]) {
    return {
      query: vi.fn().mockImplementationOnce(async () => rows),
    } as any;
  }

  it("returns null when pattern is empty", async () => {
    const api = mockApi([]);
    const r = await handleGrepDirect(api, "memory", "sessions", { ...baseParams, pattern: "" });
    expect(r).toBeNull();
    expect(api.query).not.toHaveBeenCalled();
  });

  it("delegates to grepBothTables and joins the match lines", async () => {
    const api = mockApi(
      [{ path: "/summaries/a.md", content: "foo line here\nbar line" }],
    );
    const r = await handleGrepDirect(api, "memory", "sessions", baseParams);
    expect(r).toBe("foo line here");
  });

  it("emits '(no matches)' when both tables return nothing", async () => {
    const api = mockApi([]);
    const r = await handleGrepDirect(api, "memory", "sessions", baseParams);
    expect(r).toBe("(no matches)");
  });

  it("merges results from both memory and sessions", async () => {
    const api = mockApi([
      { path: "/summaries/a.md", content: "foo in summary" },
      { path: "/sessions/b.jsonl", content: "foo in session" },
    ]);
    const r = await handleGrepDirect(api, "memory", "sessions", baseParams);
    expect(r).toContain("/summaries/a.md:foo in summary");
    expect(r).toContain("/sessions/b.jsonl:foo in session");
  });

  it("applies ignoreCase flag at SQL level (ILIKE)", async () => {
    const api = mockApi([{ path: "/a", content: "Foo" }]);
    await handleGrepDirect(api, "memory", "sessions", { ...baseParams, ignoreCase: true });
    const sql = api.query.mock.calls[0][0] as string;
    expect(sql).toContain("ILIKE");
  });
});

describe("parseBashGrep: long options", () => {
  // Exercises every --long-option handler so the arrow-fn table inside
  // parseBashGrep is fully covered.

  it("--ignore-case", () => {
    const r = parseBashGrep("grep --ignore-case foo /x");
    expect(r!.ignoreCase).toBe(true);
  });
  it("--word-regexp", () => {
    const r = parseBashGrep("grep --word-regexp foo /x");
    expect(r!.wordMatch).toBe(true);
  });
  it("--files-with-matches", () => {
    const r = parseBashGrep("grep --files-with-matches foo /x");
    expect(r!.filesOnly).toBe(true);
  });
  it("--count", () => {
    const r = parseBashGrep("grep --count foo /x");
    expect(r!.countOnly).toBe(true);
  });
  it("--line-number", () => {
    const r = parseBashGrep("grep --line-number foo /x");
    expect(r!.lineNumber).toBe(true);
  });
  it("--invert-match", () => {
    const r = parseBashGrep("grep --invert-match foo /x");
    expect(r!.invertMatch).toBe(true);
  });
  it("--fixed-strings", () => {
    const r = parseBashGrep("grep --fixed-strings foo /x");
    expect(r!.fixedString).toBe(true);
  });
  it("unknown --long option is a no-op (does not crash)", () => {
    const r = parseBashGrep("grep --unknown-flag foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
  });

  it("accepts grep no-op long options that take inline numeric values", () => {
    const r = parseBashGrep("grep --after-context=2 --before-context=3 --context=4 --max-count=1 foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
    expect(r!.targetPath).toBe("/x");
  });
});


describe("parseBashGrep", () => {
  // ── Basic parsing ──

  it("parses simple grep", () => {
    const r = parseBashGrep("grep 'sasun' /summaries");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("sasun");
    expect(r!.targetPath).toBe("/summaries");
  });

  it("parses grep without quotes", () => {
    const r = parseBashGrep("grep sasun /summaries");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("sasun");
  });

  it("parses grep with double quotes", () => {
    const r = parseBashGrep('grep "sasun" /summaries');
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("sasun");
  });

  it("defaults targetPath to / when no path given", () => {
    const r = parseBashGrep("grep 'pattern'");
    expect(r).not.toBeNull();
    expect(r!.targetPath).toBe("/");
  });

  it("normalizes . and ./ to /", () => {
    expect(parseBashGrep("grep 'pat' .")!.targetPath).toBe("/");
    expect(parseBashGrep("grep 'pat' ./")!.targetPath).toBe("/");
  });

  it("returns null for non-grep commands", () => {
    expect(parseBashGrep("cat /file")).toBeNull();
    expect(parseBashGrep("ls /dir")).toBeNull();
    expect(parseBashGrep("echo hello")).toBeNull();
  });

  it("returns null when no pattern given", () => {
    expect(parseBashGrep("grep")).toBeNull();
    expect(parseBashGrep("grep -r")).toBeNull();
  });

  it("returns null for unterminated quoted commands", () => {
    expect(parseBashGrep('grep "unterminated /dir')).toBeNull();
  });

  // ── Flag parsing ──

  it("parses -i flag", () => {
    const r = parseBashGrep("grep -i 'pattern' /dir");
    expect(r!.ignoreCase).toBe(true);
  });

  it("parses -w flag", () => {
    const r = parseBashGrep("grep -w 'pattern' /dir");
    expect(r!.wordMatch).toBe(true);
  });

  it("parses -l flag", () => {
    const r = parseBashGrep("grep -l 'pattern' /dir");
    expect(r!.filesOnly).toBe(true);
  });

  it("parses -c flag", () => {
    const r = parseBashGrep("grep -c 'pattern' /dir");
    expect(r!.countOnly).toBe(true);
  });

  it("parses -n flag", () => {
    const r = parseBashGrep("grep -n 'pattern' /dir");
    expect(r!.lineNumber).toBe(true);
  });

  it("parses -v flag", () => {
    const r = parseBashGrep("grep -v 'pattern' /dir");
    expect(r!.invertMatch).toBe(true);
  });

  it("parses -F flag", () => {
    const r = parseBashGrep("grep -F 'pattern' /dir");
    expect(r!.fixedString).toBe(true);
  });

  it("parses combined flags -ri", () => {
    const r = parseBashGrep("grep -ri 'pattern' /dir");
    expect(r!.ignoreCase).toBe(true);
    // -r is no-op (recursive implied)
  });

  it("parses combined flags -wni", () => {
    const r = parseBashGrep("grep -wni 'pattern' /dir");
    expect(r!.wordMatch).toBe(true);
    expect(r!.lineNumber).toBe(true);
    expect(r!.ignoreCase).toBe(true);
  });

  it("parses -rl flags", () => {
    const r = parseBashGrep("grep -rl 'pattern' /dir");
    expect(r!.filesOnly).toBe(true);
  });

  // ── Variants ──

  it("parses egrep", () => {
    const r = parseBashGrep("egrep 'pattern' /dir");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("pattern");
  });

  it("parses fgrep as fixed-string", () => {
    const r = parseBashGrep("fgrep 'pattern' /dir");
    expect(r!.fixedString).toBe(true);
  });

  it("parses long options", () => {
    const r = parseBashGrep("grep --ignore-case --word-regexp 'pat' /dir");
    expect(r!.ignoreCase).toBe(true);
    expect(r!.wordMatch).toBe(true);
  });

  it("handles -- separator", () => {
    const r = parseBashGrep("grep -- '-pattern' /dir");
    expect(r!.pattern).toBe("-pattern");
  });

  // ── Piped commands (only first command parsed) ──

  it("parses first command in pipe", () => {
    const r = parseBashGrep("grep 'pattern' /dir | head -5");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("pattern");
    expect(r!.targetPath).toBe("/dir");
  });

  it("does not split on alternation pipes inside quotes", () => {
    const r = parseBashGrep("grep 'book|read' /dir | head -5");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("book|read");
    expect(r!.targetPath).toBe("/dir");
  });

  it("keeps escaped spaces inside unquoted patterns", () => {
    const r = parseBashGrep("grep Melanie\\ sunrise /dir");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("Melanie sunrise");
    expect(r!.targetPath).toBe("/dir");
  });

  it("consumes -A numeric values without treating them as paths", () => {
    const r = parseBashGrep("grep -A 5 'Caroline' /summaries/");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("Caroline");
    expect(r!.targetPath).toBe("/summaries/");
  });

  it("consumes attached -B numeric values without shifting the target path", () => {
    const r = parseBashGrep("grep -B5 'friends' /sessions/");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("friends");
    expect(r!.targetPath).toBe("/sessions/");
  });

  it("consumes -m values without shifting the target path", () => {
    const r = parseBashGrep("grep -m 1 'single' /dir");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("single");
    expect(r!.targetPath).toBe("/dir");
  });

  it("uses -e as the explicit pattern source", () => {
    const r = parseBashGrep("grep -e 'book|read' /dir");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("book|read");
    expect(r!.targetPath).toBe("/dir");
  });

  it("uses inline -e values as the explicit pattern source", () => {
    const r = parseBashGrep("grep -ebook /dir");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("book");
    expect(r!.targetPath).toBe("/dir");
  });

  it("uses --regexp= as the explicit pattern source", () => {
    const r = parseBashGrep("grep --regexp=book\\|read /dir");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("book|read");
    expect(r!.targetPath).toBe("/dir");
  });

  it("defaults explicit -e searches to / when no target path is given", () => {
    const r = parseBashGrep("grep -e 'book|read'");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("book|read");
    expect(r!.targetPath).toBe("/");
  });

  it("returns null when a value-taking long option is missing its value", () => {
    expect(parseBashGrep("grep --after-context")).toBeNull();
  });

  it("returns null when -A is missing its value", () => {
    expect(parseBashGrep("grep -A")).toBeNull();
  });

  it("returns null when -e is missing its value", () => {
    expect(parseBashGrep("grep -e")).toBeNull();
  });

  it("tolerates unknown short flags without crashing", () => {
    const r = parseBashGrep("grep -Z foo /dir");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
    expect(r!.targetPath).toBe("/dir");
  });

  it("preserves escaped pipes outside quotes as part of the pattern", () => {
    const r = parseBashGrep("grep foo\\|bar /dir | head -5");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo|bar");
    expect(r!.targetPath).toBe("/dir");
  });

  it("preserves escaped quotes inside double-quoted patterns", () => {
    const r = parseBashGrep('grep "foo\\"bar" /dir');
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe('foo"bar');
    expect(r!.targetPath).toBe("/dir");
  });
});

// ─── rg (ripgrep) ──────────────────────────────────────────────────────────
//
// Modern coding agents reach for `rg` by default for directory searches.
// We treat rg invocations as grep equivalents and route them through the
// same SQL fast-path. The branches below cover the rg-specific value-taking
// flags so their values aren't misparsed as the search pattern — which was
// the bug class that motivated rg support in the first place.

describe("parseBashGrep: rg (ripgrep)", () => {
  it("parses bare rg", () => {
    const r = parseBashGrep("rg 'sasun' /summaries");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("sasun");
    expect(r!.targetPath).toBe("/summaries");
    // rg defaults: line numbers on (we mirror that).
    expect(r!.lineNumber).toBe(true);
  });

  it("rg short flags reuse the grep handlers", () => {
    const r = parseBashGrep("rg -F -i foo /x");
    expect(r).not.toBeNull();
    expect(r!.fixedString).toBe(true);
    expect(r!.ignoreCase).toBe(true);
  });

  it("rg --files lists files (mapped to filesOnly)", () => {
    // The --files handler sets filesOnly. rg's --files mode doesn't take a
    // pattern; parseBashGrep treats the next positional as the pattern, so
    // here `/x` becomes the pattern. The branch we care about for coverage
    // is the --files handler firing — assert filesOnly to prove it did.
    const r = parseBashGrep("rg --files /x");
    expect(r).not.toBeNull();
    expect(r!.filesOnly).toBe(true);
  });

  it("rg --count-matches sets countOnly", () => {
    const r = parseBashGrep("rg --count-matches foo /x");
    expect(r).not.toBeNull();
    expect(r!.countOnly).toBe(true);
  });

  it("rg --no-line-number turns off line numbers", () => {
    const r = parseBashGrep("rg --no-line-number foo /x");
    expect(r).not.toBeNull();
    expect(r!.lineNumber).toBe(false);
  });

  it("rg -N short form turns off line numbers", () => {
    const r = parseBashGrep("rg -N foo /x");
    expect(r).not.toBeNull();
    expect(r!.lineNumber).toBe(false);
  });

  it("rg -t ts consumes the next token as a type filter, not the pattern", () => {
    const r = parseBashGrep("rg -t ts foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
    expect(r!.targetPath).toBe("/x");
  });

  it("rg -g '*.md' consumes the glob value, not the pattern", () => {
    const r = parseBashGrep("rg -g '*.md' foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
    expect(r!.targetPath).toBe("/x");
  });

  it("rg -j 4 consumes the threads value", () => {
    const r = parseBashGrep("rg -j 4 foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
  });

  it("rg -r REPLACE consumes the replacement value (not grep's recursive flag)", () => {
    const r = parseBashGrep("rg -r BAR foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
    expect(r!.targetPath).toBe("/x");
  });

  it("rg -E ENCODING consumes the value (not grep's extended-regex)", () => {
    const r = parseBashGrep("rg -E utf-8 foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
    expect(r!.targetPath).toBe("/x");
  });

  it("rg --type ts consumes the type value", () => {
    const r = parseBashGrep("rg --type ts foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
    expect(r!.targetPath).toBe("/x");
  });

  it("rg --type=ts inline value", () => {
    const r = parseBashGrep("rg --type=ts foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
  });

  it("rg --glob '*.md' consumes the glob", () => {
    const r = parseBashGrep("rg --glob '*.md' foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
  });

  it("rg --max-depth 3 consumes the depth value", () => {
    const r = parseBashGrep("rg --max-depth 3 foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
  });

  it("rg --replace BAR consumes the replacement value", () => {
    const r = parseBashGrep("rg --replace BAR foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
  });

  it("rg short value-flag at end of cluster consumes the next token", () => {
    // -it ts → -i + -t ts; -t is value-taking, last in cluster, consumes "ts".
    const r = parseBashGrep("rg -it ts foo /x");
    expect(r).not.toBeNull();
    expect(r!.ignoreCase).toBe(true);
    expect(r!.pattern).toBe("foo");
  });

  it("returns null when an rg value-short is missing its value", () => {
    expect(parseBashGrep("rg -t")).toBeNull();
  });

  it("returns null when an rg value-long is missing its value", () => {
    expect(parseBashGrep("rg --type")).toBeNull();
  });

  it("returns null when rg -r is missing its replace value", () => {
    expect(parseBashGrep("rg -r")).toBeNull();
  });

  it("returns null when rg -E is missing its encoding value", () => {
    expect(parseBashGrep("rg -E")).toBeNull();
  });

  it("rg unknown short flag is a no-op (does not crash)", () => {
    const r = parseBashGrep("rg -Z foo /x");
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe("foo");
  });
});
