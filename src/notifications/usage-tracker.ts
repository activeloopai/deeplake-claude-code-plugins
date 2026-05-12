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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  /** Tokens read from prompt cache. Anthropic-side accounting; not
   *  attributable to hivemind alone (the cache holds system prompt, tool
   *  defs, prior turns, AND the hivemind context block — hivemind is one
   *  contributor among many). Kept for context but not used in user-facing
   *  "savings" claims. */
  cacheReadTokens: number;
  /** Tokens written to prompt cache during this session. */
  cacheCreationTokens: number;
  /** Number of assistant turns in the transcript. */
  assistantTurns: number;
  /** Model id reported in the transcript (e.g. "claude-opus-4-7"). May be empty. */
  model: string;
  /** Total BYTES of `additionalContext` + `systemMessage` emitted by hivemind's
   *  SessionStart hooks this session. This is the precise volume of context
   *  hivemind injected — measurable, deterministic. Divided by 4 yields an
   *  approximate token count for surfacing in the weekly recap.
   *
   *  Filter: only attachments whose command path contains
   *  `plugins/hivemind/bundle/` count. Counts both the memory hook's
   *  additionalContext AND the notifications hook's systemMessage. */
  hivemindInjectedBytes: number;
  /** Count of Bash tool calls whose command references `deeplake/memory` —
   *  i.e. Claude actively grep/cat/find'd the user's memory store during
   *  the session. Direct evidence of mid-session use of hivemind. */
  memorySearchCount: number;
  /** Total BYTES of `tool_result` content returned from those memory-lookup
   *  Bash calls — the actual past-session content hivemind put into the
   *  context window mid-session. Bytes / 4 ≈ tokens delivered to Claude.
   *  This is the load-bearing input to the weekly recap's "delivered"
   *  number; the rest of the fields are supporting/diagnostic. */
  memorySearchBytes: number;
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
            // Backward compatibility: records written before
            // feat/onboarding-notifications slice 2 don't carry these
            // fields — read them as 0 so older records still aggregate
            // cleanly alongside new ones.
            hivemindInjectedBytes: typeof rec.hivemindInjectedBytes === "number" ? rec.hivemindInjectedBytes : 0,
            memorySearchCount: typeof rec.memorySearchCount === "number" ? rec.memorySearchCount : 0,
            memorySearchBytes: typeof rec.memorySearchBytes === "number" ? rec.memorySearchBytes : 0,
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

/**
 * Sum the byte size of every regular file under `~/.deeplake/memory/`. Used
 * by the weekly recap as a "your team's collective memory size" datum.
 *
 * Walks the directory iteratively (no recursion-depth risk) and tolerates
 * permission errors on individual files — they just contribute 0. Returns
 * 0 if the memory dir doesn't exist.
 */
export function memoryStoreSizeBytes(): number {
  const root = join(homedir(), ".deeplake", "memory");
  if (!existsSync(root)) return 0;
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          // unreadable — skip
        }
      }
    }
  }
  return total;
}

