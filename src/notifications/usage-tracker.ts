/**
 * Local usage stats — durable record of per-session token usage written at
 * SessionEnd, read at SessionStart for the weekly-recap notification.
 *
 * Storage: `~/.deeplake/usage-stats.jsonl`. JSONL one record per session.
 * Append-only at write time; the SessionStart-side reader filters by
 * `endedAt` so old records don't need active pruning. A separate compaction
 * pass (to be added when the file grows large) can drop pre-month records.
 *
 * Failure mode: every operation is fail-soft. A broken stats file must
 * never break a SessionEnd or SessionStart hook — it just means the recap
 * skips this week.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("usage-tracker", msg);

export interface UsageRecord {
  /** ISO 8601 timestamp the session ended. */
  endedAt: string;
  /** Agent session_id (Claude Code session UUID, etc.). */
  sessionId: string;
  /** Tokens billed by the model provider as fresh input (excludes cache reads). */
  inputTokens: number;
  /** Tokens billed for output (assistant text). */
  outputTokens: number;
  /** Tokens read from prompt cache — substantially cheaper than fresh input
   *  and the dominant savings driver from session-start memory injection. */
  cacheReadTokens: number;
  /** Tokens written to prompt cache during this session. */
  cacheCreationTokens: number;
  /** Number of assistant turns in the transcript. */
  assistantTurns: number;
  /** Model id reported in the transcript (e.g. "claude-opus-4-7"). May be empty. */
  model: string;
}

/**
 * Resolve the stats file path lazily (per-call) instead of caching at module
 * load. Tests override `process.env.HOME` per-case; a cached path would freeze
 * the value the test process started with and leak writes to the real $HOME.
 */
export function statsFilePath(): string {
  return join(homedir(), ".deeplake", "usage-stats.jsonl");
}

function ensureStatsDir(): void {
  const dir = dirname(statsFilePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Append a usage record. Failures are logged and swallowed.
 */
export function appendUsageRecord(record: UsageRecord): void {
  try {
    ensureStatsDir();
    appendFileSync(statsFilePath(), JSON.stringify(record) + "\n", "utf-8");
    log(`appended record session=${record.sessionId} cacheRead=${record.cacheReadTokens}`);
  } catch (e: any) {
    log(`appendUsageRecord failed: ${e?.message ?? String(e)}`);
  }
}

/**
 * Read all usage records. Returns [] on missing file or read error.
 * Malformed lines are skipped individually so a partially-corrupt file
 * still yields the records that ARE valid.
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
        if (
          typeof rec.endedAt === "string" &&
          typeof rec.sessionId === "string" &&
          typeof rec.inputTokens === "number" &&
          typeof rec.outputTokens === "number" &&
          typeof rec.cacheReadTokens === "number" &&
          typeof rec.cacheCreationTokens === "number" &&
          typeof rec.assistantTurns === "number"
        ) {
          out.push({
            endedAt: rec.endedAt,
            sessionId: rec.sessionId,
            inputTokens: rec.inputTokens,
            outputTokens: rec.outputTokens,
            cacheReadTokens: rec.cacheReadTokens,
            cacheCreationTokens: rec.cacheCreationTokens,
            assistantTurns: rec.assistantTurns,
            model: typeof rec.model === "string" ? rec.model : "",
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
 * Filter records to those that ended in the last `days` days. Records with
 * unparseable `endedAt` are dropped.
 */
export function filterRecentRecords(records: UsageRecord[], days: number, now: Date = new Date()): UsageRecord[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return records.filter(r => {
    const t = Date.parse(r.endedAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Sum a metric across records. Records missing/non-numeric values count
 * as 0 so a partially-degraded record doesn't poison the aggregate.
 */
export function sumMetric(records: UsageRecord[], key: keyof UsageRecord): number {
  let total = 0;
  for (const r of records) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}

/**
 * Stat the stats file size in bytes. Returns 0 if missing or unreadable.
 * Used by future compaction logic; exported now to keep the public surface
 * stable.
 */
export function statsFileSizeBytes(): number {
  try {
    if (!existsSync(statsFilePath())) return 0;
    return statSync(statsFilePath()).size;
  } catch {
    return 0;
  }
}

