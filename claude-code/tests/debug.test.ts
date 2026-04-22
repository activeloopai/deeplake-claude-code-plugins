import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for src/utils/debug.ts — two tiny helpers:
 *   - utcTimestamp(d?) formats a Date as `YYYY-MM-DD HH:MM:SS UTC`.
 *   - log(tag, msg) appends a line to ~/.deeplake/hook-debug.log only when
 *     HIVEMIND_DEBUG === "1"; it's a no-op otherwise.
 *
 * The module reads HIVEMIND_DEBUG at import time (top-level const DEBUG),
 * so each test sets the env var before doing a fresh dynamic import via
 * vi.resetModules() + await import().
 */

const homedirMock = vi.fn();
const appendFileSyncMock = vi.fn();

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homedirMock() };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, appendFileSync: (...a: any[]) => appendFileSyncMock(...a) };
});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "debug-test-"));
  homedirMock.mockReset().mockReturnValue(tmp);
  appendFileSyncMock.mockReset();
  delete process.env.HIVEMIND_DEBUG;
});

afterEach(() => {
  delete process.env.HIVEMIND_DEBUG;
  try { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function importDebug() {
  vi.resetModules();
  return await import("../../src/utils/debug.js");
}

describe("utcTimestamp", () => {
  it("formats a specific date in 'YYYY-MM-DD HH:MM:SS UTC' form", async () => {
    const { utcTimestamp } = await importDebug();
    const d = new Date("2026-04-22T09:05:07.123Z");
    expect(utcTimestamp(d)).toBe("2026-04-22 09:05:07 UTC");
  });

  it("defaults to 'now' when no date is passed", async () => {
    const { utcTimestamp } = await importDebug();
    const out = utcTimestamp();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });
});

describe("log", () => {
  it("is a no-op when HIVEMIND_DEBUG is unset", async () => {
    const { log } = await importDebug();
    log("tag", "msg");
    expect(appendFileSyncMock).not.toHaveBeenCalled();
  });

  it("is a no-op when HIVEMIND_DEBUG is '0' (only '1' enables it)", async () => {
    process.env.HIVEMIND_DEBUG = "0";
    const { log } = await importDebug();
    log("tag", "msg");
    expect(appendFileSyncMock).not.toHaveBeenCalled();
  });

  it("appends to ~/.deeplake/hook-debug.log when HIVEMIND_DEBUG === '1'", async () => {
    process.env.HIVEMIND_DEBUG = "1";
    const { log } = await importDebug();
    log("pre-tool-use", "reading /sessions/alice.jsonl");

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, line] = appendFileSyncMock.mock.calls[0];
    expect(path).toBe(join(tmp, ".deeplake", "hook-debug.log"));
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[pre-tool-use\] reading \/sessions\/alice\.jsonl\n$/,
    );
  });
});
