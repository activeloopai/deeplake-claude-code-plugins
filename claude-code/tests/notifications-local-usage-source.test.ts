import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchLocalUsageNotifications,
  formatBytes,
  formatTokens,
  isoWeekId,
} from "../../src/notifications/sources/local-usage.js";
import {
  appendUsageRecord,
  type UsageRecord,
} from "../../src/notifications/usage-tracker.js";

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    endedAt: "2026-05-07T12:00:00Z",
    sessionId: "s",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheCreationTokens: 200,
    assistantTurns: 5,
    model: "claude-opus-4-7",
    hivemindInjectedBytes: 4000,
    memorySearchCount: 1,
    memorySearchBytes: 6000,
    ...over,
  };
}

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-local-usage-test-"));
  ORIGINAL_HOME = process.env.HOME;
  process.env.HOME = TEMP_HOME;
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("isoWeekId", () => {
  it("identifies the standard middle-of-year week", () => {
    expect(isoWeekId(new Date("2026-05-08T12:00:00Z"))).toBe("2026-W19");
  });

  it("uses the Thursday-shift to assign Jan 1 to the prior year's week 53 when applicable", () => {
    // Jan 1 2027 is a Friday → ISO week 53 of 2026.
    expect(isoWeekId(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  it("returns padded two-digit week numbers under 10", () => {
    // Mid-January 2026: ISO week 03.
    expect(isoWeekId(new Date("2026-01-15T12:00:00Z"))).toBe("2026-W03");
  });

  it("Sunday is the last day of the same ISO week as the preceding Monday", () => {
    expect(isoWeekId(new Date("2026-05-04T00:00:00Z"))).toBe(isoWeekId(new Date("2026-05-10T23:59:59Z")));
  });
});

describe("formatBytes", () => {
  it("returns '0 B' for non-positive or non-finite", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
  it("renders bytes / KB / MB / GB", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe("2.00 GB");
  });
});

describe("formatTokens", () => {
  it("returns '0' for non-positive or non-finite inputs", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });

  it("formats sub-thousand counts as integers", () => {
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with one decimal up to 100k", () => {
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(99499)).toBe("99.5k");
  });

  it("formats >=100k as integer thousands without decimals", () => {
    expect(formatTokens(123456)).toBe("123k");
  });

  it("formats millions with one decimal", () => {
    expect(formatTokens(1500000)).toBe("1.5M");
  });
});

describe("fetchLocalUsageNotifications — skip conditions", () => {
  it("returns [] when no records exist", () => {
    expect(fetchLocalUsageNotifications()).toEqual([]);
  });

  it("returns [] when fewer than 2 sessions in the lookback window", () => {
    appendUsageRecord(rec({ sessionId: "only-one", endedAt: "2026-05-07T00:00:00Z" }));
    const now = new Date("2026-05-08T00:00:00Z");
    expect(fetchLocalUsageNotifications(now)).toEqual([]);
  });

  it("returns [] when records exist but all are outside the lookback window", () => {
    appendUsageRecord(rec({ sessionId: "old-1", endedAt: "2026-04-01T00:00:00Z" }));
    appendUsageRecord(rec({ sessionId: "old-2", endedAt: "2026-04-02T00:00:00Z" }));
    appendUsageRecord(rec({ sessionId: "old-3", endedAt: "2026-04-03T00:00:00Z" }));
    const now = new Date("2026-05-08T00:00:00Z");
    expect(fetchLocalUsageNotifications(now)).toEqual([]);
  });

  it("returns [] when 2+ sessions exist but no memory searches happened", () => {
    const noSearch = { memorySearchCount: 0, memorySearchBytes: 0 };
    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-07T00:00:00Z", ...noSearch }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-07T01:00:00Z", ...noSearch }));
    const now = new Date("2026-05-08T00:00:00Z");
    expect(fetchLocalUsageNotifications(now)).toEqual([]);
  });

  it("returns [] when searches counted but zero bytes returned", () => {
    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-07T00:00:00Z", memorySearchCount: 3, memorySearchBytes: 0 }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-07T01:00:00Z", memorySearchCount: 3, memorySearchBytes: 0 }));
    const now = new Date("2026-05-08T00:00:00Z");
    expect(fetchLocalUsageNotifications(now)).toEqual([]);
  });
});

