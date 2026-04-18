import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getInstalledVersion,
  getLatestVersionCached,
  isNewer,
  readFreshCachedLatestVersion,
  readVersionCache,
  writeVersionCache,
} from "../../src/hooks/version-check.js";

describe("version-check utilities", () => {
  it("compares semantic versions", () => {
    expect(isNewer("0.7.0", "0.6.37")).toBe(true);
    expect(isNewer("0.6.37", "0.6.37")).toBe(false);
    expect(isNewer("0.6.36", "0.6.37")).toBe(false);
  });
});

describe("getInstalledVersion", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `hivemind-version-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers plugin manifest when present", () => {
    const bundleDir = join(root, "claude-code", "bundle");
    mkdirSync(join(root, "claude-code", ".claude-plugin"), { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(root, "claude-code", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.6.37" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hivemind", version: "0.1.0" }));

    expect(getInstalledVersion(bundleDir, ".claude-plugin")).toBe("0.6.37");
  });

  it("walks up to package.json when plugin manifest is absent", () => {
    const bundleDir = join(root, "codex", "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hivemind-codex", version: "0.6.40" }));

    expect(getInstalledVersion(bundleDir, ".codex-plugin")).toBe("0.6.40");
  });
});

describe("version cache", () => {
  let cachePath: string;

  beforeEach(() => {
    cachePath = join(tmpdir(), `hivemind-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`, "version.json");
    mkdirSync(dirname(cachePath), { recursive: true });
  });

  afterEach(() => {
    rmSync(dirname(cachePath), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads and writes cache entries", () => {
    writeVersionCache({ checkedAt: 123, latest: "0.6.38", url: "https://example.com/pkg.json" }, cachePath);
    expect(readVersionCache(cachePath)).toEqual({
      checkedAt: 123,
      latest: "0.6.38",
      url: "https://example.com/pkg.json",
    });
  });

  it("returns fresh cached version within ttl", () => {
    writeVersionCache({ checkedAt: 1_000, latest: "0.6.38", url: "https://example.com/pkg.json" }, cachePath);
    expect(readFreshCachedLatestVersion("https://example.com/pkg.json", 500, cachePath, 1_400)).toBe("0.6.38");
    expect(readFreshCachedLatestVersion("https://example.com/pkg.json", 500, cachePath, 1_600)).toBeUndefined();
  });

  it("uses cached value without fetching when cache is fresh", async () => {
    writeVersionCache({ checkedAt: 1_000, latest: "0.6.38", url: "https://example.com/pkg.json" }, cachePath);
    const fetchImpl = vi.fn();

    const latest = await getLatestVersionCached({
      url: "https://example.com/pkg.json",
      timeoutMs: 3000,
      ttlMs: 500,
      cachePath,
      nowMs: 1_400,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(latest).toBe("0.6.38");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and caches when cache is stale", async () => {
    writeVersionCache({ checkedAt: 1_000, latest: "0.6.38", url: "https://example.com/pkg.json" }, cachePath);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.6.40" }),
    }));

    const latest = await getLatestVersionCached({
      url: "https://example.com/pkg.json",
      timeoutMs: 3000,
      ttlMs: 100,
      cachePath,
      nowMs: 2_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(latest).toBe("0.6.40");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readVersionCache(cachePath)?.latest).toBe("0.6.40");
  });

  it("reuses stale cached value on fetch failure and refreshes checkedAt", async () => {
    writeVersionCache({ checkedAt: 1_000, latest: "0.6.38", url: "https://example.com/pkg.json" }, cachePath);
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });

    const latest = await getLatestVersionCached({
      url: "https://example.com/pkg.json",
      timeoutMs: 3000,
      ttlMs: 100,
      cachePath,
      nowMs: 2_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(latest).toBe("0.6.38");
    expect(readVersionCache(cachePath)?.checkedAt).toBe(2_000);
  });
});
