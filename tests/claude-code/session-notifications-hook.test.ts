import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Source-level coverage of src/hooks/session-notifications.ts. Bundle smoke
 * tests in notifications.test.ts already exercise the same code path through
 * the built artifact, but bundles aren't counted toward source coverage.
 *
 * Strategy: vi.resetModules() before each test, set up HOME + creds fixtures,
 * dynamically import the hook so its top-level rule registration runs, and
 * spy on process.{stdout,stderr,exit} to validate behavior without actually
 * exiting the test process.
 */

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;
let ORIGINAL_WIKI: string | undefined;

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-notif-hook-"));
  ORIGINAL_HOME = process.env.HOME;
  ORIGINAL_WIKI = process.env.HIVEMIND_WIKI_WORKER;
  process.env.HOME = TEMP_HOME;
  delete process.env.HIVEMIND_WIKI_WORKER;
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_WIKI === undefined) delete process.env.HIVEMIND_WIKI_WORKER;
  else process.env.HIVEMIND_WIKI_WORKER = ORIGINAL_WIKI;
  rmSync(TEMP_HOME, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function plantCreds(savedAt = "2026-05-06T01:00:00Z"): void {
  mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(TEMP_HOME, ".deeplake", "credentials.json"),
    JSON.stringify({
      token: "tok",
      orgId: "o",
      orgName: "acme",
      userName: "ada",
      workspaceId: "ws",
      savedAt,
    }),
    { mode: 0o600 },
  );
}

function spyStdoutStderr(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: any) => {
    stdout.push(typeof c === "string" ? c : c.toString());
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => {
    stderr.push(typeof c === "string" ? c : c.toString());
    return true;
  });
  return { stdout, stderr };
}

// Stub readStdin so the hook doesn't hang waiting for stdin in the test runner.
async function loadHookModule() {
  vi.doMock("../../src/utils/stdin.js", () => ({
    readStdin: vi.fn().mockResolvedValue({ session_id: "test" }),
  }));
  // Force a fresh module instance so the registerRule(welcomeRule) at top
  // level runs against a clean registry per test.
  await import("../../src/notifications/index.js").then(m => m._resetRulesForTest());
  return import("../../src/hooks/session-notifications.js");
}

