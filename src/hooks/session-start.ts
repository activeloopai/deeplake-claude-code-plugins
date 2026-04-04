#!/usr/bin/env node

// SessionStart hook — injects Deeplake memory instructions into Claude's context at startup.

const context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) — complete conversation history from ALL sessions, ALL users, ALL agents in the org. Contains information you may not have in your built-in memory.

IMPORTANT: When answering questions about what was discussed, what someone said, what was worked on, team context, or any factual recall — search Deeplake memory in parallel with your built-in memory. Do not skip it. Do not wait to be asked.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: context,
  },
}));
