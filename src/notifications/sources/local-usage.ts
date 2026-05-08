/**
 * Local usage source — derives a weekly recap notification from
 * `~/.deeplake/usage-stats.jsonl` records written by the SessionEnd hook.
 *
 * Cadence: ONE notification per ISO week, per machine. The dedup_key
 * carries the ISO-week identifier so the notifications-state file's
 * existing dedup logic suppresses re-fires within the week even if the
 * user opens many sessions.
 *
 * Skip conditions (silently — empty notification list returned):
 *   - no records at all (first-time user)
 *   - fewer than 2 sessions in the lookback window (one-off use; report
 *     would feel premature)
 *   - zero cache-read tokens AND zero input tokens (no real activity to
 *     report — likely a string of empty-/quick-exit sessions)
 *
 * Failure mode: any read or parse error falls back to "no notifications"
 * — the SessionStart hook continues unaffected.
 */

import type { Notification } from "../types.js";
import { filterRecentRecords, readUsageRecords, sumMetric } from "../usage-tracker.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("notifications-local-usage", msg);

const LOOKBACK_DAYS = 7;
const MIN_SESSIONS_FOR_RECAP = 2;

/**
 * Compute the ISO-8601 week number identifier for a given date, formatted
 * as `YYYY-Www` so dedup compares correctly across year boundaries.
 *
 * Algorithm follows ISO 8601: week 1 is the week containing the first
 * Thursday of the year. Edge cases (Jan 1 in week 52/53 of previous year,
 * Dec 28-31 in week 1 of next year) are handled by Thursday-shift.
 */
export function isoWeekId(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of this ISO week — that determines the week's year.
  const dayNum = d.getUTCDay() || 7; // ISO: Sunday = 7, not 0
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  // Week number = number of weeks since week 1's Thursday.
  const week1Thursday = new Date(Date.UTC(year, 0, 4));
  const week1DayNum = week1Thursday.getUTCDay() || 7;
  const week1ThursdayShifted = new Date(week1Thursday);
  week1ThursdayShifted.setUTCDate(week1Thursday.getUTCDate() + 4 - week1DayNum);
  const week = 1 + Math.round((d.getTime() - week1ThursdayShifted.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${year}-W${week.toString().padStart(2, "0")}`;
}

/**
 * Format a token count into a short human-readable string.
 * 1234 → "1.2k", 12345 → "12k", 1234567 → "1.2M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * Synchronously compute the local-usage notification (if any) for a
 * SessionStart drain. Pure-ish — reads the local stats file but no
 * network and no writes. Returns [] when no recap is warranted.
 */
export function fetchLocalUsageNotifications(now: Date = new Date()): Notification[] {
  let all;
  try {
    all = readUsageRecords();
  } catch (e: any) {
    log(`readUsageRecords threw: ${e?.message ?? String(e)}`);
    return [];
  }

  const recent = filterRecentRecords(all, LOOKBACK_DAYS, now);
  if (recent.length < MIN_SESSIONS_FOR_RECAP) {
    log(`only ${recent.length} session(s) in last ${LOOKBACK_DAYS}d — skipping recap`);
    return [];
  }

  const cacheRead = sumMetric(recent, "cacheReadTokens");
  const inputTokens = sumMetric(recent, "inputTokens");
  const outputTokens = sumMetric(recent, "outputTokens");
  if (cacheRead === 0 && inputTokens === 0 && outputTokens === 0) {
    log("no token volume in window — skipping recap");
    return [];
  }

  const weekId = isoWeekId(now);
  const sessionCount = recent.length;
  const totalProcessed = cacheRead + inputTokens + outputTokens;

  // Title is severity-prefix-safe (no emoji that collides with the info "🐝"
  // prefix the renderer adds). Body keeps to 1-2 lines per the framework's
  // ≤280 char convention so it stays glanceable at session start.
  const title = `Your week with hivemind — ${formatTokens(cacheRead)} cached tokens reused`;
  const body =
    `Across ${sessionCount} session${sessionCount === 1 ? "" : "s"} in the last ${LOOKBACK_DAYS} days, hivemind helped Claude reuse ${formatTokens(cacheRead)} tokens of cached context — ` +
    `the bulk of input is served from cache instead of fresh tokens. Total volume processed: ${formatTokens(totalProcessed)}.`;

  return [
    {
      id: "local-usage:weekly-recap",
      severity: "info",
      title,
      body,
      // dedupKey is keyed only on the ISO-week id so the recap fires once
      // per week even as more sessions accumulate within that window.
      dedupKey: { week: weekId },
    },
  ];
}
