import { describe, it, expect } from "vitest";
import { parseBashGrep, type GrepParams } from "../../src/hooks/grep-direct.js";

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
});
