import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the org-stats source BEFORE importing local-usage so the source's
// import resolution picks up the mock. `vi.hoisted` is required because
// vi.mock factories are hoisted above top-level consts; `vi.hoisted`
// makes the mock fn available at hoist time.
const { orgStatsMock } = vi.hoisted(() => ({ orgStatsMock: vi.fn() }));
vi.mock("../../src/notifications/sources/org-stats.js", () => ({
  fetchOrgStats: orgStatsMock,
}));

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
  // Lower the offline-mode threshold to 0 for most tests; tests that
  // specifically verify the threshold itself set their own value within
  // the `it` block.
  ORIGINAL_MIN_SESSIONS = process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
  process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "0";
  // Default the org-stats mock to "no server data" so tests exercise the
  // offline (local jsonl) path unless they explicitly opt into the online
  // path. Keeps the bulk of the existing offline-mode tests unchanged.
  orgStatsMock.mockReset();
  orgStatsMock.mockResolvedValue(null);
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

describe("fetchLocalUsageNotifications — skip conditions (offline mode)", () => {
  it("returns [] when sessionId is undefined (no stable dedupKey)", async () => {
    appendUsageRecord(rec({ memorySearchBytes: 5000 }));
    expect(await fetchLocalUsageNotifications(undefined, undefined)).toEqual([]);
  });

  it("returns [] when no records exist", async () => {
    expect(await fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("returns [] when records exist but all have 0 memorySearchBytes", async () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 0, memorySearchCount: 0 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 0, memorySearchCount: 0 }));
    expect(await fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("never throws — corrupt stats file just yields no recap", async () => {
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(join(TEMP_HOME, ".deeplake", "usage-stats.jsonl"), "{not-json}\n", "utf-8");
    await expect(fetchLocalUsageNotifications("sess-abc", undefined)).resolves.toEqual([]);
  });
});

describe("fetchLocalUsageNotifications — offline recap (jsonl fallback)", () => {
  it("renders the savings headline + supporting line with cumulative numbers", async () => {
    // 3 sessions, total 12000 memorySearchBytes → Y = 3000 tokens →
    // Z = 0.7 × 3000 = 2100 tokens → "2.1k"
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 2 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 5 }));
    appendUsageRecord(rec({ sessionId: "s-3", memorySearchBytes: 4000, memorySearchCount: 3 }));
    const out = await fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out).toHaveLength(1);
    const n = out[0];
    expect(n.id).toBe("local-usage:savings-recap");
    expect(n.severity).toBe("info");
    expect(n.title).toBe("Hivemind has saved you ~2.1k tokens");
    expect(n.body).toContain("3 sessions");
    expect(n.body).toContain("10 memory searches");
    expect(n.dedupKey).toEqual({ session: "sess-abc", mode: "offline" });
  });

  it("singular phrasing for 1 session / 1 search", async () => {
    appendUsageRecord(rec({ sessionId: "only", memorySearchBytes: 8000, memorySearchCount: 1 }));
    const out = await fetchLocalUsageNotifications("sess-z", undefined);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("1 session ·");
    expect(out[0].body).toContain("1 memory search");
  });

  it("dedupKey rotates between sessions so each session refires", async () => {
    appendUsageRecord(rec({ sessionId: "any", memorySearchBytes: 4000, memorySearchCount: 1 }));
    appendUsageRecord(rec({ sessionId: "any", memorySearchBytes: 4000, memorySearchCount: 1 }));
    const a = await fetchLocalUsageNotifications("session-A", undefined);
    const b = await fetchLocalUsageNotifications("session-B", undefined);
    expect(a[0].dedupKey).toEqual({ session: "session-A", mode: "offline" });
    expect(b[0].dedupKey).toEqual({ session: "session-B", mode: "offline" });
    expect(a[0].dedupKey).not.toEqual(b[0].dedupKey);
  });

  it("anti-puffery: no $-figure, no unsupported percentages", async () => {
    appendUsageRecord(rec({ memorySearchBytes: 5000 }));
    appendUsageRecord(rec({ memorySearchBytes: 5000 }));
    const out = await fetchLocalUsageNotifications("sess-abc", undefined);
    const fullText = out[0].title + "\n" + out[0].body;
    expect(fullText).not.toMatch(/\$/);
    expect(fullText).not.toMatch(/\d+%\s*(off|cheaper|reduction|less|saved)/i);
  });
});

