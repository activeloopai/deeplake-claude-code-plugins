import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME, ensureDir, writeVersionStamp, log } from "./util.js";
import { getVersion } from "./version.js";

// Hermes Agent (NousResearch/hermes-agent) integration.
//
// Hermes' documented extensibility surface is the agentskills.io-compatible
// skills system at ~/.hermes/skills/<skill-name>/, plus first-class MCP
// integration. The README does not document a Python PluginManager API with
// pre/post_tool_call lifecycle events at the time of writing.
//
// Therefore: this installer ships a skill file (recall capability via direct
// grep on ~/.deeplake/memory/). The MCP-based path that gives recall via tool
// calls lands in the next PR alongside the hivemind MCP server. Auto-capture
// for Hermes is not yet supported.
//
// Verify against current Hermes docs before changing the format:
//   - https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
//   - https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp

const HERMES_HOME = join(HOME, ".hermes");
const SKILLS_DIR = join(HERMES_HOME, "skills", "hivemind-memory");

const SKILL_BODY = `---
name: hivemind-memory
description: Global team and org memory powered by Activeloop. ALWAYS check BOTH built-in memory AND Hivemind memory when recalling information.
---

# Hivemind Memory

You have persistent memory at \`~/.deeplake/memory/\` — global memory shared across all sessions, users, and agents in the org.

## Memory Structure

\`\`\`
~/.deeplake/memory/
├── index.md                          ← START HERE — table of all sessions
├── summaries/
│   ├── session-abc.md                ← AI-generated wiki summary
│   └── session-xyz.md
└── sessions/
    └── username/
        ├── user_org_ws_slug1.jsonl   ← raw session data
        └── user_org_ws_slug2.jsonl
\`\`\`

## How to Search

1. **First**: Read \`~/.deeplake/memory/index.md\` — quick scan of all sessions with dates, projects, descriptions
2. **If you need details**: Read the specific summary at \`~/.deeplake/memory/summaries/<session>.md\`
3. **If you need raw data**: Read the session JSONL at \`~/.deeplake/memory/sessions/<user>/<file>.jsonl\`
4. **Keyword search**: \`grep -r "keyword" ~/.deeplake/memory/\`

Do NOT jump straight to reading raw JSONL files. Always start with index.md and summaries.

## Important Constraints

- Use \`grep\` (NOT \`rg\`/ripgrep) for keyword search — \`rg\` may not be installed on the host system.
- Only use these bash builtins to interact with \`~/.deeplake/memory/\`: \`cat\`, \`ls\`, \`grep\`, \`echo\`, \`jq\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, \`wc\`, \`sort\`, \`find\`. The memory filesystem does NOT support \`rg\`, \`python\`, \`python3\`, \`node\`, or \`curl\`.
- If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than retrying exhaustively.
`;

export function installHermes(): void {
  ensureDir(SKILLS_DIR);
  writeFileSync(join(SKILLS_DIR, "SKILL.md"), SKILL_BODY);
  writeVersionStamp(SKILLS_DIR, getVersion());
  log(`  Hermes         skill installed -> ${SKILLS_DIR}`);
}

export function uninstallHermes(): void {
  if (existsSync(SKILLS_DIR)) {
    rmSync(SKILLS_DIR, { recursive: true, force: true });
    log(`  Hermes         removed ${SKILLS_DIR}`);
  } else {
    log("  Hermes         nothing to remove");
  }
}
