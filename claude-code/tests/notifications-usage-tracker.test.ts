import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendUsageRecord,
  filterRecentRecords,
  readUsageRecords,
  statsFilePath,
  statsFileSizeBytes,
  sumMetric,
  type UsageRecord,
} from "../../src/notifications/usage-tracker.js";

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    endedAt: "2026-05-08T00:00:00Z",
    sessionId: "s-1",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheCreationTokens: 200,
    assistantTurns: 5,
    model: "claude-opus-4-7",
    ...over,
  };
}

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-usage-test-"));
  ORIGINAL_HOME = process.env.HOME;
  process.env.HOME = TEMP_HOME;
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("usage-tracker — append/read", () => {
  it("appendUsageRecord creates ~/.deeplake/usage-stats.jsonl with one JSONL line", () => {
    appendUsageRecord(rec({ sessionId: "s-1", cacheReadTokens: 1000 }));
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toMatch(/"sessionId":"s-1"/);
    expect(content).toMatch(/"cacheReadTokens":1000/);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("appendUsageRecord appends rather than truncates across calls", () => {
    appendUsageRecord(rec({ sessionId: "s-1" }));
    appendUsageRecord(rec({ sessionId: "s-2" }));
    appendUsageRecord(rec({ sessionId: "s-3" }));
    const all = readUsageRecords();
    expect(all.map(r => r.sessionId)).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("appendUsageRecord creates the parent directory if missing", () => {
    expect(existsSync(join(TEMP_HOME, ".deeplake"))).toBe(false);
    appendUsageRecord(rec());
    expect(existsSync(join(TEMP_HOME, ".deeplake"))).toBe(true);
  });

  it("appendUsageRecord swallows errors when HOME points at a non-directory", () => {
    // Point HOME at a regular file. mkdirSync(...recursive:true) on a path
    // that traverses through a non-directory raises ENOTDIR — the catch
    // arm in appendUsageRecord must convert that into a logged no-op.
    const sentinel = join(TEMP_HOME, "sentinel-file");
    writeFileSync(sentinel, "x", "utf-8");
    process.env.HOME = sentinel;
    expect(() => appendUsageRecord(rec())).not.toThrow();
  });

  it("readUsageRecords returns [] when the stats file does not exist", () => {
    expect(readUsageRecords()).toEqual([]);
  });

  it("readUsageRecords skips malformed lines individually", () => {
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    mkdirSync(join(TEMP_HOME, ".deeplake"));
    const goodLine = JSON.stringify(rec({ sessionId: "good" }));
    writeFileSync(
      file,
      `${goodLine}\nnot-json\n{"sessionId":"missing-fields"}\n${JSON.stringify(rec({ sessionId: "good-2" }))}\n`,
      "utf-8",
    );
    const records = readUsageRecords();
    expect(records.map(r => r.sessionId)).toEqual(["good", "good-2"]);
  });

  it("readUsageRecords ignores blank lines without warning", () => {
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    mkdirSync(join(TEMP_HOME, ".deeplake"));
    writeFileSync(
      file,
      `\n\n${JSON.stringify(rec({ sessionId: "only-real" }))}\n\n`,
      "utf-8",
    );
    expect(readUsageRecords().map(r => r.sessionId)).toEqual(["only-real"]);
  });

  it("readUsageRecords falls back to empty model string when missing", () => {
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    mkdirSync(join(TEMP_HOME, ".deeplake"));
    const noModel = { ...rec({ sessionId: "s" }), model: undefined };
    writeFileSync(file, JSON.stringify(noModel) + "\n", "utf-8");
    const records = readUsageRecords();
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe("");
  });
});

describe("usage-tracker — filterRecentRecords", () => {
  const now = new Date("2026-05-08T12:00:00Z");
  const records: UsageRecord[] = [
    rec({ sessionId: "fresh-1d", endedAt: "2026-05-07T12:00:00Z" }),
    rec({ sessionId: "fresh-3d", endedAt: "2026-05-05T12:00:00Z" }),
    rec({ sessionId: "edge-7d-just-in", endedAt: "2026-05-01T13:00:00Z" }),
    rec({ sessionId: "stale-30d", endedAt: "2026-04-08T12:00:00Z" }),
    rec({ sessionId: "no-date", endedAt: "not-a-date" }),
  ];

  it("returns only records ended within the lookback window", () => {
    const recent = filterRecentRecords(records, 7, now);
    expect(recent.map(r => r.sessionId).sort()).toEqual(["edge-7d-just-in", "fresh-1d", "fresh-3d"]);
  });

  it("excludes records with unparseable endedAt", () => {
    expect(filterRecentRecords(records, 7, now).find(r => r.sessionId === "no-date")).toBeUndefined();
  });

  it("returns empty when window is 0 days", () => {
    expect(filterRecentRecords(records, 0, now)).toEqual([]);
  });
});

describe("usage-tracker — sumMetric", () => {
  const records: UsageRecord[] = [
    rec({ cacheReadTokens: 1000, inputTokens: 100 }),
    rec({ cacheReadTokens: 2000, inputTokens: 200 }),
    rec({ cacheReadTokens: 3000, inputTokens: 300 }),
  ];

  it("sums numeric fields", () => {
    expect(sumMetric(records, "cacheReadTokens")).toBe(6000);
    expect(sumMetric(records, "inputTokens")).toBe(600);
  });

  it("returns 0 for empty records list", () => {
    expect(sumMetric([], "cacheReadTokens")).toBe(0);
  });

  it("treats non-numeric (corrupted) entries as 0 — sumMetric is robust", () => {
    const broken = [...records, { ...rec(), cacheReadTokens: NaN as unknown as number }];
    expect(sumMetric(broken, "cacheReadTokens")).toBe(6000);
  });
});

describe("usage-tracker — statsFileSizeBytes", () => {
  it("returns 0 when the stats file does not exist", () => {
    expect(statsFileSizeBytes()).toBe(0);
  });

  it("returns the file size after a write", () => {
    appendUsageRecord(rec());
    const size = statsFileSizeBytes();
    expect(size).toBeGreaterThan(50);
  });
});

describe("usage-tracker — statsFilePath", () => {
  it("resolves lazily under the current HOME", () => {
    expect(statsFilePath().startsWith(TEMP_HOME)).toBe(true);
  });

  it("re-resolves when HOME changes between calls", () => {
    const first = statsFilePath();
    const otherHome = mkdtempSync(join(tmpdir(), "hivemind-usage-test-other-"));
    try {
      process.env.HOME = otherHome;
      const second = statsFilePath();
      expect(second).not.toBe(first);
      expect(second.startsWith(otherHome)).toBe(true);
    } finally {
      process.env.HOME = TEMP_HOME;
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
