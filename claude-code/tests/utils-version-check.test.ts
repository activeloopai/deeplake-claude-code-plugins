import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getInstalledVersion,
  getLatestVersion,
  isNewer,
} from "../../src/utils/version-check.js";

/**
 * Tests for src/utils/version-check.ts.
 *
 * The CC/Codex hooks already have indirect coverage of this file via
 * session-start tests, but the three lookup paths (plugin manifest →
 * .hivemind_version stamp → walk-up package.json) and the fetch-with-
 * timeout for the latest version need direct branch coverage.
 *
 * Note: src/hooks/version-check.ts (with caching) is a separate file
 * with its own test in version-check.test.ts.
 */

describe("isNewer", () => {
  it("strict greater-than across the dotted-version triple", () => {
    expect(isNewer("0.7.0", "0.6.50")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.6.51", "0.6.50")).toBe(true);
  });

  it("equal returns false (no upgrade nudge for the same version)", () => {
    expect(isNewer("0.6.50", "0.6.50")).toBe(false);
  });

  it("older returns false", () => {
    expect(isNewer("0.6.49", "0.6.50")).toBe(false);
    expect(isNewer("0.5.99", "0.6.0")).toBe(false);
  });
});

describe("getInstalledVersion — plugin-manifest branch", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `hm-uvc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers <bundle>/../<manifestDir>/plugin.json when present", () => {
    const bundle = join(root, "claude-code", "bundle");
    mkdirSync(join(root, "claude-code", ".claude-plugin"), { recursive: true });
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "claude-code", ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(root, "package.json"),
      JSON.stringify({ name: "@deeplake/hivemind", version: "9.9.9" }));

    expect(getInstalledVersion(bundle, ".claude-plugin")).toBe("1.2.3");
  });

  it("returns null when plugin.json exists but has no version field AND no other source matches", () => {
    const bundle = join(root, "bundle");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x" }));
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBeNull();
  });
});

describe("getInstalledVersion — .hivemind_version stamp branch", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `hm-uvc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("falls back to the .hivemind_version stamp when the manifest is absent", () => {
    const bundle = join(root, "hivemind", "bundle");
    mkdirSync(bundle, { recursive: true });
    // Drop the stamp at <bundle>/../.hivemind_version (one level up from bundle).
    writeFileSync(join(root, "hivemind", ".hivemind_version"), "5.6.7");
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBe("5.6.7");
  });

  it("trims whitespace from the stamp file", () => {
    const bundle = join(root, "x", "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "x", ".hivemind_version"), "  3.3.3\n\n");
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBe("3.3.3");
  });

  it("ignores an empty stamp and falls through to the next source", () => {
    const bundle = join(root, "y", "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "y", ".hivemind_version"), "");
    // No package.json anywhere → null.
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBeNull();
  });
});

describe("getInstalledVersion — walk-up package.json branch", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `hm-uvc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("walks up to find a package.json with a hivemind name", () => {
    const bundle = join(root, "deep", "deeper", "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "package.json"),
      JSON.stringify({ name: "@deeplake/hivemind", version: "8.8.8" }));
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBe("8.8.8");
  });

  it.each([
    "hivemind",
    "hivemind-codex",
    "@deeplake/hivemind",
    "@deeplake/hivemind-codex",
    "@activeloop/hivemind",
    "@activeloop/hivemind-codex",
  ])("recognises package name %s", (pkgName) => {
    const bundle = join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "package.json"),
      JSON.stringify({ name: pkgName, version: "4.4.4" }));
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBe("4.4.4");
  });

  it("returns null when the walked package.json has a foreign name", () => {
    const bundle = join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "package.json"),
      JSON.stringify({ name: "some-other-package", version: "1.0.0" }));
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBeNull();
  });

  it("stops walking after 5 levels (caps the search budget)", () => {
    const bundle = join(root, "1", "2", "3", "4", "5", "6", "bundle");
    mkdirSync(bundle, { recursive: true });
    // Place the matching package.json 7 levels up — the walker visits 5
    // levels at most, so this must NOT be found.
    writeFileSync(join(root, "package.json"),
      JSON.stringify({ name: "hivemind", version: "1.0.0" }));
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBeNull();
  });

  it("returns null when neither manifest, stamp, nor any walked package.json exists", () => {
    const bundle = join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBeNull();
  });

  it("returns null when the package.json is malformed JSON (catches and continues)", () => {
    const bundle = join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "package.json"), "{ this isn't json");
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBeNull();
  });
});

describe("getInstalledVersion — branch precedence (regression)", () => {
  // CLAUDE.md rule 8: assert that a stamp DOES NOT shadow a valid plugin
  // manifest. We had a regression where the order accidentally swapped
  // and codex sessions reported the cached cursor stamp.
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `hm-uvc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("plugin manifest beats .hivemind_version stamp at the same level", () => {
    const bundle = join(root, "p", "bundle");
    mkdirSync(join(root, "p", ".claude-plugin"), { recursive: true });
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "p", ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(root, "p", ".hivemind_version"), "9.9.9");
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBe("1.0.0");
  });

  it(".hivemind_version stamp beats walk-up package.json", () => {
    const bundle = join(root, "p", "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(root, "p", ".hivemind_version"), "2.0.0");
    writeFileSync(join(root, "package.json"),
      JSON.stringify({ name: "hivemind", version: "9.9.9" }));
    expect(getInstalledVersion(bundle, ".claude-plugin")).toBe("2.0.0");
  });
});

describe("getLatestVersion (network + timeout)", () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the version field on a successful 200", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.6.50" }),
    })) as unknown as typeof fetch;
    expect(await getLatestVersion()).toBe("0.6.50");
  });

  it("returns null on a non-ok HTTP response (e.g. 502)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ version: "0.6.50" }),
    })) as unknown as typeof fetch;
    expect(await getLatestVersion()).toBeNull();
  });

  it("returns null when a successful response has no version field", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ name: "hivemind" }),
    })) as unknown as typeof fetch;
    expect(await getLatestVersion()).toBeNull();
  });

  it("returns null when fetch throws (e.g. network down or timeout)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await getLatestVersion()).toBeNull();
  });

  it("forwards the timeout signal so the call is bounded", async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
      captured = init as RequestInit;
      return { ok: true, json: async () => ({ version: "0.6.50" }) } as Response;
    }) as unknown as typeof fetch;

    await getLatestVersion(1500);
    expect(captured?.signal).toBeDefined();
    // signal should be an AbortSignal — duck-type check, since the
    // exact constructor identity differs across Node versions.
    expect(typeof (captured!.signal as AbortSignal).aborted).toBe("boolean");
  });
});
