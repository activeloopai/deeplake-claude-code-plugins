import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Source-level tests for src/commands/auth-creds.ts — credential file IO.
 *
 * These helpers were extracted from src/commands/auth.ts in PR #76 so the
 * openclaw plugin's bundle could split fs reads from fetch calls. Coverage
 * here keeps the new module above the 90% per-file bar and locks in the
 * exact behavior of the five branches: file present (valid JSON), file
 * present (malformed JSON → null, no throw), file missing, save with
 * existing config dir, save with missing config dir (must create with 0o700).
 */

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const homedirMock = vi.fn();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (...a: any[]) => existsSyncMock(...a),
    readFileSync: (...a: any[]) => readFileSyncMock(...a),
    writeFileSync: (...a: any[]) => writeFileSyncMock(...a),
    mkdirSync: (...a: any[]) => mkdirSyncMock(...a),
    unlinkSync: (...a: any[]) => unlinkSyncMock(...a),
  };
});
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => homedirMock(),
  };
});

async function importAuthCreds() {
  vi.resetModules();
  return await import("../../src/commands/auth-creds.js");
}

beforeEach(() => {
  existsSyncMock.mockReset().mockReturnValue(false);
  readFileSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  homedirMock.mockReset().mockReturnValue("/home/tester");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth-creds — paths", () => {
  it("CONFIG_DIR resolves under homedir/.deeplake", async () => {
    const m = await importAuthCreds();
    expect(m.CONFIG_DIR).toBe("/home/tester/.deeplake");
    expect(m.CREDS_PATH).toBe("/home/tester/.deeplake/credentials.json");
  });
});

describe("loadCredentials", () => {
  it("returns null when the credentials file doesn't exist", async () => {
    existsSyncMock.mockReturnValue(false);
    const { loadCredentials } = await importAuthCreds();
    expect(loadCredentials()).toBeNull();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("parses and returns the credentials when the file is valid JSON", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      token: "tok",
      orgId: "org",
      orgName: "acme",
      workspaceId: "ws",
      apiUrl: "http://x",
      savedAt: "2026-04-26T00:00:00Z",
    }));
    const { loadCredentials } = await importAuthCreds();
    const got = loadCredentials();
    expect(got).toEqual({
      token: "tok",
      orgId: "org",
      orgName: "acme",
      workspaceId: "ws",
      apiUrl: "http://x",
      savedAt: "2026-04-26T00:00:00Z",
    });
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(readFileSyncMock).toHaveBeenCalledWith("/home/tester/.deeplake/credentials.json", "utf-8");
  });

  it("returns null on malformed JSON without throwing", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("not json {");
    const { loadCredentials } = await importAuthCreds();
    expect(() => loadCredentials()).not.toThrow();
    expect(loadCredentials()).toBeNull();
  });
});

describe("saveCredentials", () => {
  const baseCreds = {
    token: "tok",
    orgId: "org",
    savedAt: "ignored-by-save",
  };

  it("creates ~/.deeplake with mode 0o700 when missing, then writes creds 0o600", async () => {
    // Sequence of existsSync calls during saveCredentials:
    //   1. config dir presence check  → false (must mkdir)
    existsSyncMock.mockReturnValueOnce(false);
    const { saveCredentials } = await importAuthCreds();
    saveCredentials(baseCreds);

    expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      "/home/tester/.deeplake",
      { recursive: true, mode: 0o700 },
    );
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, body, opts] = writeFileSyncMock.mock.calls[0];
    expect(path).toBe("/home/tester/.deeplake/credentials.json");
    expect(opts).toEqual({ mode: 0o600 });
    const written = JSON.parse(body);
    expect(written.token).toBe("tok");
    expect(written.orgId).toBe("org");
    // savedAt is overwritten with a fresh timestamp on every save.
    expect(written.savedAt).not.toBe("ignored-by-save");
    expect(typeof written.savedAt).toBe("string");
    expect(Number.isFinite(Date.parse(written.savedAt))).toBe(true);
  });

  it("does NOT mkdir when ~/.deeplake already exists", async () => {
    existsSyncMock.mockReturnValueOnce(true);
    const { saveCredentials } = await importAuthCreds();
    saveCredentials(baseCreds);
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("deleteCredentials", () => {
  it("returns true and unlinks when the file is present", async () => {
    existsSyncMock.mockReturnValue(true);
    const { deleteCredentials } = await importAuthCreds();
    const ret = deleteCredentials();
    expect(ret).toBe(true);
    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock).toHaveBeenCalledWith("/home/tester/.deeplake/credentials.json");
  });

  it("returns false and does not unlink when the file is absent", async () => {
    existsSyncMock.mockReturnValue(false);
    const { deleteCredentials } = await importAuthCreds();
    const ret = deleteCredentials();
    expect(ret).toBe(false);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });
});
