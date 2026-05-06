/**
 * Extract prompt+answer pairs from Deeplake sessions table rows.
 *
 * All four agents (claude-code, codex, cursor, hermes) normalize their
 * native JSONL events into the same row taxonomy in Deeplake:
 *   - type: "user_message"      → conversational prompt
 *   - type: "assistant_message" → conversational answer
 *   - type: "tool_call"         → tool use / result (DROPPED)
 *
 * Thinking blocks never reach Deeplake (capture skips them), so no
 * additional filtering is needed at extraction time.
 *
 * If/when an agent diverges from this taxonomy, add a per-agent extractor
 * here and dispatch on the row's `agent` column.
 */

export interface SessionRow {
  type?: string;
  content?: string;
  creation_date?: string;
  session_id?: string;
  agent?: string;
}

export interface Pair {
  sessionId: string;
  agent: string | null;
  date: string | null;
  prompt: string;
  answer: string;
}

/**
 * Pair user prompts with the immediately following assistant message(s).
 *
 * Rows are expected sorted by creation_date ASC. Multiple assistant messages
 * between two prompts are concatenated into a single answer string.
 *
 * Tool calls and any unrecognized rows are silently dropped.
 *
 * Pairs without an assistant follow-up (the in-flight final prompt of a live
 * session) are NOT emitted — the worker fires on Stop, so the last message
 * before fire is always an assistant answer in our happy path. This guard
 * exists so a malformed session (or an early-aborted turn) does not produce
 * a {prompt, answer: ""} pair the gate has to filter.
 */
export function extractPairs(rows: SessionRow[]): Pair[] {
  const pairs: Pair[] = [];
  let pendingPrompt: { content: string; row: SessionRow } | null = null;
  let pendingAnswer: string[] = [];

  function flush(): void {
    if (pendingPrompt && pendingAnswer.length > 0) {
      pairs.push({
        sessionId: pendingPrompt.row.session_id ?? "",
        agent: pendingPrompt.row.agent ?? null,
        date: pendingPrompt.row.creation_date ?? null,
        prompt: pendingPrompt.content,
        answer: pendingAnswer.join("\n\n"),
      });
    }
    pendingPrompt = null;
    pendingAnswer = [];
  }

  for (const r of rows) {
    if (r.type === "user_message" && typeof r.content === "string") {
      flush();
      pendingPrompt = { content: r.content, row: r };
    } else if (r.type === "assistant_message" && typeof r.content === "string" && pendingPrompt) {
      // Only buffer answers when there's a prompt waiting. Stray
      // assistant messages without a preceding prompt are dropped.
      if (r.content.trim().length > 0) pendingAnswer.push(r.content);
    }
    // Everything else (tool_call, stop, unknown) is silently dropped.
  }
  flush();
  return pairs;
}
