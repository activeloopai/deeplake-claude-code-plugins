/**
 * Local usage source — derives a weekly recap notification from
 * `~/.deeplake/usage-stats.jsonl` records written by the SessionEnd hook.
 *
 * Cadence: ONE notification per ISO week, per machine. The dedup_key
 * carries the ISO-week identifier so the notifications-state file's
 * existing dedup logic suppresses re-fires within the week even if the
 * user opens many sessions.
 *
 * ── Formula (kept deliberately plain — see issue #99 followup) ────────────
 *
 *   X − Y = Z
 *
 *   X = memoryStoreTokens         (≈ store_size_bytes / 4)
 *   Y = memoryRetrievedTokens     (≈ sum of memorySearchBytes / 4 over window)
 *   Z = tokens "saved" this week  (selective retrieval vs full-context-dump
 *                                  baseline; Memori/Mem0 paper framing,
 *                                  arXiv:2603.19935, arXiv:2504.19413)
 *
 *   Baseline assumed: without hivemind's selective retrieval, the user would
 *   load the entire memory store into context every session. Z = the gap
 *   between that hypothetical full-dump cost and what was actually retrieved.
 *
 * v1 fallback ("delivered" framing): when the memory store size is not
 * measurable from the agent process (e.g. cloud-backed mount where node
 * `statSync` returns 0 on every file — known limitation, see
 * `usage-tracker.ts memoryStoreSizeBytes()`), we cannot compute X. We fall
 * back to a simpler, defensible claim:
 *
 *   Z' = Y   (tokens hivemind delivered to Claude this week)
 *
 * Z' is a lower bound on Z (every retrieved token IS a token hivemind put
 * into the window; Z' makes no claim about what was NOT retrieved). When
 * deeplake-api ships a memory-size endpoint we upgrade the recap to the
 * full X − Y = Z form. Until then this is the honest claim.
 *
 * Skip conditions (silently — empty notification list returned):
 *   - no records at all (first-time user)
 *   - fewer than MIN_SESSIONS_FOR_RECAP sessions in the lookback window
 *   - no memory searches in the window (nothing hivemind-specific to claim)
 *
 * Failure mode: any read or parse error falls back to "no notifications"
 * — the SessionStart hook continues unaffected.
 */

import type { Notification } from "../types.js";
import { filterRecentRecords, memoryStoreSizeBytes, readUsageRecords, sumMetric } from "../usage-tracker.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("notifications-local-usage", msg);

const LOOKBACK_DAYS = 7;
const MIN_SESSIONS_FOR_RECAP = 2;
/** Bytes per token — rough English-text heuristic for BPE tokenizers
 *  (Claude/GPT). Range across content is ~3.5-5; we use 4 with a `~` in
 *  the rendered output to signal approximation. */
const BYTES_PER_TOKEN = 4;

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
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const week1Thursday = new Date(Date.UTC(year, 0, 4));
  const week1DayNum = week1Thursday.getUTCDay() || 7;
  const week1ThursdayShifted = new Date(week1Thursday);
  week1ThursdayShifted.setUTCDate(week1Thursday.getUTCDate() + 4 - week1DayNum);
  const week = 1 + Math.round((d.getTime() - week1ThursdayShifted.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${year}-W${week.toString().padStart(2, "0")}`;
}

/** 1234 → "1.2k", 12345 → "12.3k", 1234567 → "1.2M". `~` is added by caller. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/** 1234 → "1.2 KB", 1500000 → "1.4 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Synchronously compute the local-usage notification (if any) for a
 * SessionStart drain. Pure-ish — reads the local stats file + stats the
 * memory dir (best-effort), no network and no writes.
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

  const sessions = recent.length;
  const memorySearches = sumMetric(recent, "memorySearchCount");
  const memorySearchBytes = sumMetric(recent, "memorySearchBytes");

  // No memory searches = no hivemind-specific value delivered this week.
  // Render nothing rather than a vacuous banner.
  if (memorySearches === 0 || memorySearchBytes === 0) {
    log(`no memory searches in window — skipping recap`);
    return [];
  }

  const weekId = isoWeekId(now);

  // ── Apply formula (see comment at top of file) ──
  //
  //   X = memoryStoreTokens     (= memoryStoreSizeBytes() / 4)
  //   Y = memoryRetrievedTokens (= memorySearchBytes / 4)
  //   Z = X − Y                  if X is measurable (> 0)
  //   Z' = Y                     if X is unmeasurable (cloud-backed mount,
  //                              FUSE returning 0, etc. — known v1 limitation)
  //
  // We pick whichever form we can defend.
  const memoryStoreBytes = memoryStoreSizeBytes();
  const X = memoryStoreBytes / BYTES_PER_TOKEN;
  const Y = memorySearchBytes / BYTES_PER_TOKEN;

  let title: string;
  let baselineLine: string;
  if (X > 0 && X > Y) {
    // Memori-style: full-context-dump baseline.
    const Z = X - Y;
    title = `Hivemind saved you ~${formatTokens(Z)} tokens this week`;
    baselineLine = `selective retrieval from your ${formatBytes(memoryStoreBytes)} memory store`;
  } else {
    // Fallback: delivered framing. Honest lower bound until we wire a
    // server-side memory-size endpoint (issue #99 v1.1 followup).
    const Z = Y;
    title = `Hivemind delivered ~${formatTokens(Z)} tokens of past context this week`;
    baselineLine = `from your hivemind memory store`;
  }
  const activityLine = `${sessions} ${sessions === 1 ? "session" : "sessions"} · ${memorySearches} memory ${memorySearches === 1 ? "search" : "searches"}`;

  return [
    {
      id: "local-usage:weekly-recap",
      severity: "info",
      title,
      body: `   ${baselineLine}\n   ${activityLine}`,
      dedupKey: { week: weekId },
    },
  ];
}
