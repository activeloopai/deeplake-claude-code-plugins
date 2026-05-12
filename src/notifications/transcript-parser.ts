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

interface AssistantContentMessage extends AssistantMessage {
  content?: ToolUseContent[];
}

interface UserContentMessage {
  role?: string;
  content?: ToolResultContent[];
}

interface HookAttachment {
  hookEvent?: unknown;
  command?: unknown;
  stdout?: unknown;
  type?: unknown;
}

interface TranscriptLine {
  type?: string;
  message?: AssistantContentMessage | UserContentMessage;
  attachment?: HookAttachment;
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
    hivemindInjectedBytes: 0,
    memorySearchCount: 0,
    memorySearchBytes: 0,
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
  let hivemindInjectedBytes = 0;
  let memorySearchCount = 0;
  let memorySearchBytes = 0;
  // Track tool_use ids that targeted hivemind memory so we can match them
  // against the corresponding tool_result later in the file and sum bytes
  // returned. The pair (use, result) is guaranteed not to be on the same
  // line in Claude Code transcripts.
  const memoryLookupToolUseIds = new Set<string>();

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

    // Hivemind SessionStart hook attachments — these record the EXACT bytes
    // hivemind injected into the model's context. We accept any successful
    // attachment whose command path points at the hivemind bundle (resolved
    // or unresolved CLAUDE_PLUGIN_ROOT).
    const att = entry.attachment;
    if (
      att &&
      typeof att.command === "string" &&
      att.hookEvent === "SessionStart" &&
      att.command.includes("plugins/hivemind/bundle/") &&
      typeof att.stdout === "string"
    ) {
      hivemindInjectedBytes += countHivemindEmittedBytes(att.stdout);
    }

    // Assistant turn — sum usage AND scan tool-use entries for memory
    // lookups so we can report mid-session hivemind use.
    const msg = entry.message as AssistantContentMessage | UserContentMessage | undefined;
    if (msg && msg.role === "assistant") {
      const am = msg as AssistantContentMessage;
      if (am.usage) {
        const u = am.usage;
        inputTokens += asNonNegativeNumber(u.input_tokens);
        outputTokens += asNonNegativeNumber(u.output_tokens);
        cacheReadTokens += asNonNegativeNumber(u.cache_read_input_tokens);
        cacheCreationTokens += asNonNegativeNumber(u.cache_creation_input_tokens);
        assistantTurns += 1;
        if (typeof am.model === "string" && am.model && !model) model = am.model;
      }
      if (Array.isArray(am.content)) {
        for (const c of am.content) {
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
      }
    } else if (msg && msg.role === "user" && Array.isArray((msg as UserContentMessage).content)) {
      // User-role messages carry tool_result entries whose `tool_use_id`
      // matches the earlier tool_use. If the use was a memory lookup,
      // sum the bytes of content the model received — those are the
      // bytes hivemind actually delivered into the context window.
      const um = msg as UserContentMessage;
      for (const c of um.content ?? []) {
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
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    assistantTurns,
    model,
    hivemindInjectedBytes,
    memorySearchCount,
    memorySearchBytes,
  };
}

/**
 * Best-effort byte length of a tool_result content field. Claude transcript
 * `content` is sometimes a string, sometimes an array of `{type, text}` parts.
 * We sum text part lengths and fall back to JSON-stringified length for
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

/**
 * Given the captured stdout of a hivemind SessionStart hook, return the
 * byte-length of every text-bearing field the hook contributed to the
 * model's context. Counts both:
 *   - `hookSpecificOutput.additionalContext` (the model-side context block)
 *   - `systemMessage` (the user-visible banner — also rendered to the model)
 *
 * Anything that doesn't parse cleanly returns 0 — the recap silently
 * undercounts rather than overstates.
 */
export function countHivemindEmittedBytes(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: unknown };
      systemMessage?: unknown;
    };
    let n = 0;
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof ctx === "string") n += Buffer.byteLength(ctx, "utf-8");
    const sys = parsed?.systemMessage;
    if (typeof sys === "string") n += Buffer.byteLength(sys, "utf-8");
    return n;
  } catch {
    return 0;
  }
}

/**
 * True if a Bash tool-call command looks like a lookup against the user's
 * hivemind memory store. We intentionally match by substring — the actual
 * surface includes grep/cat/head/tail/ls/find/jq invocations and even
 * compound shell pipelines, so trying to enumerate every "read-style"
 * verb is brittle. A path reference to `.deeplake/memory` is itself
 * strong signal that hivemind memory was being read.
 */
export function isMemoryLookupCommand(command: string): boolean {
  return command.includes(".deeplake/memory");
}
