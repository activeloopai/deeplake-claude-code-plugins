import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchLocalUsageNotifications,
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

  it("returns [] when 2+ sessions exist but ALL token totals are zero", () => {
    appendUsageRecord(rec({ sessionId: "empty-1", endedAt: "2026-05-07T00:00:00Z", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }));
    appendUsageRecord(rec({ sessionId: "empty-2", endedAt: "2026-05-07T01:00:00Z", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }));
    const now = new Date("2026-05-08T00:00:00Z");
    expect(fetchLocalUsageNotifications(now)).toEqual([]);
  });
});

describe("fetchLocalUsageNotifications — emits a notification", () => {
  it("emits one info-severity notification with weekly recap content when conditions are met", () => {
    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-05T12:00:00Z", cacheReadTokens: 5000, inputTokens: 500, outputTokens: 200 }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-06T12:00:00Z", cacheReadTokens: 7000, inputTokens: 600, outputTokens: 250 }));
    appendUsageRecord(rec({ sessionId: "s-3", endedAt: "2026-05-07T12:00:00Z", cacheReadTokens: 8000, inputTokens: 700, outputTokens: 300 }));
    const now = new Date("2026-05-08T12:00:00Z");

    const out = fetchLocalUsageNotifications(now);
    expect(out).toHaveLength(1);
    const n = out[0];
    expect(n.id).toBe("local-usage:weekly-recap");
    expect(n.severity).toBe("info");
    // Total cache-read: 20000 → "20.0k"
    expect(n.title).toContain("20.0k");
    expect(n.title).toContain("hivemind");
    // Body mentions session count
    expect(n.body).toContain("3 sessions");
    expect(n.body).toContain("20.0k");
    // dedupKey is keyed on ISO-week-id only
    expect(n.dedupKey).toEqual({ week: "2026-W19" });
  });

  it("dedupKey rotates between ISO weeks (so a new week re-fires)", () => {
    // Two pairs of records — one pair in each week's lookback window.
    // The 7-day filter must find at least 2 sessions for either call to fire.
    appendUsageRecord(rec({ sessionId: "s-w19a", endedAt: "2026-05-05T12:00:00Z", cacheReadTokens: 5000 }));
    appendUsageRecord(rec({ sessionId: "s-w19b", endedAt: "2026-05-06T12:00:00Z", cacheReadTokens: 7000 }));
    appendUsageRecord(rec({ sessionId: "s-w20a", endedAt: "2026-05-12T12:00:00Z", cacheReadTokens: 4000 }));
    appendUsageRecord(rec({ sessionId: "s-w20b", endedAt: "2026-05-13T12:00:00Z", cacheReadTokens: 6000 }));
    const week19 = fetchLocalUsageNotifications(new Date("2026-05-08T12:00:00Z"));
    const week20 = fetchLocalUsageNotifications(new Date("2026-05-15T12:00:00Z"));
    expect(week19).toHaveLength(1);
    expect(week20).toHaveLength(1);
    expect(week19[0].dedupKey).not.toEqual(week20[0].dedupKey);
    expect(week19[0].dedupKey).toEqual({ week: "2026-W19" });
    expect(week20[0].dedupKey).toEqual({ week: "2026-W20" });
  });

  it("singular 'session' phrasing when only the boundary case of 2 records on edge of window", () => {
    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-07T12:00:00Z", cacheReadTokens: 1000 }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-07T13:00:00Z", cacheReadTokens: 1000 }));
    const out = fetchLocalUsageNotifications(new Date("2026-05-08T12:00:00Z"));
    expect(out[0].body).toContain("2 sessions");
  });

  it("never throws — corrupt stats file just yields no recap", () => {
    // Inject bad content directly via append (bypassing JSON.stringify).
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(join(TEMP_HOME, ".deeplake", "usage-stats.jsonl"), "{not-json}\n", "utf-8");
    expect(() => fetchLocalUsageNotifications()).not.toThrow();
    expect(fetchLocalUsageNotifications()).toEqual([]);
  });

  it("body never claims 'savings' beyond what cacheRead implies — anti-puffery guard", () => {
    appendUsageRecord(rec({ sessionId: "s-1", endedAt: "2026-05-07T12:00:00Z", cacheReadTokens: 1000 }));
    appendUsageRecord(rec({ sessionId: "s-2", endedAt: "2026-05-07T13:00:00Z", cacheReadTokens: 1000 }));
    const out = fetchLocalUsageNotifications(new Date("2026-05-08T12:00:00Z"));
    const body = out[0].body;
    // We promise "reuse cached context" — not "saved $X" with no math, not
    // "saved 90% on tokens" with no arithmetic. Guard against future edits
    // that introduce unsupported claims.
    expect(body).not.toMatch(/saved \$/i);
    expect(body).not.toMatch(/\d+%\s*(off|cheaper)/i);
  });
});
