import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionQueryCache,
  getSessionQueryCacheDir,
  readCachedIndexContent,
  writeCachedIndexContent,
} from "../../src/hooks/query-cache.js";

describe("query-cache", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("writes and reads cached index content per session", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "hivemind-query-cache-"));
    tempRoots.push(cacheRoot);

    writeCachedIndexContent("session-1", "# Memory Index", { cacheRoot });

    expect(readCachedIndexContent("session-1", { cacheRoot })).toBe("# Memory Index");
    expect(getSessionQueryCacheDir("session-1", { cacheRoot })).toBe(join(cacheRoot, "session-1"));
  });

  it("returns null for missing cache files and logs non-ENOENT read and write failures", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "hivemind-query-cache-"));
    tempRoots.push(cacheRoot);
    const logFn = vi.fn();

    expect(readCachedIndexContent("missing", { cacheRoot, logFn })).toBeNull();
    expect(logFn).not.toHaveBeenCalled();

    expect(readCachedIndexContent("broken", {
      cacheRoot: "\u0000",
      logFn,
    })).toBeNull();
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("read failed"));

    writeCachedIndexContent("blocked", "content", {
      cacheRoot: "\u0000",
      logFn,
    });
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("write failed"));
  });

  it("clears a session cache directory and swallows removal errors", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "hivemind-query-cache-"));
    tempRoots.push(cacheRoot);
    writeCachedIndexContent("session-2", "cached", { cacheRoot });

    clearSessionQueryCache("session-2", { cacheRoot });
    expect(readCachedIndexContent("session-2", { cacheRoot })).toBeNull();

    const logFn = vi.fn();
    clearSessionQueryCache("session-2", {
      cacheRoot: "\u0000",
      logFn,
    });
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("clear failed"));
  });
});
