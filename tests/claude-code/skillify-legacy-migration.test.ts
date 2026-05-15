import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for src/skillify/legacy-migration.ts.
 *
 * Each `it` runs in a fresh `process.env.HOME = mkdtempSync(...)` so the
 * helper's `homedir()`-based path resolution targets a sandbox dir, never
 * the real user state. The module-level `attempted` flag is reset by
 * re-importing via `vi.resetModules()` between tests — otherwise the second
 * call short-circuits and we'd be testing the cache rather than the logic.
 */

let sandboxHome: string;
let prevHome: string | undefined;
// Windows `os.homedir()` resolves from USERPROFILE / HOMEDRIVE+HOMEPATH, not
// HOME. CI is ubuntu-only today but sandboxing all three keeps the test from
// touching real user state if anyone runs it on Windows locally.
let prevUserProfile: string | undefined;
let prevHomeDrive: string | undefined;
let prevHomePath: string | undefined;

const legacyOf = (h: string) => join(h, ".deeplake", "state", "skilify");
const currentOf = (h: string) => join(h, ".deeplake", "state", "skillify");

async function freshMigrate() {
  vi.resetModules();
  const mod = await import("../../src/skillify/legacy-migration.js");
  return mod.migrateLegacyStateDir;
}

beforeEach(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), "skillify-migration-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevHomeDrive = process.env.HOMEDRIVE;
  prevHomePath = process.env.HOMEPATH;
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevHomeDrive === undefined) delete process.env.HOMEDRIVE;
  else process.env.HOMEDRIVE = prevHomeDrive;
  if (prevHomePath === undefined) delete process.env.HOMEPATH;
  else process.env.HOMEPATH = prevHomePath;
  // chmodSync the sandbox readable in case a test removed perms; otherwise
  // rmSync hits EACCES on cleanup and leaks the temp dir across runs.
  try { chmodSync(sandboxHome, 0o755); } catch { /* nothing */ }
  rmSync(sandboxHome, { recursive: true, force: true });
});

describe("migrateLegacyStateDir", () => {
  it("no-op when legacy dir does not exist", async () => {
    const migrate = await freshMigrate();
    migrate();
    expect(existsSync(legacyOf(sandboxHome))).toBe(false);
    expect(existsSync(currentOf(sandboxHome))).toBe(false);
  });

  it("no-op when current dir already exists (legacy preserved untouched)", async () => {
    const legacy = legacyOf(sandboxHome);
    const current = currentOf(sandboxHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), '{"scope":"team"}');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "config.json"), '{"scope":"me"}');

    const migrate = await freshMigrate();
    migrate();

    // Both still exist; current's contents NOT clobbered with legacy's.
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(readFileSync(join(current, "config.json"), "utf-8")).toBe('{"scope":"me"}');
    expect(readFileSync(join(legacy, "config.json"), "utf-8")).toBe('{"scope":"team"}');
  });

  it("renames legacy → current when only legacy exists, preserving contents", async () => {
    const legacy = legacyOf(sandboxHome);
    const current = currentOf(sandboxHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), '{"scope":"team","team":["alice"],"install":"global"}');
    writeFileSync(join(legacy, "pulled.json"), '{"version":1,"entries":[]}');
    writeFileSync(join(legacy, "abc123.json"), '{"counter":3}');

    const migrate = await freshMigrate();
    migrate();

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(readFileSync(join(current, "config.json"), "utf-8"))
      .toBe('{"scope":"team","team":["alice"],"install":"global"}');
    expect(readFileSync(join(current, "pulled.json"), "utf-8"))
      .toBe('{"version":1,"entries":[]}');
    expect(readFileSync(join(current, "abc123.json"), "utf-8")).toBe('{"counter":3}');
  });

  it("idempotent: second call is a no-op even if legacy reappears", async () => {
    const legacy = legacyOf(sandboxHome);
    const current = currentOf(sandboxHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), '{"scope":"team"}');

    const migrate = await freshMigrate();
    migrate();
    expect(existsSync(current)).toBe(true);
    expect(existsSync(legacy)).toBe(false);

    // Recreate legacy with conflicting content; second call must NOT touch
    // it. The `me-sentinel` value is just a string distinct from the
    // earlier `"team"`; we use it to verify the file's content is exactly
    // what we wrote and nothing migrated over it.
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), '{"scope":"me-sentinel"}');
    rmSync(current, { recursive: true, force: true });

    migrate();

    // attempted=true → migrate did not run; current was NOT recreated from
    // the new legacy. Confirms the `attempted` short-circuit holds.
    expect(existsSync(current)).toBe(false);
    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(join(legacy, "config.json"), "utf-8")).toBe('{"scope":"me-sentinel"}');
  });

  it.each([
    ["EXDEV", "cross-device link not permitted"],
    ["EPERM", "operation not permitted"],
  ])("swallows %s renameSync failure and leaves legacy in place", async (code, message) => {
    // We can't realistically force a true EXDEV inside a single tmpfs in
    // CI, so we mock fs at the module level. Re-import after the mock so
    // the helper picks up the stubbed renameSync.
    const legacy = legacyOf(sandboxHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), '{"scope":"me"}');

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...real,
        renameSync: () => {
          const err = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        },
      };
    });
    const { migrateLegacyStateDir } = await import("../../src/skillify/legacy-migration.js");

    expect(() => migrateLegacyStateDir()).not.toThrow();
    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(join(legacy, "config.json"), "utf-8")).toBe('{"scope":"me"}');

    vi.doUnmock("node:fs");
  });

  it("re-throws unexpected renameSync failures (EIO, ENOSPC, etc.)", async () => {
    // EIO/ENOSPC/anything else is NOT in the documented fallback set.
    // Swallowing it would leave the user on a fresh skillify state dir
    // with their legacy state silently orphaned. The helper must propagate
    // so the caller (or the user) sees the real I/O failure.
    const legacy = legacyOf(sandboxHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), '{"scope":"me"}');

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...real,
        renameSync: () => {
          const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        },
      };
    });
    const { migrateLegacyStateDir } = await import("../../src/skillify/legacy-migration.js");

    expect(() => migrateLegacyStateDir()).toThrow(/EIO/);
    // Legacy still in place — the caller can decide what to do.
    expect(existsSync(legacy)).toBe(true);

    vi.doUnmock("node:fs");
  });
});
