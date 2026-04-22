import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Source-level tests for src/config.ts — loadConfig() merges
 * credentials file + env vars into a Config object with the right
 * defaults and fallbacks. Every branch of the HIVEMIND_/DEEPLAKE_
 * fallback chain gets exercised here so per-file coverage stays
 * above the 90% bar.
 */

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const homedirMock = vi.fn();
const userInfoMock = vi.fn();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (...a: any[]) => existsSyncMock(...a),
    readFileSync: (...a: any[]) => readFileSyncMock(...a),
  };
});
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => homedirMock(),
    userInfo: () => userInfoMock(),
  };
});

let stderrSpy: ReturnType<typeof vi.spyOn>;

const ENV_KEYS = [
  "HIVEMIND_TOKEN", "HIVEMIND_ORG_ID", "HIVEMIND_WORKSPACE_ID",
  "HIVEMIND_API_URL", "HIVEMIND_TABLE", "HIVEMIND_SESSIONS_TABLE",
  "HIVEMIND_MEMORY_PATH",
  "DEEPLAKE_TOKEN", "DEEPLAKE_ORG_ID", "DEEPLAKE_WORKSPACE_ID",
  "DEEPLAKE_API_URL", "DEEPLAKE_TABLE", "DEEPLAKE_SESSIONS_TABLE",
  "DEEPLAKE_MEMORY_PATH",
];

async function importLoadConfig() {
  vi.resetModules();
  const mod = await import("../../src/config.js");
  return mod.loadConfig;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  existsSyncMock.mockReset().mockReturnValue(false);
  readFileSyncMock.mockReset();
  homedirMock.mockReset().mockReturnValue("/home/tester");
  userInfoMock.mockReset().mockReturnValue({ username: "tester" });
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe("loadConfig — no credentials file", () => {
  it("returns null when nothing is set", async () => {
    const loadConfig = await importLoadConfig();
    expect(loadConfig()).toBeNull();
  });

  it("builds a config from HIVEMIND_TOKEN + HIVEMIND_ORG_ID", async () => {
    process.env.HIVEMIND_TOKEN = "tok";
    process.env.HIVEMIND_ORG_ID = "org-1";
    const loadConfig = await importLoadConfig();
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      token: "tok",
      orgId: "org-1",
      orgName: "org-1",
      userName: "tester",
      workspaceId: "default",
      apiUrl: "https://api.deeplake.ai",
      tableName: "memory",
      sessionsTableName: "sessions",
      memoryPath: "/home/tester/.deeplake/memory",
    });
  });

  it("falls back to DEEPLAKE_* env vars and warns about deprecation", async () => {
    process.env.DEEPLAKE_TOKEN = "tok";
    process.env.DEEPLAKE_ORG_ID = "org-2";
    const loadConfig = await importLoadConfig();
    const cfg = loadConfig();
    expect(cfg?.token).toBe("tok");
    expect(cfg?.orgId).toBe("org-2");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("DEEPLAKE_* env vars are deprecated"),
    );
  });

  it("does not warn when HIVEMIND_TOKEN is set (even if DEEPLAKE_TOKEN is also set)", async () => {
    process.env.HIVEMIND_TOKEN = "tok";
    process.env.DEEPLAKE_TOKEN = "legacy";
    process.env.HIVEMIND_ORG_ID = "o";
    const loadConfig = await importLoadConfig();
    loadConfig();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("returns null when token is missing", async () => {
    process.env.HIVEMIND_ORG_ID = "o";
    const loadConfig = await importLoadConfig();
    expect(loadConfig()).toBeNull();
  });

  it("returns null when orgId is missing", async () => {
    process.env.HIVEMIND_TOKEN = "tok";
    const loadConfig = await importLoadConfig();
    expect(loadConfig()).toBeNull();
  });
});

describe("loadConfig — credentials file", () => {
  it("loads creds when file exists and JSON is valid", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      token: "ftok", orgId: "forg", orgName: "ACME", userName: "alice",
      workspaceId: "w1", apiUrl: "https://custom",
    }));
    const loadConfig = await importLoadConfig();
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      token: "ftok",
      orgId: "forg",
      orgName: "ACME",
      userName: "alice",
      workspaceId: "w1",
      apiUrl: "https://custom",
    });
  });

  it("returns null when credentials JSON is invalid", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("{not json}");
    const loadConfig = await importLoadConfig();
    expect(loadConfig()).toBeNull();
  });

  it("falls back to orgId when creds lack orgName", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      token: "t", orgId: "only-id",
    }));
    const loadConfig = await importLoadConfig();
    expect(loadConfig()?.orgName).toBe("only-id");
  });

  it("backfills userName from userInfo() when creds lack it", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      token: "t", orgId: "o",
    }));
    userInfoMock.mockReturnValue({ username: "backfilled" });
    const loadConfig = await importLoadConfig();
    expect(loadConfig()?.userName).toBe("backfilled");
  });

  it("uses 'unknown' when userInfo() has no username", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      token: "t", orgId: "o",
    }));
    userInfoMock.mockReturnValue({ username: "" });
    const loadConfig = await importLoadConfig();
    expect(loadConfig()?.userName).toBe("unknown");
  });

  it("env vars override credentials file for token + orgId", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      token: "file-tok", orgId: "file-org",
    }));
    process.env.HIVEMIND_TOKEN = "env-tok";
    process.env.HIVEMIND_ORG_ID = "env-org";
    const loadConfig = await importLoadConfig();
    const cfg = loadConfig();
    expect(cfg?.token).toBe("env-tok");
    expect(cfg?.orgId).toBe("env-org");
  });

  it("HIVEMIND_* env vars override DEEPLAKE_* env vars for non-token fields", async () => {
    process.env.HIVEMIND_TOKEN = "t";
    process.env.HIVEMIND_ORG_ID = "o";
    process.env.HIVEMIND_WORKSPACE_ID = "hw";
    process.env.DEEPLAKE_WORKSPACE_ID = "dw";
    process.env.HIVEMIND_API_URL = "https://hm-api";
    process.env.DEEPLAKE_API_URL = "https://dl-api";
    process.env.HIVEMIND_TABLE = "hm-mem";
    process.env.HIVEMIND_SESSIONS_TABLE = "hm-sess";
    process.env.HIVEMIND_MEMORY_PATH = "/custom/mem";
    const loadConfig = await importLoadConfig();
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      workspaceId: "hw",
      apiUrl: "https://hm-api",
      tableName: "hm-mem",
      sessionsTableName: "hm-sess",
      memoryPath: "/custom/mem",
    });
  });

  it("DEEPLAKE_* env vars fill in when HIVEMIND_* are absent", async () => {
    process.env.HIVEMIND_TOKEN = "t";
    process.env.HIVEMIND_ORG_ID = "o";
    process.env.DEEPLAKE_WORKSPACE_ID = "dw";
    process.env.DEEPLAKE_API_URL = "https://dl-api";
    process.env.DEEPLAKE_TABLE = "dl-mem";
    process.env.DEEPLAKE_SESSIONS_TABLE = "dl-sess";
    process.env.DEEPLAKE_MEMORY_PATH = "/deeplake/mem";
    const loadConfig = await importLoadConfig();
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      workspaceId: "dw",
      apiUrl: "https://dl-api",
      tableName: "dl-mem",
      sessionsTableName: "dl-sess",
      memoryPath: "/deeplake/mem",
    });
  });
});
