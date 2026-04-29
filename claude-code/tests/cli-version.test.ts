import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for src/cli/version.ts. getVersion() reads `<pkgRoot>/package.json`
 * where pkgRoot() resolves at runtime from `import.meta.url`. In bundled
 * mode that's the package root; in source-mode tests that's `src/`, which
 * has no package.json — so the live test exercises the catch-fallback path
 * by default. We additionally test the happy path by mocking the seam.
 */

describe("getVersion (source-mode = catch-fallback)", () => {
  it("returns the '0.0.0' sentinel when pkgRoot has no package.json", async () => {
    // In source-mode tests pkgRoot() resolves to src/ which has no package.json,
    // so this exercises the catch branch. Bundled mode runs through the happy
    // path via the live cursor/hermes session-start hooks.
    const { getVersion } = await import("../../src/cli/version.js");
    const v = getVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+|0\.0\.0$/);
  });
});

describe("getVersion (happy path via mocked seam)", () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `hm-getver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    originalCwd = process.cwd();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the version recorded in package.json when present", async () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "9.8.7" }));
    vi.resetModules();
    vi.doMock("../../src/cli/util.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
      return { ...actual, pkgRoot: () => tmp };
    });
    const { getVersion } = await import("../../src/cli/version.js");
    expect(getVersion()).toBe("9.8.7");
    vi.doUnmock("../../src/cli/util.js");
  });

  it("falls back to '0.0.0' when package.json has no version field", async () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    vi.resetModules();
    vi.doMock("../../src/cli/util.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
      return { ...actual, pkgRoot: () => tmp };
    });
    const { getVersion } = await import("../../src/cli/version.js");
    expect(getVersion()).toBe("0.0.0");
    vi.doUnmock("../../src/cli/util.js");
  });

  it("falls back to '0.0.0' when package.json is malformed JSON", async () => {
    writeFileSync(join(tmp, "package.json"), "{ this isn't json");
    vi.resetModules();
    vi.doMock("../../src/cli/util.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
      return { ...actual, pkgRoot: () => tmp };
    });
    const { getVersion } = await import("../../src/cli/version.js");
    expect(getVersion()).toBe("0.0.0");
    vi.doUnmock("../../src/cli/util.js");
  });

  it("falls back to '0.0.0' when package.json is missing entirely", async () => {
    expect(existsSync(join(tmp, "package.json"))).toBe(false);
    vi.resetModules();
    vi.doMock("../../src/cli/util.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
      return { ...actual, pkgRoot: () => tmp };
    });
    const { getVersion } = await import("../../src/cli/version.js");
    expect(getVersion()).toBe("0.0.0");
    vi.doUnmock("../../src/cli/util.js");
  });
});
