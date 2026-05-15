import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  configDir,
  credsPath,
} from "../../src/commands/auth-creds.js";

/**
 * Source-level tests for src/commands/auth-creds.ts — credential file IO.
 *
 * Why static import + process.env.HOME override (not vi.mock("node:os") +
 * vi.resetModules + dynamic re-import like the prior version):
 *   - The reimport-per-test pattern created a V8 worker-pool branch
 *     coverage flake on CI. Each reimported module instance had its own
 *     V8 instrumentation, and the merge across vitest workers was non-
 *     deterministic — branch coverage on the if-statements in this file's
 *     helpers dropped to 50-66% on CI while local Node 20+22 reported
 *     100%.
 *   - Lazy path accessors in auth-creds.ts (configDir(), credsPath()) call
 *     homedir() on every invocation rather than binding at module-load
 *     time. So we can flip process.env.HOME between tests and the same
 *     module instance picks up the new value naturally — no reimport
 *     needed.
 *   - One V8 instrumentation instance shared across every test in the
 *     file → coverage merge becomes deterministic.
 */

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-creds-test-"));
  ORIGINAL_HOME = process.env.HOME;
  process.env.HOME = TEMP_HOME;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("auth-creds — paths", () => {
  it("configDir() resolves under homedir/.deeplake", () => {
    expect(configDir()).toBe(join(TEMP_HOME, ".deeplake"));
    expect(credsPath()).toBe(join(TEMP_HOME, ".deeplake", "credentials.json"));
  });
});

describe("loadCredentials", () => {
  it("returns null when the credentials file doesn't exist", () => {
    expect(existsSync(credsPath())).toBe(false);
    expect(loadCredentials()).toBeNull();
  });

  it("parses and returns the credentials when the file is valid JSON", () => {
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

  it("returns null on malformed JSON without throwing", () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(credsPath(), "not json {");
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

  it("creates ~/.deeplake with mode 0o700 when missing, then writes creds 0o600", () => {
    expect(existsSync(configDir())).toBe(false);
    saveCredentials(baseCreds);

    expect(existsSync(configDir())).toBe(true);
    expect(existsSync(credsPath())).toBe(true);
    const fileMode = statSync(credsPath()).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = statSync(configDir()).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const written = JSON.parse(readFileSync(credsPath(), "utf-8"));
    expect(written.token).toBe("tok");
    expect(written.orgId).toBe("org");
    // savedAt is overwritten with a fresh timestamp on every save.
    expect(written.savedAt).not.toBe("ignored-by-save");
    expect(typeof written.savedAt).toBe("string");
    expect(Number.isFinite(Date.parse(written.savedAt))).toBe(true);
  });

  it("preserves existing ~/.deeplake (mkdirSync recursive is idempotent)", () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    // sentinel file proves the directory wasn't recreated underneath us
    writeFileSync(join(configDir(), "sentinel"), "x");
    saveCredentials(baseCreds);
    expect(existsSync(join(configDir(), "sentinel"))).toBe(true);
  });
});

describe("deleteCredentials", () => {
  it("returns true and removes the file when present", () => {
    saveCredentials({ token: "t", orgId: "o", savedAt: "" });
    expect(existsSync(credsPath())).toBe(true);

    expect(deleteCredentials()).toBe(true);
    expect(existsSync(credsPath())).toBe(false);
  });

  it("returns false when the file is absent", () => {
    expect(existsSync(credsPath())).toBe(false);
    expect(deleteCredentials()).toBe(false);
  });

  it("returns false (does not throw) when the path is a directory", () => {
    // EISDIR on unlinkSync — the catch maps any error to false. This test
    // exercises the catch path with a non-ENOENT error, ensuring the catch
    // is not just incidentally hit by the "file absent" case above.
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    mkdirSync(credsPath(), { recursive: true, mode: 0o700 });
    expect(() => deleteCredentials()).not.toThrow();
    expect(deleteCredentials()).toBe(false);
    // The directory we created is still there — deleteCredentials returned
    // false rather than somehow removing the directory.
    expect(existsSync(credsPath())).toBe(true);
  });
});
