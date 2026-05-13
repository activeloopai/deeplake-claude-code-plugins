/**
 * Local usage stats — durable per-session record of hivemind memory use,
 * written at SessionEnd and read at SessionStart for the savings recap.
 *
 * Storage: `~/.deeplake/usage-stats.jsonl`. JSONL, one record per session.
 * Append-only at write time. The SessionStart-side reader sums across ALL
 * records (cumulative since install — see plan).
 *
 * Failure mode: every operation is fail-soft. A broken stats file must
 * never break a SessionEnd or SessionStart hook — it just means the recap
 * skips this session.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("usage-tracker", msg);

export interface UsageRecord {
  /** ISO 8601 timestamp the session ended. */
  endedAt: string;
  /** Agent session_id (Claude Code session UUID). */
  sessionId: string;
  /** Bytes of `tool_result.content` returned from Bash tool calls grep'ing
   *  `~/.deeplake/memory/` during this session — the load-bearing input to
   *  the savings formula. memorySearchBytes / 4 ≈ tokens hivemind delivered. */
  memorySearchBytes: number;
  /** Count of Bash tool calls that referenced `.deeplake/memory` — used for
   *  the "M memory searches" supporting line in the recap. */
  memorySearchCount: number;
}

/**
 * Resolve the stats file path lazily (per-call). Tests override
 * `process.env.HOME` per-case; a cached path would freeze the value the
 * test process started with and leak writes to the real $HOME.
 */
export function statsFilePath(): string {
  return join(homedir(), ".deeplake", "usage-stats.jsonl");
}

function ensureStatsDir(): void {
  const dir = dirname(statsFilePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append a usage record. Failures are logged and swallowed. */
export function appendUsageRecord(record: UsageRecord): void {
  try {
    ensureStatsDir();
    appendFileSync(statsFilePath(), JSON.stringify(record) + "\n", "utf-8");
    log(`appended record session=${record.sessionId} memBytes=${record.memorySearchBytes} memCount=${record.memorySearchCount}`);
  } catch (e: any) {
    log(`appendUsageRecord failed: ${e?.message ?? String(e)}`);
  }
}

/**
 * Read all usage records. Returns [] on missing file or read error.
 * Malformed lines are skipped individually so a partially-corrupt file
 * still yields the valid records.
 */
export function readUsageRecords(): UsageRecord[] {
  try {
    if (!existsSync(statsFilePath())) return [];
    const raw = readFileSync(statsFilePath(), "utf-8");
    const out: UsageRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as Partial<UsageRecord>;
        // Strict minimum: endedAt + sessionId. Numeric fields are
        // backward-compat: records written by older parser versions
        // (no `memorySearchCount` field yet, or no `memorySearchBytes`)
        // get the missing values defaulted to 0 rather than dropped.
        // Keeping older records in the aggregate matters — the recap
        // counts "sessions you've used hivemind in," and silently
        // dropping one because its schema lacked a field added later
        // is a subtle bug.
        if (
          typeof rec.endedAt === "string" &&
          typeof rec.sessionId === "string"
        ) {
          out.push({
            endedAt: rec.endedAt,
            sessionId: rec.sessionId,
            memorySearchBytes: typeof rec.memorySearchBytes === "number" ? rec.memorySearchBytes : 0,
            memorySearchCount: typeof rec.memorySearchCount === "number" ? rec.memorySearchCount : 0,
          });
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch (e: any) {
    log(`readUsageRecords failed: ${e?.message ?? String(e)}`);
    return [];
  }
}

/**
 * Sum a numeric field across records. Records missing/non-numeric values
 * count as 0 so a partially-degraded record doesn't poison the aggregate.
 */
export function sumMetric(records: UsageRecord[], key: keyof UsageRecord): number {
  let total = 0;
  for (const r of records) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}