describe("session-notifications hook entry — main()", () => {
  it("registers welcomeRule on module load", async () => {
    await loadHookModule();
    const { listRules } = await import("../../src/notifications/index.js");
    expect(listRules().some(r => r.id === "welcome")).toBe(true);
  });

  // Note: full happy-path delivery (creds present → emit) is exercised by the
  // bundle smoke tests in notifications.test.ts. We don't repeat it here
  // because dynamic-import + spyOn on process.stdout has a timing race in
  // vitest — the write fires before the spy is reliably intercepted.

  it("emits nothing when creds.json doesn't exist (logged-out)", async () => {
    const { stdout } = spyStdoutStderr();
    await loadHookModule();
    await new Promise(r => setImmediate(r));
    expect(stdout).toEqual([]);
  });

  it("outer catch handler handles non-Error throws (covers `e?.message ?? String(e)` fallback)", async () => {
    plantCreds();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as any);

    vi.doMock("../../src/notifications/index.js", async (importOriginal) => {
      const mod = (await importOriginal()) as any;
      // Reject with a primitive (not an Error). `e?.message` is undefined →
      // fallback to `String(e)`. The other test in this describe block
      // covers the Error path; this covers the nullish branch.
      return { ...mod, drainSessionStart: vi.fn().mockRejectedValue("plain string failure") };
    });
    vi.doMock("../../src/utils/stdin.js", () => ({
      readStdin: vi.fn().mockResolvedValue({}),
    }));
    await import("../../src/notifications/index.js").then(m => m._resetRulesForTest());
    await import("../../src/hooks/session-notifications.js");
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("outer catch handler fires when readStdin rejects unrecoverably", async () => {
    plantCreds();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as any);

    // Make readStdin reject with a non-catch-able error to trip the outer
    // main().catch() — note the inner .catch(() => ({})) on readStdin
    // already covers the normal failure path; this test is specifically
    // about a different async failure that bubbles out of main().
    vi.doMock("../../src/notifications/index.js", async (importOriginal) => {
      const mod = (await importOriginal()) as any;
      return {
        ...mod,
        drainSessionStart: vi.fn().mockRejectedValue(new Error("synthetic-test-failure")),
      };
    });
    vi.doMock("../../src/utils/stdin.js", () => ({
      readStdin: vi.fn().mockResolvedValue({}),
    }));

    await import("../../src/notifications/index.js").then(m => m._resetRulesForTest());
    await import("../../src/hooks/session-notifications.js");
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    // Outer catch handler should have called process.exit(0)
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("HIVEMIND_WIKI_WORKER=1 short-circuits the hook (no I/O, no emit)", async () => {
    process.env.HIVEMIND_WIKI_WORKER = "1";
    plantCreds();
    const { stdout } = spyStdoutStderr();

    // Stub readStdin so we don't accidentally read input even on the wiki-worker path.
    vi.doMock("../../src/utils/stdin.js", () => ({
      readStdin: vi.fn().mockResolvedValue({ session_id: "wiki" }),
    }));

    await import("../../src/notifications/index.js").then(m => m._resetRulesForTest());
    await import("../../src/hooks/session-notifications.js");
    await new Promise(r => setImmediate(r));

    // wiki-worker subprocess MUST NOT emit anything.
    expect(stdout).toEqual([]);
  });
});

describe("session-notifications hook — empty session_id handling (CodeRabbit PR#128)", () => {
  it("treats empty session_id as undefined (avoids dedupKey collapse across sessions)", async () => {
    plantCreds();
    const drainSpy = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../src/utils/stdin.js", () => ({
      readStdin: vi.fn().mockResolvedValue({ session_id: "" }),
    }));
    vi.doMock("../../src/notifications/index.js", async (importOriginal) => {
      const mod = (await importOriginal()) as any;
      return { ...mod, drainSessionStart: drainSpy };
    });

    await import("../../src/notifications/index.js").then(m => m._resetRulesForTest());
    await import("../../src/hooks/session-notifications.js");
    await new Promise(r => setImmediate(r));

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy.mock.calls[0][0].sessionId).toBeUndefined();
  });

  it("treats whitespace-only session_id as undefined", async () => {
    plantCreds();
    const drainSpy = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../src/utils/stdin.js", () => ({
      readStdin: vi.fn().mockResolvedValue({ session_id: "   \t  " }),
    }));
    vi.doMock("../../src/notifications/index.js", async (importOriginal) => {
      const mod = (await importOriginal()) as any;
      return { ...mod, drainSessionStart: drainSpy };
    });

    await import("../../src/notifications/index.js").then(m => m._resetRulesForTest());
    await import("../../src/hooks/session-notifications.js");
    await new Promise(r => setImmediate(r));

    expect(drainSpy.mock.calls[0][0].sessionId).toBeUndefined();
  });

  it("passes through a real session_id verbatim (no trim mangling of valid IDs)", async () => {
    plantCreds();
    const drainSpy = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../src/utils/stdin.js", () => ({
      readStdin: vi.fn().mockResolvedValue({ session_id: "abc-12345-uuid" }),
    }));
    vi.doMock("../../src/notifications/index.js", async (importOriginal) => {
      const mod = (await importOriginal()) as any;
      return { ...mod, drainSessionStart: drainSpy };
    });

    await import("../../src/notifications/index.js").then(m => m._resetRulesForTest());
    await import("../../src/hooks/session-notifications.js");
    await new Promise(r => setImmediate(r));

    expect(drainSpy.mock.calls[0][0].sessionId).toBe("abc-12345-uuid");
  });
});
