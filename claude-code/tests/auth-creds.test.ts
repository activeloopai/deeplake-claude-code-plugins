import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Source-level tests for src/commands/auth-creds.ts — credential file IO.
 *
 * These helpers were extracted from src/commands/auth.ts in PR #76 so the
 * openclaw plugin's bundle could split fs reads from fetch calls. We exercise
 * the module against a REAL temp directory (not a vi.mock("node:fs")) so v8
 * coverage attributes branches to the same source instance the openclaw
 * plugin's dynamic-import path loads in other workers — otherwise CI workers
 * disagreed about which branches at lines 29/43 had been taken and the
 * aggregated branch coverage dropped to 66.66%.
 */

let TEMP_HOME = "";

vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, homedir: () => TEMP_HOME };
});

async function importAuthCreds() {
  vi.resetModules();
  return await import("../../src/commands/auth-creds.js");
}

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-creds-test-"));
});

afterEach(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("auth-creds — paths", () => {
  it("CONFIG_DIR resolves under homedir/.deeplake", async () => {
    const m = await importAuthCreds();
    expect(m.CONFIG_DIR).toBe(join(TEMP_HOME, ".deeplake"));
    expect(m.CREDS_PATH).toBe(join(TEMP_HOME, ".deeplake", "credentials.json"));
  });
});

describe("loadCredentials", () => {
  it("returns null when the credentials file doesn't exist", async () => {
    const { loadCredentials, CREDS_PATH } = await importAuthCreds();
    expect(existsSync(CREDS_PATH)).toBe(false);
    expect(loadCredentials()).toBeNull();
  });

  it("parses and returns the credentials when the file is valid JSON", async () => {
    const { loadCredentials, saveCredentials } = await importAuthCreds();
    const creds = {
      token: "tok",
      orgId: "org",
      orgName: "acme",
      workspaceId: "ws",
      apiUrl: "http://x",
      savedAt: "2026-04-26T00:00:00Z",
    };
    saveCredentials(creds);
    const got = loadCredentials();
    expect(got).toMatchObject({
      token: "tok",
      orgId: "org",
      orgName: "acme",
      workspaceId: "ws",
      apiUrl: "http://x",
    });
  });

  it("returns null on malformed JSON without throwing", async () => {
    const { loadCredentials, CREDS_PATH, CONFIG_DIR } = await importAuthCreds();
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CREDS_PATH, "not json {");
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
    const { saveCredentials, CREDS_PATH, CONFIG_DIR } = await importAuthCreds();
    expect(existsSync(CONFIG_DIR)).toBe(false);
    saveCredentials(baseCreds);

    expect(existsSync(CONFIG_DIR)).toBe(true);
    expect(existsSync(CREDS_PATH)).toBe(true);
    const fileMode = statSync(CREDS_PATH).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = statSync(CONFIG_DIR).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const written = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
    expect(written.token).toBe("tok");
    expect(written.orgId).toBe("org");
    // savedAt is overwritten with a fresh timestamp on every save.
    expect(written.savedAt).not.toBe("ignored-by-save");
    expect(typeof written.savedAt).toBe("string");
    expect(Number.isFinite(Date.parse(written.savedAt))).toBe(true);
  });

  it("does NOT mkdir when ~/.deeplake already exists", async () => {
    const { saveCredentials, CONFIG_DIR } = await importAuthCreds();
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    // sentinel file proves the directory wasn't recreated underneath us
    writeFileSync(join(CONFIG_DIR, "sentinel"), "x");
    saveCredentials(baseCreds);
    expect(existsSync(join(CONFIG_DIR, "sentinel"))).toBe(true);
  });
});

describe("deleteCredentials", () => {
  it("returns true and removes the file when present", async () => {
    const { saveCredentials, deleteCredentials, CREDS_PATH } = await importAuthCreds();
    saveCredentials({ token: "t", orgId: "o", savedAt: "" });
    expect(existsSync(CREDS_PATH)).toBe(true);

    expect(deleteCredentials()).toBe(true);
    expect(existsSync(CREDS_PATH)).toBe(false);
  });

  it("returns false when the file is absent", async () => {
    const { deleteCredentials, CREDS_PATH } = await importAuthCreds();
    expect(existsSync(CREDS_PATH)).toBe(false);
    expect(deleteCredentials()).toBe(false);
  });
});
