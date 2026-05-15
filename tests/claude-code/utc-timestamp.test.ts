import { describe, it, expect } from "vitest";
import { utcTimestamp } from "../../src/utils/debug.js";

describe("utcTimestamp", () => {
  it("formats a known date as YYYY-MM-DD HH:MM:SS UTC", () => {
    const d = new Date("2026-04-10T23:49:01.123Z");
    expect(utcTimestamp(d)).toBe("2026-04-10 23:49:01 UTC");
  });

  it("defaults to current time and ends with UTC", () => {
    const result = utcTimestamp();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });

  it("uses UTC regardless of local timezone", () => {
    // Midnight UTC should show 00:00:00, not a local offset
    const d = new Date("2026-01-15T00:00:00.000Z");
    expect(utcTimestamp(d)).toBe("2026-01-15 00:00:00 UTC");
  });
});