describe("fetchLocalUsageNotifications — skills-generated segment (offline mode)", () => {
  function credsWithName(userName: string) {
    return { token: undefined, userName, apiUrl: undefined, orgId: undefined } as any;
  }

  it("appends 'N skills generated' to body when ~/.claude/skills has dirs matching --<userName>", async () => {
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

    const out = await fetchLocalUsageNotifications("sess-abc", credsWithName("kamo"));
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("3 skills generated");
    expect(out[0].body).toMatch(/2 sessions · 4 memory searches · 3 skills generated$/);
  });

  it("singular 'skill generated' phrasing when only 1 matches the userName", async () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 1 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 1 }));
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "only-one--kamo"));

    const out = await fetchLocalUsageNotifications("sess-abc", credsWithName("kamo"));
    expect(out[0].body).toContain("1 skill generated");
    expect(out[0].body).not.toContain("1 skills generated");
  });

  it("OMITS the skills segment when userName is undefined (no anchor for the match)", async () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 2 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 2 }));
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "skill-one--kamo"));

    const out = await fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out[0].body).not.toContain("skills generated");
    expect(out[0].body).toContain("2 sessions");
    expect(out[0].body).toContain("4 memory searches");
  });

  it("OMITS the skills segment when no dirs match this userName (avoids 0 indictment)", async () => {
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 4000, memorySearchCount: 2 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 4000, memorySearchCount: 2 }));
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "their-skill--levon"));
    fs.mkdirSync(path.join(dir, "another--emanuele.fenocchi"));

    const out = await fetchLocalUsageNotifications("sess-abc", credsWithName("kamo"));
    expect(out[0].body).not.toContain("skills generated");
  });
});

