import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, ensureDir, writeVersionStamp, log } from "./util.js";
import { getVersion } from "./version.js";

// pi (badlogic/pi-mono `packages/coding-agent`) integration.
//
// pi's documented context surfaces:
//   - ~/.pi/agent/AGENTS.md           — global context (concatenated with cwd-walked AGENTS.md)
//   - ~/.pi/agent/skills/<name>/      — agentskills.io-compatible skills
//   - ~/.pi/agent/extensions/<name>/  — TypeScript extensions registering tools and
//                                        subscribing to lifecycle events (pi.on("tool_call", ...))
//
// This installer ships the AGENTS.md hook + the skill drop, which together
// give pi recall capability via direct grep on ~/.deeplake/memory/. The
// auto-capture path (TS extension wired to pi.on("tool_call", ...)) lands
// in the follow-up alongside the hivemind MCP server.
//
// Verify against current pi docs before changing the format:
//   https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md

const PI_AGENT_DIR = join(HOME, ".pi", "agent");
const AGENTS_MD = join(PI_AGENT_DIR, "AGENTS.md");
const SKILL_DIR = join(PI_AGENT_DIR, "skills", "hivemind-memory");
const VERSION_DIR = join(PI_AGENT_DIR, ".hivemind");

const HIVEMIND_BLOCK_START = "<!-- BEGIN hivemind-memory -->";
const HIVEMIND_BLOCK_END = "<!-- END hivemind-memory -->";

const HIVEMIND_BLOCK_BODY = `${HIVEMIND_BLOCK_START}
## Hivemind Memory

You have access to global org memory at \`~/.deeplake/memory/\`. Always check both
your local context AND Hivemind memory when the user asks you to recall, look up,
or remember anything.

- Start with \`~/.deeplake/memory/index.md\` (table of all sessions)
- Then read specific summaries at \`~/.deeplake/memory/summaries/<user>/<session>.md\`
- Only fall back to raw \`~/.deeplake/memory/sessions/<user>/*.jsonl\` if summaries don't have enough detail
- Search: use \`grep\` (NOT \`rg\`/ripgrep — \`rg\` is not always installed). Example: \`grep -ri "keyword" ~/.deeplake/memory/\`

Use only bash builtins (cat, ls, grep, jq, head, tail, sed, awk, wc, sort, find) to read this filesystem —
rg/ripgrep, node, python, curl are not available there.
${HIVEMIND_BLOCK_END}`;

const SKILL_BODY = `---
name: hivemind-memory
description: Global team and org memory powered by Activeloop. Always check both local context AND Hivemind memory when recalling information.
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

function upsertHivemindBlock(existing: string | null): string {
  const block = HIVEMIND_BLOCK_BODY;
  if (!existing) return `${block}\n`;
  // Strip any pre-existing hivemind block, then re-append.
  const startIdx = existing.indexOf(HIVEMIND_BLOCK_START);
  if (startIdx === -1) return `${existing.trimEnd()}\n\n${block}\n`;
  const endIdx = existing.indexOf(HIVEMIND_BLOCK_END, startIdx);
  if (endIdx === -1) {
    // Malformed prior block — append fresh and let the user clean up.
    return `${existing.trimEnd()}\n\n${block}\n`;
  }
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + HIVEMIND_BLOCK_END.length).replace(/^\n+/, "");
  const rest = after ? `\n\n${after}` : "";
  return `${before ? before + "\n\n" : ""}${block}\n${rest}`;
}

function stripHivemindBlock(existing: string): string {
  const startIdx = existing.indexOf(HIVEMIND_BLOCK_START);
  if (startIdx === -1) return existing;
  const endIdx = existing.indexOf(HIVEMIND_BLOCK_END, startIdx);
  if (endIdx === -1) return existing;
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + HIVEMIND_BLOCK_END.length).replace(/^\n+/, "");
  if (!before && !after) return "";
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

export function installPi(): void {
  ensureDir(PI_AGENT_DIR);

  // Skill drop
  ensureDir(SKILL_DIR);
  writeFileSync(join(SKILL_DIR, "SKILL.md"), SKILL_BODY);

  // AGENTS.md hivemind block (idempotent upsert)
  const prior = existsSync(AGENTS_MD) ? readFileSync(AGENTS_MD, "utf-8") : null;
  const next = upsertHivemindBlock(prior);
  writeFileSync(AGENTS_MD, next);

  ensureDir(VERSION_DIR);
  writeVersionStamp(VERSION_DIR, getVersion());

  log(`  pi             skill installed -> ${SKILL_DIR}`);
  log(`  pi             AGENTS.md updated -> ${AGENTS_MD}`);
}

export function uninstallPi(): void {
  if (existsSync(SKILL_DIR)) {
    rmSync(SKILL_DIR, { recursive: true, force: true });
    log(`  pi             removed ${SKILL_DIR}`);
  }
  if (existsSync(AGENTS_MD)) {
    const prior = readFileSync(AGENTS_MD, "utf-8");
    const stripped = stripHivemindBlock(prior);
    if (stripped.trim().length === 0) {
      rmSync(AGENTS_MD, { force: true });
      log(`  pi             removed empty ${AGENTS_MD}`);
    } else {
      writeFileSync(AGENTS_MD, stripped);
      log(`  pi             stripped hivemind block from ${AGENTS_MD}`);
    }
  }
  if (existsSync(VERSION_DIR)) {
    rmSync(VERSION_DIR, { recursive: true, force: true });
  }
}