describe("fetchLocalUsageNotifications — emits a notification (delivered fallback)", () => {
  // The dev-env memory store is a FUSE mount that returns 0 from
  // statSync, so memoryStoreSizeBytes() returns 0 here. That triggers the
  // "delivered" fallback (Z' = Y form): the recap headline is
  //   "Hivemind delivered ~Nk tokens of past context this week".
  // Tests covering the Memori-style "saved" framing live below in a
  // separate describe; they bootstrap a local memory store under TEMP_HOME
  // so memoryStoreSizeBytes() returns a real positive value.

  it("renders the delivered-fallback headline + supporting line when store size is 0", () => {
    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-05T12:00:00Z", memorySearchCount: 3, memorySearchBytes: 6000 }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-06T12:00:00Z", memorySearchCount: 5, memorySearchBytes: 7000 }));
    appendUsageRecord(rec({ sessionId: "s-3", endedAt: "2026-05-07T12:00:00Z", memorySearchCount: 4, memorySearchBytes: 5000 }));
    const now = new Date("2026-05-08T12:00:00Z");

    const out = fetchLocalUsageNotifications(now);
    expect(out).toHaveLength(1);
    const n = out[0];
    expect(n.id).toBe("local-usage:weekly-recap");
    expect(n.severity).toBe("info");
    // 18000 bytes / 4 = 4500 tokens → "4.5k"
    expect(n.title).toBe("Hivemind delivered ~4.5k tokens of past context this week");
    expect(n.body).toContain("from your hivemind memory store");
    expect(n.body).toContain("3 sessions");
    expect(n.body).toContain("12 memory searches");
    expect(n.body.split("\n")).toHaveLength(2);
    expect(n.dedupKey).toEqual({ week: "2026-W19" });
  });

  it("renders the Memori-style 'saved' headline when memory store IS measurable", () => {
    // Bootstrap a real-on-disk store under TEMP_HOME so memoryStoreSizeBytes
    // returns a positive value larger than the retrieved bytes.
    const fs = require("node:fs");
    const path = require("node:path");
    const memDir = path.join(TEMP_HOME, ".deeplake", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    // Write 280 KB of content so the "saved" line reports a sensible delta.
    fs.writeFileSync(path.join(memDir, "store.txt"), "x".repeat(280 * 1024), "utf-8");

    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-05T12:00:00Z", memorySearchCount: 3, memorySearchBytes: 6000 }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-06T12:00:00Z", memorySearchCount: 5, memorySearchBytes: 6000 }));
    const out = fetchLocalUsageNotifications(new Date("2026-05-08T12:00:00Z"));
    expect(out).toHaveLength(1);
    const n = out[0];
    // 280 KB / 4 = ~70k tokens stored; 12000 bytes / 4 = 3000 tokens retrieved
    // Saved ≈ 70k − 3k = 67k → "67k"
    expect(n.title).toMatch(/^Hivemind saved you ~\d+(\.\d+)?k tokens this week$/);
    expect(n.body).toMatch(/selective retrieval from your .+? memory store/);
    expect(n.body).toContain("2 sessions");
    expect(n.body).toContain("8 memory searches");
  });

  it("dedupKey rotates between ISO weeks (so a new week re-fires)", () => {
    appendUsageRecord(rec({ sessionId: "s-w19a", endedAt: "2026-05-05T12:00:00Z" }));
    appendUsageRecord(rec({ sessionId: "s-w19b", endedAt: "2026-05-06T12:00:00Z" }));
    appendUsageRecord(rec({ sessionId: "s-w20a", endedAt: "2026-05-12T12:00:00Z" }));
    appendUsageRecord(rec({ sessionId: "s-w20b", endedAt: "2026-05-13T12:00:00Z" }));
    const week19 = fetchLocalUsageNotifications(new Date("2026-05-08T12:00:00Z"));
    const week20 = fetchLocalUsageNotifications(new Date("2026-05-15T12:00:00Z"));
    expect(week19).toHaveLength(1);
    expect(week20).toHaveLength(1);
    expect(week19[0].dedupKey).toEqual({ week: "2026-W19" });
    expect(week20[0].dedupKey).toEqual({ week: "2026-W20" });
  });

  it("never throws — corrupt stats file just yields no recap", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(join(TEMP_HOME, ".deeplake", "usage-stats.jsonl"), "{not-json}\n", "utf-8");
    expect(() => fetchLocalUsageNotifications()).not.toThrow();
    expect(fetchLocalUsageNotifications()).toEqual([]);
  });

  it("body never makes UNSUPPORTED claims — $-figure and percentage guards", () => {
    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-07T12:00:00Z" }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-07T13:00:00Z" }));
    const out = fetchLocalUsageNotifications(new Date("2026-05-08T12:00:00Z"));
    const body = out[0].body;
    const fullText = out[0].title + "\n" + body;
    // $-figures depend on model pricing — skip until ratesheet is parameterized.
    expect(fullText).not.toMatch(/\$/);
    // Percentage savings claims need benchmark backing — none yet.
    expect(fullText).not.toMatch(/\d+%\s*(off|cheaper|reduction|less|saved)/i);
  });
});
