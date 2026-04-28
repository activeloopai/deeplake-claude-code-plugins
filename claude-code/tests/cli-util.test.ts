import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
  HOME,
  pkgRoot,
  ensureDir,
  copyDir,
  symlinkForce,
  isLink,
  readJson,
  writeJson,
  writeVersionStamp,
  readVersionStamp,
  detectPlatforms,
  allPlatformIds,
  log,
  warn,
} from "../../src/cli/util.js";

/**
 * Tests for src/cli/util.ts — the shared filesystem + platform-detection
 * helpers used by every per-agent installer.
 *
 * Helpers operate directly on disk; we drive them with a per-test tmp dir
 * so behavior survives a mocked-fs refactor (CLAUDE.md rule 5: mock at the
 * boundary, not in the middle).
 */

describe("HOME", () => {
  it("matches Node's homedir() at module load time", () => {
    expect(HOME).toBe(homedir());
  });
});

describe("pkgRoot", () => {
  it("returns an absolute path that contains a package.json", () => {
    const root = pkgRoot();
    expect(root).toMatch(/^\//);
    // The package.json at pkgRoot's parent or pkgRoot itself describes the
    // hivemind package — installers read it via getVersion().
    expect(existsSync(join(root, "package.json")) || existsSync(join(root, "..", "package.json"))).toBe(true);
  });
});

describe("ensureDir / readJson / writeJson", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `hm-util-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ensureDir creates a missing directory recursively", () => {
    const nested = join(dir, "a", "b", "c");
    ensureDir(nested);
    expect(existsSync(nested)).toBe(true);
    expect(statSync(nested).isDirectory()).toBe(true);
  });

  it("ensureDir is a no-op when the directory already exists", () => {
    ensureDir(dir);
    expect(() => ensureDir(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(true);
  });

  it("writeJson writes pretty-printed JSON with a trailing newline (round-trip via readJson)", () => {
    const file = join(dir, "nested", "x.json");
    const obj = { a: 1, b: ["x", "y"] };
    writeJson(file, obj);
    const raw = readFileSync(file, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("  \"a\": 1");
    expect(readJson<typeof obj>(file)).toEqual(obj);
  });

  it("readJson returns null on a missing file (no throw)", () => {
    expect(readJson(join(dir, "missing.json"))).toBeNull();
  });

  it("readJson returns null on malformed JSON (does not throw)", () => {
    const file = join(dir, "bad.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "{ this is not json");
    expect(readJson(file)).toBeNull();
  });
});

describe("copyDir", () => {
  let src: string;
  let dst: string;
  beforeEach(() => {
    const root = join(tmpdir(), `hm-cpy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    src = join(root, "src");
    dst = join(root, "dst");
    mkdirSync(join(src, "nested"), { recursive: true });
    writeFileSync(join(src, "a.js"), "console.log('a')");
    writeFileSync(join(src, "nested", "b.js"), "console.log('b')");
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  });

  it("recursively copies all files, preserving structure", () => {
    copyDir(src, dst);
    expect(readFileSync(join(dst, "a.js"), "utf-8")).toBe("console.log('a')");
    expect(readFileSync(join(dst, "nested", "b.js"), "utf-8")).toBe("console.log('b')");
  });

  it("force-overwrites pre-existing files at the destination", () => {
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, "a.js"), "stale");
    copyDir(src, dst);
    expect(readFileSync(join(dst, "a.js"), "utf-8")).toBe("console.log('a')");
  });
});

describe("symlinkForce / isLink", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `hm-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a fresh symlink when no link exists", () => {
    const target = join(dir, "target.txt");
    writeFileSync(target, "hi");
    const link = join(dir, "link.txt");
    symlinkForce(target, link);
    expect(isLink(link)).toBe(true);
  });

  it("replaces a stale symlink that already points elsewhere (no EEXIST)", () => {
    const t1 = join(dir, "t1.txt");
    const t2 = join(dir, "t2.txt");
    writeFileSync(t1, "one");
    writeFileSync(t2, "two");
    const link = join(dir, "link.txt");
    symlinkForce(t1, link);
    symlinkForce(t2, link);
    expect(isLink(link)).toBe(true);
    expect(readFileSync(link, "utf-8")).toBe("two");
  });

  it("replaces a regular file at the link path", () => {
    const link = join(dir, "link.txt");
    writeFileSync(link, "regular file");
    const target = join(dir, "target.txt");
    writeFileSync(target, "via symlink");
    symlinkForce(target, link);
    expect(isLink(link)).toBe(true);
  });

  it("isLink returns false for a regular file", () => {
    const f = join(dir, "f.txt");
    writeFileSync(f, "x");
    expect(isLink(f)).toBe(false);
  });

  it("isLink returns false for a non-existent path", () => {
    expect(isLink(join(dir, "nope"))).toBe(false);
  });
});

describe("readVersionStamp / writeVersionStamp", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `hm-ver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a version string through write+read", () => {
    writeVersionStamp(dir, "1.2.3");
    expect(readVersionStamp(dir)).toBe("1.2.3");
    // Plain text, no JSON quoting.
    expect(readFileSync(join(dir, ".hivemind_version"), "utf-8")).toBe("1.2.3");
  });

  it("readVersionStamp returns null when the file is missing", () => {
    mkdirSync(dir, { recursive: true });
    expect(readVersionStamp(dir)).toBeNull();
  });

  it("readVersionStamp trims trailing whitespace and newlines", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".hivemind_version"), "  9.9.9\n\n");
    expect(readVersionStamp(dir)).toBe("9.9.9");
  });

  it("writeVersionStamp creates the directory if it doesn't already exist", () => {
    expect(existsSync(dir)).toBe(false);
    writeVersionStamp(dir, "0.0.1");
    expect(existsSync(dir)).toBe(true);
    expect(readVersionStamp(dir)).toBe("0.0.1");
  });
});

describe("detectPlatforms / allPlatformIds", () => {
  it("allPlatformIds returns the canonical six-platform set", () => {
    expect(allPlatformIds()).toEqual(["claude", "codex", "claw", "cursor", "hermes", "pi"]);
  });

  it("detectPlatforms returns only platforms whose marker dir exists right now", () => {
    // We can't manipulate $HOME mid-test (HOME was captured at module load).
    // Instead assert detectPlatforms is a *subset* of allPlatformIds and
    // that every returned entry has an existing markerDir on disk — that
    // guards against a regression where a missing dir slipped through.
    const detected = detectPlatforms();
    const validIds = new Set(allPlatformIds());
    for (const p of detected) {
      expect(validIds.has(p.id)).toBe(true);
      expect(existsSync(p.markerDir)).toBe(true);
    }
  });

  it("detectPlatforms entries point at directories under HOME", () => {
    for (const p of detectPlatforms()) {
      expect(p.markerDir.startsWith(HOME)).toBe(true);
    }
  });
});

describe("log / warn", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("log writes to stdout with a trailing newline (exactly one call)", () => {
    log("hello");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith("hello\n");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("warn writes to stderr with a trailing newline (exactly one call)", () => {
    warn("oops");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith("oops\n");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
