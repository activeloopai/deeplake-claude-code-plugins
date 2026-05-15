import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchOrgStats, _clearCacheForTest } from "../../src/notifications/sources/org-stats.js";

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;
let cacheFile = "";

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-org-stats-test-"));
  ORIGINAL_HOME = process.env.HOME;
  process.env.HOME = TEMP_HOME;
  // The source's CACHE_FILE path is computed at module-load time from
  // homedir(). To redirect it without mocking node:os entirely, we instead
  // rely on the `_clearCacheForTest` helper plus a per-test `existsSync`
  // probe at the literal path the source actually writes to. Compute it
  // here using the same join logic the source uses.
  cacheFile = join(TEMP_HOME, ".deeplake", "hivemind-stats-cache.json");
  mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

// The source uses `homedir()` to compute CACHE_FILE at module-load time.
// Tests below redirect HOME, but the cached value inside the source's
// closure won't pick that up. To work around this, the cache integration
// tests run in a separate file-watching environment where `homedir()`
// is overridden via vi.mock — done inline per-test.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => process.env.HOME ?? actual.homedir(),
    // Preserve tmpdir for the beforeEach mkdtempSync.
    tmpdir: actual.tmpdir,
  };
});

describe("fetchOrgStats — auth gating", () => {
  it("returns null when creds is null", async () => {
    expect(await fetchOrgStats(null)).toBeNull();
  });

  it("returns null when creds has no token", async () => {
    expect(await fetchOrgStats({ token: undefined } as any)).toBeNull();
  });
});

describe("fetchOrgStats — success path", () => {
  it("maps server response to client shape and writes to cache", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          org:  { sessions_count: 187, memory_recall_count: 42000, memory_search_bytes: 119_000_000 },
          user: { sessions_count: 22,  memory_recall_count: 510,   memory_search_bytes: 800_000 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const got = await fetchOrgStats({ token: "t", apiUrl: "https://api.example.com" } as any);
    expect(got).toEqual({
      org:  { sessionsCount: 187, memoryRecallCount: 42000, memorySearchBytes: 119_000_000 },
      user: { sessionsCount: 22,  memoryRecallCount: 510,   memorySearchBytes: 800_000 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Cache file written.
    expect(existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cached.apiUrl).toBe("https://api.example.com");
    expect(cached.data.org.memoryRecallCount).toBe(42000);
  });

  it("coerces non-numeric / missing fields to 0 (defensive: server may roll out fields gradually)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          org:  { sessions_count: 100, memory_recall_count: null, memory_search_bytes: -1 },
          user: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const got = await fetchOrgStats({ token: "t", apiUrl: "https://api.example.com" } as any);
    expect(got).toEqual({
      org:  { sessionsCount: 100, memoryRecallCount: 0, memorySearchBytes: 0 },
      user: { sessionsCount: 0,   memoryRecallCount: 0, memorySearchBytes: 0 },
    });
  });
});

describe("fetchOrgStats — failure paths return null (or stale fallback)", () => {
  it("returns null on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("oops", { status: 500 }),
    );
    expect(await fetchOrgStats({ token: "t", apiUrl: "https://api.example.com" } as any)).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    expect(await fetchOrgStats({ token: "t", apiUrl: "https://api.example.com" } as any)).toBeNull();
  });

  it("returns null on network error / abort", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchOrgStats({ token: "t", apiUrl: "https://api.example.com" } as any)).toBeNull();
  });

  it("returns STALE cache value when fetch fails AND a stale cache entry exists", async () => {
    // Seed a stale cache (older than 1h TTL).
    const stale = {
      fetchedAt: Date.now() - (2 * 60 * 60 * 1000), // 2h ago
      apiUrl: "https://api.example.com",
      data: {
        org:  { sessionsCount: 5, memoryRecallCount: 6, memorySearchBytes: 7 },
        user: { sessionsCount: 1, memoryRecallCount: 2, memorySearchBytes: 3 },
      },
    };
    writeFileSync(cacheFile, JSON.stringify(stale), "utf-8");

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const got = await fetchOrgStats({ token: "t", apiUrl: "https://api.example.com" } as any);
    expect(got).toEqual(stale.data);
  });
});

describe("fetchOrgStats — cache freshness", () => {
  it("returns cached data without hitting the network if cache age < 1h", async () => {
    const cached = {
      fetchedAt: Date.now() - (5 * 60 * 1000), // 5m ago
      apiUrl: "https://api.example.com",
      data: {
        org:  { sessionsCount: 99, memoryRecallCount: 99, memorySearchBytes: 99 },
        user: { sessionsCount: 9,  memoryRecallCount: 9,  memorySearchBytes: 9 },
      },
    };
    writeFileSync(cacheFile, JSON.stringify(cached), "utf-8");

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const got = await fetchOrgStats({ token: "t", apiUrl: "https://api.example.com" } as any);
    expect(got).toEqual(cached.data);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores cache when apiUrl differs (user switched between beta/prod creds)", async () => {
    const cached = {
      fetchedAt: Date.now() - 1000,
      apiUrl: "https://api.prod.example.com",
      data: {
        org:  { sessionsCount: 99, memoryRecallCount: 99, memorySearchBytes: 99 },
        user: { sessionsCount: 9,  memoryRecallCount: 9,  memorySearchBytes: 9 },
      },
    };
    writeFileSync(cacheFile, JSON.stringify(cached), "utf-8");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ org: { sessions_count: 1 }, user: { sessions_count: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const got = await fetchOrgStats({ token: "t", apiUrl: "https://api.beta.example.com" } as any);
    // Fresh fetch wins because apiUrl mismatched.
    expect(got?.org.sessionsCount).toBe(1);
    expect(got?.user.sessionsCount).toBe(2);
  });

  it("_clearCacheForTest empties the cache file (used between test runs)", () => {
    writeFileSync(cacheFile, JSON.stringify({ x: 1 }), "utf-8");
    _clearCacheForTest();
    expect(readFileSync(cacheFile, "utf-8")).toBe("");
  });
});
