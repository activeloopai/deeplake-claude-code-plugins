import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendUsageRecord,
  readUsageRecords,
  statsFilePath,
  sumMetric,
  type UsageRecord,
} from "../../src/notifications/usage-tracker.js";

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    endedAt: "2026-05-13T00:00:00Z",
    sessionId: "s-1",
    memorySearchBytes: 6000,
    memorySearchCount: 3,
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
    appendUsageRecord(rec({ sessionId: "s-1", memorySearchBytes: 6000 }));
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toMatch(/"sessionId":"s-1"/);
    expect(content).toMatch(/"memorySearchBytes":6000/);
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

  it("readUsageRecords backward-compat: accepts records missing memorySearchCount (defaults to 0)", () => {
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    mkdirSync(join(TEMP_HOME, ".deeplake"));
    // Simulate a record written by a prior parser version: no memorySearchCount.
    const legacy = JSON.stringify({
      endedAt: "2026-05-12T18:09:18Z",
      sessionId: "legacy-record",
      memorySearchBytes: 0,
      // memorySearchCount intentionally missing
    });
    writeFileSync(file, legacy + "\n", "utf-8");
    const records = readUsageRecords();
    expect(records).toHaveLength(1);
    expect(records[0].sessionId).toBe("legacy-record");
    expect(records[0].memorySearchCount).toBe(0);
  });

  it("readUsageRecords backward-compat: accepts records missing memorySearchBytes (defaults to 0)", () => {
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    mkdirSync(join(TEMP_HOME, ".deeplake"));
    const legacy = JSON.stringify({
      endedAt: "2026-05-12T18:09:18Z",
      sessionId: "legacy-record",
      // memorySearchBytes intentionally missing
      memorySearchCount: 0,
    });
    writeFileSync(file, legacy + "\n", "utf-8");
    const records = readUsageRecords();
    expect(records).toHaveLength(1);
    expect(records[0].memorySearchBytes).toBe(0);
  });

  it("readUsageRecords still drops records missing the strict minimum (endedAt or sessionId)", () => {
    const file = join(TEMP_HOME, ".deeplake", "usage-stats.jsonl");
    mkdirSync(join(TEMP_HOME, ".deeplake"));
    const noEnded = JSON.stringify({ sessionId: "x", memorySearchBytes: 0, memorySearchCount: 0 });
    const noSession = JSON.stringify({ endedAt: "2026-05-12T00:00:00Z", memorySearchBytes: 0, memorySearchCount: 0 });
    const good = JSON.stringify(rec({ sessionId: "valid" }));
    writeFileSync(file, `${noEnded}\n${noSession}\n${good}\n`, "utf-8");
    expect(readUsageRecords().map(r => r.sessionId)).toEqual(["valid"]);
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
});

describe("usage-tracker — sumMetric", () => {
  const records: UsageRecord[] = [
    rec({ memorySearchBytes: 1000, memorySearchCount: 2 }),
    rec({ memorySearchBytes: 2000, memorySearchCount: 5 }),
    rec({ memorySearchBytes: 3000, memorySearchCount: 1 }),
  ];

  it("sums numeric fields", () => {
    expect(sumMetric(records, "memorySearchBytes")).toBe(6000);
    expect(sumMetric(records, "memorySearchCount")).toBe(8);
  });

  it("returns 0 for empty records list", () => {
    expect(sumMetric([], "memorySearchBytes")).toBe(0);
  });

  it("treats non-numeric entries as 0 — sumMetric is robust", () => {
    const broken = [...records, { ...rec(), memorySearchBytes: NaN as unknown as number }];
    expect(sumMetric(broken, "memorySearchBytes")).toBe(6000);
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

describe("countUserGeneratedSkills", () => {
  it("returns 0 when userName is undefined", async () => {
    const { countUserGeneratedSkills } = await import("../../src/notifications/usage-tracker.js");
    expect(countUserGeneratedSkills(undefined)).toBe(0);
  });

  it("returns 0 when ~/.claude/skills/ does not exist", async () => {
    const { countUserGeneratedSkills } = await import("../../src/notifications/usage-tracker.js");
    expect(countUserGeneratedSkills("kamo.aghbalyan")).toBe(0);
  });

  it("counts dirs whose suffix matches --<userName>", async () => {
    const dir = join(TEMP_HOME, ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "skill-one--kamo.aghbalyan"));
    mkdirSync(join(dir, "skill-two--kamo.aghbalyan"));
    mkdirSync(join(dir, "skill-three--kamo.aghbalyan"));
    mkdirSync(join(dir, "other-skill--levon"));         // different author
    mkdirSync(join(dir, "hivemind-openclaw-capture"));  // no author suffix
    const { countUserGeneratedSkills } = await import("../../src/notifications/usage-tracker.js");
    expect(countUserGeneratedSkills("kamo.aghbalyan")).toBe(3);
  });

  it("does not match a userName that's a prefix of another author", async () => {
    const dir = join(TEMP_HOME, ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "skill-a--kamo"));
    mkdirSync(join(dir, "skill-b--kamo.aghbalyan"));
    const { countUserGeneratedSkills } = await import("../../src/notifications/usage-tracker.js");
    // "kamo" as userName must match only "skill-a--kamo", NOT "skill-b--kamo.aghbalyan"
    expect(countUserGeneratedSkills("kamo")).toBe(1);
    // "kamo.aghbalyan" as userName must match only the longer one
    expect(countUserGeneratedSkills("kamo.aghbalyan")).toBe(1);
  });

  it("requires content before the `--<userName>` suffix (no bare matches)", async () => {
    const dir = join(TEMP_HOME, ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "--kamo"));      // pathological / empty name
    mkdirSync(join(dir, "real--kamo"));
    const { countUserGeneratedSkills } = await import("../../src/notifications/usage-tracker.js");
    expect(countUserGeneratedSkills("kamo")).toBe(1);
  });

  it("returns 0 when no dirs match the userName suffix", async () => {
    const dir = join(TEMP_HOME, ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "skill-x--levon"));
    mkdirSync(join(dir, "skill-y--emanuele.fenocchi"));
    const { countUserGeneratedSkills } = await import("../../src/notifications/usage-tracker.js");
    expect(countUserGeneratedSkills("kamo")).toBe(0);
  });
});
