/**
 * Claude Code transcript parser — extracts a UsageRecord from a JSONL
 * transcript file at SessionEnd.
 *
 * Each transcript line is an object whose shape varies (user/assistant/
 * tool_result/attachment/etc.). Only assistant turns carry `message.usage`
 * — we sum those token fields across the file.
 *
 * Robustness goals:
 *   - tolerate unknown line types (just skip them)
 *   - tolerate malformed JSON lines (skip individually)
 *   - tolerate missing usage fields on a turn (treat as 0)
 *   - never throw; return zeros on file read failure
 */

import { existsSync, readFileSync } from "node:fs";
import type { UsageRecord } from "./usage-tracker.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("transcript-parser", msg);

interface AssistantUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface AssistantMessage {
  type?: string;
  role?: string;
  model?: unknown;
  usage?: AssistantUsage;
}

interface TranscriptLine {
  type?: string;
  message?: AssistantMessage;
  timestamp?: unknown;
  sessionId?: unknown;
}

function asNonNegativeNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Parse a transcript JSONL file and return aggregated usage. The returned
 * record's `endedAt` is the timestamp of the LAST line that has one; if no
 * line carries a timestamp, `now` is used. `sessionId` is extracted from
 * the transcript when available, falling back to `fallbackSessionId`.
 */
export function parseTranscript(
  transcriptPath: string,
  fallbackSessionId: string,
  now: Date = new Date(),
): UsageRecord {
  const empty: UsageRecord = {
    endedAt: now.toISOString(),
    sessionId: fallbackSessionId,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    assistantTurns: 0,
    model: "",
  };

  if (!transcriptPath || !existsSync(transcriptPath)) {
    log(`transcript missing: ${transcriptPath}`);
    return empty;
  }

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch (e: any) {
    log(`read failed: ${e?.message ?? String(e)}`);
    return empty;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let assistantTurns = 0;
  let model = "";
  let sessionId = fallbackSessionId;
  let endedAt = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }

    if (typeof entry.timestamp === "string") endedAt = entry.timestamp;
    if (typeof entry.sessionId === "string" && entry.sessionId) sessionId = entry.sessionId;

    const msg = entry.message;
    if (!msg || msg.role !== "assistant" || !msg.usage) continue;

    const u = msg.usage;
    inputTokens += asNonNegativeNumber(u.input_tokens);
    outputTokens += asNonNegativeNumber(u.output_tokens);
    cacheReadTokens += asNonNegativeNumber(u.cache_read_input_tokens);
    cacheCreationTokens += asNonNegativeNumber(u.cache_creation_input_tokens);
    assistantTurns += 1;
    if (typeof msg.model === "string" && msg.model && !model) model = msg.model;
  }

  return {
    endedAt: endedAt || now.toISOString(),
    sessionId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    assistantTurns,
    model,
  };
}
