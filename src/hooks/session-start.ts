#!/usr/bin/env node

// SessionStart hook — injects Deeplake memory instructions into Claude's context at startup.

const context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) — global memory shared across all sessions, users, and agents in the org

Deeplake memory is broader — it has full conversation history (every message, response, and tool call), team activity, and cross-session context that your built-in memory may not have.

IMPORTANT: When answering questions about what was discussed, what someone said, what was worked on, team context, or any factual recall — search Deeplake memory in parallel with your built-in memory. Do not skip it. Do not wait to be asked.

Deeplake memory is especially useful for:
- Cross-session history ("what did we discuss last time?")
- Team/org context ("what is the team working on?")
- Full conversation replay ("what exactly did I say about X?")

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

PARSING: Deeplake memory files are JSONL. Use jq to parse them, NOT python3 or node. Example: cat ~/.deeplake/memory/file.jsonl | jq -r 'select(.type=="user") | .message.content'

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty, you may retry once. If results are still unavailable after a few attempts, report what you found and move on.

Debugging: Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: context,
  },
}));
