import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Source-level tests for src/index-marker-store.ts — fs-backed lookup-index
 * freshness markers. Extracted from src/deeplake-api.ts in PR #76 so the
 * openclaw plugin's bundle could split fs writes from its fetch calls.
 *
 * Branches covered:
 *   - getIndexMarkerDir: env override vs default tmpdir() fallback.
 *   - buildIndexMarkerPath: special-character escaping in marker key.
 *   - hasFreshIndexMarker: missing file / malformed JSON / expired (>TTL) /
 *     fresh (<TTL) / non-numeric updatedAt.
 *   - writeIndexMarker: ensures dir exists, writes JSON with timestamp.
 *
 * Negative pattern (rule 8 from CLAUDE.md): TTL constant must be 6h not 24h.
 * The bot reviewer caught a silent 6h→24h regression on PR #76; this test
 * fails if anyone re-introduces the 24h value via the env-var default path.
 */

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const tmpdirMock = vi.fn();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (...a: any[]) => existsSyncMock(...a),
    readFileSync: (...a: any[]) => readFileSyncMock(...a),
    writeFileSync: (...a: any[]) => writeFileSyncMock(...a),
    mkdirSync: (...a: any[]) => mkdirSyncMock(...a),
  };
});
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    tmpdir: () => tmpdirMock(),
  };
});

async function importMarkerStore() {
  vi.resetModules();
  return await import("../../src/index-marker-store.js");
}

const ENV_KEYS = ["HIVEMIND_INDEX_MARKER_DIR", "HIVEMIND_INDEX_MARKER_TTL_MS"];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  existsSyncMock.mockReset().mockReturnValue(false);
  readFileSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  tmpdirMock.mockReset().mockReturnValue("/tmp/test-tmp");
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe("getIndexMarkerDir", () => {
  it("uses HIVEMIND_INDEX_MARKER_DIR when set", async () => {
    process.env.HIVEMIND_INDEX_MARKER_DIR = "/custom/marker/dir";
    const { getIndexMarkerDir } = await importMarkerStore();
    expect(getIndexMarkerDir()).toBe("/custom/marker/dir");
  });

  it("falls back to tmpdir()/hivemind-deeplake-indexes when env unset", async () => {
    const { getIndexMarkerDir } = await importMarkerStore();
    expect(getIndexMarkerDir()).toBe("/tmp/test-tmp/hivemind-deeplake-indexes");
    expect(tmpdirMock).toHaveBeenCalled();
  });
});

describe("buildIndexMarkerPath", () => {
  it("joins workspace/org/table/suffix with __ separators", async () => {
    const { buildIndexMarkerPath } = await importMarkerStore();
    const p = buildIndexMarkerPath("ws1", "org1", "memory", "path_creation_date");
    expect(p).toBe("/tmp/test-tmp/hivemind-deeplake-indexes/ws1__org1__memory__path_creation_date.json");
  });

  it("escapes any character outside [a-zA-Z0-9_.-] in the marker key", async () => {
    const { buildIndexMarkerPath } = await importMarkerStore();
    const p = buildIndexMarkerPath("ws/with/slash", "org with space", "tbl", "sfx");
    // The marker filename (last path segment) must have all disallowed chars
    // replaced with underscore. The directory prefix is allowed to contain
    // slashes — that's the path separator.
    const filename = p.slice(p.lastIndexOf("/") + 1);
    expect(filename).toBe("ws_with_slash__org_with_space__tbl__sfx.json");
    expect(filename).not.toMatch(/[ /]/);
  });
});

describe("hasFreshIndexMarker", () => {
  const markerPath = "/tmp/test-tmp/hivemind-deeplake-indexes/m.json";

  it("returns false when the marker file doesn't exist", async () => {
    existsSyncMock.mockReturnValue(false);
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(hasFreshIndexMarker(markerPath)).toBe(false);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns false on malformed JSON without throwing", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("not-json{");
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(() => hasFreshIndexMarker(markerPath)).not.toThrow();
    expect(hasFreshIndexMarker(markerPath)).toBe(false);
  });

  it("returns true when updatedAt is within TTL (default 6h)", async () => {
    existsSyncMock.mockReturnValue(true);
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    readFileSyncMock.mockReturnValue(JSON.stringify({ updatedAt: recent }));
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(hasFreshIndexMarker(markerPath)).toBe(true);
  });

  it("returns false when updatedAt is older than TTL", async () => {
    existsSyncMock.mockReturnValue(true);
    // Default TTL is 6 hours; pick 7h to be safely past it.
    const stale = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    readFileSyncMock.mockReturnValue(JSON.stringify({ updatedAt: stale }));
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(hasFreshIndexMarker(markerPath)).toBe(false);
  });

  it("returns false when updatedAt is not a parseable date", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({ updatedAt: "definitely not a date" }));
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(hasFreshIndexMarker(markerPath)).toBe(false);
  });

  it("returns false when updatedAt field is missing", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({}));
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(hasFreshIndexMarker(markerPath)).toBe(false);
  });

  it("regression: TTL default is 6 hours, not 24 hours (caught by bot on PR #76)", async () => {
    existsSyncMock.mockReturnValue(true);
    // 7-hour-old marker. With a (correct) 6h TTL → stale → false.
    // Under the regressed 24h TTL → still fresh → true. The wrong TTL would
    // pass the "within TTL" test above; this assertion specifically guards
    // the default constant.
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    readFileSyncMock.mockReturnValue(JSON.stringify({ updatedAt: sevenHoursAgo }));
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(hasFreshIndexMarker(markerPath)).toBe(false);
  });

  it("respects HIVEMIND_INDEX_MARKER_TTL_MS env override", async () => {
    process.env.HIVEMIND_INDEX_MARKER_TTL_MS = String(1000); // 1 second
    existsSyncMock.mockReturnValue(true);
    const tenSecAgo = new Date(Date.now() - 10_000).toISOString();
    readFileSyncMock.mockReturnValue(JSON.stringify({ updatedAt: tenSecAgo }));
    const { hasFreshIndexMarker } = await importMarkerStore();
    expect(hasFreshIndexMarker(markerPath)).toBe(false);
  });
});

describe("writeIndexMarker", () => {
  it("ensures the marker dir exists, then writes a JSON timestamp", async () => {
    const markerPath = "/tmp/test-tmp/hivemind-deeplake-indexes/m.json";
    const { writeIndexMarker } = await importMarkerStore();
    writeIndexMarker(markerPath);

    expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      "/tmp/test-tmp/hivemind-deeplake-indexes",
      { recursive: true },
    );
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, body, encoding] = writeFileSyncMock.mock.calls[0];
    expect(path).toBe(markerPath);
    expect(encoding).toBe("utf-8");
    const parsed = JSON.parse(body);
    expect(typeof parsed.updatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(parsed.updatedAt))).toBe(true);
  });
});
