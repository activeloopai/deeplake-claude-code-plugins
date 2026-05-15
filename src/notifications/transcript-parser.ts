/**
 * Claude Code transcript parser — extracts memory-search byte counts from
 * a session's JSONL transcript at SessionEnd.
 *
 * Goal: compute the ONE load-bearing quantity for the weekly savings recap:
 *   `memorySearchBytes` = total bytes returned from Bash tool calls grep'ing
 *   `~/.deeplake/memory/` — i.e. the actual past-session content hivemind
 *   delivered into Claude's context this session.
 *
 * Mechanics. Each transcript line is a JSON object whose shape varies. We
 * walk the file in order and:
 *   1. When we see an assistant turn with a `tool_use` block where
 *      `name === "Bash"` AND the command references `.deeplake/memory`,
 *      we record the `tool_use_id`.
 *   2. When we later see a user-role message carrying a `tool_result` whose
 *      `tool_use_id` is in our set, we count the byte length of its
 *      `content` (string or `{type,text}[]` array form).
 *   3. Sum across all matched pairs in the session.
 *
 * We also count `memorySearchCount` (number of such Bash calls) for the
 * supporting line in the recap rendering.
 *
 * Robustness:
 *   - tolerate unknown line types (skip them)
 *   - tolerate malformed JSON lines (skip individually)
 *   - tolerate tool_use orphans (no matching result — contributes 0)
 *   - never throw; return zeros on file read failure
 */

import { existsSync, readFileSync } from "node:fs";
import type { UsageRecord } from "./usage-tracker.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("transcript-parser", msg);

interface ToolUseContent {
  type?: string;
  id?: unknown;
  name?: unknown;
  input?: { command?: unknown; [k: string]: unknown };
}

interface ToolResultContent {
  type?: string;
  tool_use_id?: unknown;
  content?: unknown;
}

interface AssistantMessage {
  role?: string;
  content?: ToolUseContent[];
}

interface UserMessage {
  role?: string;
  content?: ToolResultContent[];
}

interface TranscriptLine {
  type?: string;
  message?: AssistantMessage | UserMessage;
  timestamp?: unknown;
  sessionId?: unknown;
}

/**
 * Parse a transcript JSONL and return a complete UsageRecord. `endedAt` is
 * the timestamp of the LAST line that has one, or `now` as a fallback.
 * `sessionId` is extracted from the transcript when available, falling
 * back to `fallbackSessionId`.
 */
export function parseTranscript(
  transcriptPath: string,
  fallbackSessionId: string,
  now: Date = new Date(),
): UsageRecord {
  const empty: UsageRecord = {
    endedAt: now.toISOString(),
    sessionId: fallbackSessionId,
    memorySearchBytes: 0,
    memorySearchCount: 0,
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

  // tool_use_ids whose command targeted hivemind memory. The matching
  // tool_result lands on a later line, so we accumulate ids as we walk.
  const memoryLookupToolUseIds = new Set<string>();

  let memorySearchBytes = 0;
  let memorySearchCount = 0;
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
    if (!msg || !Array.isArray(msg.content)) continue;

    if (msg.role === "assistant") {
      for (const c of msg.content as ToolUseContent[]) {
        if (
          c &&
          c.type === "tool_use" &&
          c.name === "Bash" &&
          c.input &&
          typeof c.input.command === "string" &&
          isMemoryLookupCommand(c.input.command)
        ) {
          memorySearchCount += 1;
          if (typeof c.id === "string") memoryLookupToolUseIds.add(c.id);
        }
      }
    } else if (msg.role === "user") {
      for (const c of msg.content as ToolResultContent[]) {
        if (
          c &&
          c.type === "tool_result" &&
          typeof c.tool_use_id === "string" &&
          memoryLookupToolUseIds.has(c.tool_use_id)
        ) {
          memorySearchBytes += toolResultByteLength(c.content);
        }
      }
    }
  }

  return {
    endedAt: endedAt || now.toISOString(),
    sessionId,
    memorySearchBytes,
    memorySearchCount,
  };
}

/**
 * Match Bash commands that reference the hivemind memory store. We use
 * substring match on `.deeplake/memory` rather than enumerating verbs
 * (grep, cat, rg, find, head, tail, ...) because pipeline shapes vary
 * and a path reference is itself strong signal.
 */
export function isMemoryLookupCommand(command: string): boolean {
  return command.includes(".deeplake/memory");
}

/**
 * Best-effort byte length of a tool_result.content field. Claude transcript
 * `content` is sometimes a string, sometimes an array of `{type,text}` parts.
 * We sum text-part lengths and fall back to JSON-stringified length for
 * unknown shapes. Never throws.
 */
function toolResultByteLength(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf-8");
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        const txt = (part as { text?: unknown }).text;
        if (typeof txt === "string") n += Buffer.byteLength(txt, "utf-8");
      }
    }
    return n;
  }
  try {
    return Buffer.byteLength(JSON.stringify(content ?? ""), "utf-8");
  } catch {
    return 0;
  }
}
