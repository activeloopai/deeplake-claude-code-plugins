import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchLocalUsageNotifications,
  formatTokens,
} from "../../src/notifications/sources/local-usage.js";
import {
  appendUsageRecord,
  type UsageRecord,
} from "../../src/notifications/usage-tracker.js";

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    endedAt: "2026-05-13T12:00:00Z",
    sessionId: "s",
    memorySearchBytes: 6000,
    memorySearchCount: 3,
    ...over,
  };
}

let ORIGINAL_MIN_SESSIONS: string | undefined;

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-local-usage-test-"));
  ORIGINAL_HOME = process.env.HOME;
  process.env.HOME = TEMP_HOME;
  // Lower the threshold to 0 for most tests; tests that specifically verify
  // the threshold itself set their own value within the `it` block.
  ORIGINAL_MIN_SESSIONS = process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
  process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "0";
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  if (ORIGINAL_MIN_SESSIONS !== undefined) process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = ORIGINAL_MIN_SESSIONS;
  else delete process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("formatTokens", () => {
  it("returns '0' for non-positive or non-finite", () => {
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
  it("returns [] when sessionId is undefined (no stable dedupKey)", () => {
    appendUsageRecord(rec({ memorySearchBytes: 5000 }));
    expect(fetchLocalUsageNotifications(undefined, undefined)).toEqual([]);
  });

  it("returns [] when no records exist", () => {
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("returns [] when records exist but all have 0 memorySearchBytes", () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 0, memorySearchCount: 0 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 0, memorySearchCount: 0 }));
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("never throws — corrupt stats file just yields no recap", () => {
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(join(TEMP_HOME, ".deeplake", "usage-stats.jsonl"), "{not-json}\n", "utf-8");
    expect(() => fetchLocalUsageNotifications("sess-abc", undefined)).not.toThrow();
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });
});

describe("fetchLocalUsageNotifications — emits a notification", () => {
  it("renders the savings headline + supporting line with cumulative numbers", () => {
    // 3 sessions, total 12000 memorySearchBytes → Y = 3000 tokens →
    // Z = 0.7 × 3000 = 2100 tokens → "2.1k"
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 2 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 5 }));
    appendUsageRecord(rec({ sessionId: "s-3", memorySearchBytes: 4000, memorySearchCount: 3 }));
    const out = fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out).toHaveLength(1);
    const n = out[0];
    expect(n.id).toBe("local-usage:savings-recap");
    expect(n.severity).toBe("info");
    expect(n.title).toBe("Hivemind has saved you ~2.1k tokens");
    expect(n.body).toContain("3 sessions");
    expect(n.body).toContain("10 memory searches");
    expect(n.dedupKey).toEqual({ session: "sess-abc" });
  });

  it("singular phrasing for 1 session / 1 search", () => {
    appendUsageRecord(rec({ sessionId: "only", memorySearchBytes: 8000, memorySearchCount: 1 }));
    const out = fetchLocalUsageNotifications("sess-z", undefined);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("1 session ·");
    expect(out[0].body).toContain("1 memory search");
  });

  it("dedupKey rotates between sessions so each session refires", () => {
    appendUsageRecord(rec({ sessionId: "any", memorySearchBytes: 4000, memorySearchCount: 1 }));
    appendUsageRecord(rec({ sessionId: "any", memorySearchBytes: 4000, memorySearchCount: 1 }));
    const a = fetchLocalUsageNotifications("session-A", undefined);
    const b = fetchLocalUsageNotifications("session-B", undefined);
    expect(a[0].dedupKey).toEqual({ session: "session-A" });
    expect(b[0].dedupKey).toEqual({ session: "session-B" });
    expect(a[0].dedupKey).not.toEqual(b[0].dedupKey);
  });

  it("anti-puffery: no $-figure, no unsupported percentages", () => {
    appendUsageRecord(rec({ memorySearchBytes: 5000 }));
    appendUsageRecord(rec({ memorySearchBytes: 5000 }));
    const out = fetchLocalUsageNotifications("sess-abc", undefined);
    const fullText = out[0].title + "\n" + out[0].body;
    expect(fullText).not.toMatch(/\$/);
    expect(fullText).not.toMatch(/\d+%\s*(off|cheaper|reduction|less|saved)/i);
  });
});

describe("fetchLocalUsageNotifications — skills-generated segment", () => {
  it("appends 'N skills generated' to body when ~/.claude/skills has dirs matching --<userName>", () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 2 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 2 }));
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "skill-one--kamo"));
    fs.mkdirSync(path.join(dir, "skill-two--kamo"));
    fs.mkdirSync(path.join(dir, "skill-three--kamo"));
    fs.mkdirSync(path.join(dir, "other-skill--levon"));         // different author — must not count
    fs.mkdirSync(path.join(dir, "hivemind-openclaw-capture"));  // no author suffix — must not count

    const out = fetchLocalUsageNotifications("sess-abc", "kamo");
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("3 skills generated");
    expect(out[0].body).toMatch(/2 sessions · 4 memory searches · 3 skills generated$/);
  });

  it("singular 'skill generated' phrasing when only 1 matches the userName", () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 1 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 1 }));
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "only-one--kamo"));

    const out = fetchLocalUsageNotifications("sess-abc", "kamo");
    expect(out[0].body).toContain("1 skill generated");
    expect(out[0].body).not.toContain("1 skills generated");
  });

  it("OMITS the skills segment when userName is undefined (no anchor for the match)", () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 2 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 2 }));
    // Even with skill dirs on disk, no userName means no count.
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "skill-one--kamo"));

    const out = fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out[0].body).not.toContain("skills generated");
    expect(out[0].body).toContain("2 sessions");
    expect(out[0].body).toContain("4 memory searches");
  });

  it("OMITS the skills segment when no dirs match this userName (avoids 0 indictment)", () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 2 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 2 }));
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "their-skill--levon"));
    fs.mkdirSync(path.join(dir, "another--emanuele.fenocchi"));

    const out = fetchLocalUsageNotifications("sess-abc", "kamo");
    expect(out[0].body).not.toContain("skills generated");
  });
});

describe("fetchLocalUsageNotifications — MIN_SESSIONS_FOR_RECAP threshold", () => {
  it("returns [] when sessions < threshold even if memorySearchBytes > 0", () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "100";
    // 50 records, each with real memory activity. Should NOT fire because below threshold.
    for (let i = 0; i < 50; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("fires when sessions == threshold (boundary)", () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "100";
    for (let i = 0; i < 100; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    const out = fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("100 sessions");
  });

  it("fires when sessions > threshold", () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "100";
    for (let i = 0; i < 150; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    const out = fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("150 sessions");
  });

  it("defaults to threshold of 100 when env var is unset", () => {
    delete process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
    // 99 records → below the 100 default → no fire
    for (let i = 0; i < 99; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("non-integer env var falls back to default 100", () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "not-a-number";
    for (let i = 0; i < 50; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("negative env var falls back to default 100", () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "-5";
    for (let i = 0; i < 50; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("env var of 0 disables the threshold (used by other tests in this file)", () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "0";
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 5000, memorySearchCount: 3 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 5000, memorySearchCount: 3 }));
    expect(fetchLocalUsageNotifications("sess-abc", undefined)).toHaveLength(1);
  });
});