describe("fetchLocalUsageNotifications — offline-mode threshold (HIVEMIND_NOTIFICATIONS_MIN_SESSIONS)", () => {
  it("returns [] when records < threshold even if memorySearchBytes > 0", async () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "20";
    // 10 records → below threshold of 20 → no fire
    for (let i = 0; i < 10; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(await fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("fires when records == threshold (boundary)", async () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "20";
    for (let i = 0; i < 20; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    const out = await fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("20 sessions");
  });

  it("fires when records > threshold", async () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "20";
    for (let i = 0; i < 50; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    const out = await fetchLocalUsageNotifications("sess-abc", undefined);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("50 sessions");
  });

  it("defaults to threshold of 20 when env var is unset", async () => {
    delete process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
    // 19 records → below the 20 default → no fire
    for (let i = 0; i < 19; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(await fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("non-integer env var falls back to default 20", async () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "not-a-number";
    for (let i = 0; i < 10; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(await fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("negative env var falls back to default 20", async () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "-5";
    for (let i = 0; i < 10; i++) {
      appendUsageRecord(rec({ sessionId: `s-${i}`, memorySearchBytes: 5000, memorySearchCount: 3 }));
    }
    expect(await fetchLocalUsageNotifications("sess-abc", undefined)).toEqual([]);
  });

  it("env var of 0 disables the threshold (used by other tests in this file)", async () => {
    process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS = "0";
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 5000, memorySearchCount: 3 }));
    appendUsageRecord(rec({ sessionId: "s-2", memorySearchBytes: 5000, memorySearchCount: 3 }));
    expect(await fetchLocalUsageNotifications("sess-abc", undefined)).toHaveLength(1);
  });
});

describe("fetchLocalUsageNotifications — online recap (org-stats path)", () => {
  // Online mode is selected when fetchOrgStats() returns data AND the
  // caller's personal recall count meets the MIN_PERSONAL_RECALLS threshold
  // (5). When personal activity is below that bar, we fall through to the
  // offline recap regardless of how impressive the team's totals are —
  // the team-wide banner shouldn't read as aspirational marketing for a
  // user who hasn't run hivemind themselves yet.

  it("renders 'your team' headline when personal recalls >= 5", async () => {
    // 10M org bytes → Y_org = 2.5M tokens, Z_org = 0.7 × 2.5M = 1.75M → "1.8M"
    // 400k user bytes → Y_user = 100k tokens, Z_user = 70k → "70k"
    orgStatsMock.mockResolvedValueOnce({
      org:  { sessionsCount: 187, memoryRecallCount: 42000, memorySearchBytes: 10_000_000 },
      user: { sessionsCount: 22,  memoryRecallCount: 510,   memorySearchBytes: 400_000 },
    });

    const out = await fetchLocalUsageNotifications("sess-online", { token: "t" } as any);
    expect(out).toHaveLength(1);
    const n = out[0];
    expect(n.id).toBe("local-usage:savings-recap");
    expect(n.title).toBe("Hivemind has saved your team ~1.8M tokens");
    expect(n.body).toContain("42,000 memory recalls");
    expect(n.body).toContain("across 187 sessions");
    expect(n.body).toContain("you contributed ~70.0k saved");
    // Online dedupKey carries `mode: "online"` so a switch between modes
    // on the same session re-fires under fresh state.
    expect(n.dedupKey).toEqual({ session: "sess-online", mode: "online" });
  });

  it("falls back to offline recap when user.memoryRecallCount < threshold (5)", async () => {
    orgStatsMock.mockResolvedValueOnce({
      org:  { sessionsCount: 10000, memoryRecallCount: 50000, memorySearchBytes: 100_000_000 },
      user: { sessionsCount: 1, memoryRecallCount: 4, memorySearchBytes: 200 }, // 4 < 5
    });
    // Seed local jsonl to drive the offline path.
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 8000, memorySearchCount: 2 }));
    const out = await fetchLocalUsageNotifications("sess-x", { token: "t" } as any);
    expect(out).toHaveLength(1);
    expect(out[0].title).toMatch(/^Hivemind has saved you ~/);  // "you", not "your team"
    expect(out[0].dedupKey).toEqual({ session: "sess-x", mode: "offline" });
  });

  it("falls back to offline recap when server returns null", async () => {
    orgStatsMock.mockResolvedValueOnce(null);
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 8000, memorySearchCount: 2 }));
    const out = await fetchLocalUsageNotifications("sess-y", { token: "t" } as any);
    expect(out).toHaveLength(1);
    expect(out[0].title).toMatch(/^Hivemind has saved you ~/);
    expect(out[0].dedupKey).toEqual({ session: "sess-y", mode: "offline" });
  });

  it("anti-puffery: online banner has no $-figure / no '%' claims", async () => {
    orgStatsMock.mockResolvedValueOnce({
      org:  { sessionsCount: 100, memoryRecallCount: 1000, memorySearchBytes: 1_000_000 },
      user: { sessionsCount: 10,  memoryRecallCount: 50,   memorySearchBytes: 100_000 },
    });
    const out = await fetchLocalUsageNotifications("sess-z", { token: "t" } as any);
    const fullText = out[0].title + "\n" + out[0].body;
    expect(fullText).not.toMatch(/\$/);
    expect(fullText).not.toMatch(/\d+%\s*(off|cheaper|reduction|less|saved)/i);
  });

  it("appends N skills generated to online body when local skill dirs exist", async () => {
    orgStatsMock.mockResolvedValueOnce({
      org:  { sessionsCount: 100, memoryRecallCount: 1000, memorySearchBytes: 1_000_000 },
      user: { sessionsCount: 10,  memoryRecallCount: 50,   memorySearchBytes: 100_000 },
    });
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(TEMP_HOME, ".claude", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "skill-a--kamo"));
    fs.mkdirSync(path.join(dir, "skill-b--kamo"));

    const out = await fetchLocalUsageNotifications("sess-skills", { token: "t", userName: "kamo" } as any);
    expect(out[0].body).toContain("2 skills generated");
  });
});
