import { existsSync, writeFileSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, pkgRoot, ensureDir, writeVersionStamp, log } from "./util.js";
import { getVersion } from "./version.js";

// pi (badlogic/pi-mono `packages/coding-agent`) integration — Tier 1.
//
// pi exposes a rich extension API at
// `pi-mono/packages/coding-agent/src/core/extensions/types.ts` with 25+
// lifecycle events including session_start, input, tool_call, tool_result,
// message_end, and session_shutdown. Our extension subscribes to those for
// auto-capture and registers hivemind_search / hivemind_read / hivemind_index
// as first-class pi tools (since pi has no MCP — see pi README).
//
// Surfaces installed:
//   1. ~/.pi/agent/AGENTS.md — global context (BEGIN/END marker upsert)
//   2. ~/.pi/agent/skills/hivemind-memory/SKILL.md — agent reads on every turn
//   3. ~/.pi/agent/extensions/hivemind.ts — TS extension for autocapture + tools
//
// The extension is shipped as raw .ts; pi's runtime loader compiles it on
// load (uses tsx-style on-the-fly compilation). Self-contained — uses only
// Node builtins + pi types (which pi provides at runtime).

const PI_AGENT_DIR = join(HOME, ".pi", "agent");
const AGENTS_MD = join(PI_AGENT_DIR, "AGENTS.md");
const SKILL_DIR = join(PI_AGENT_DIR, "skills", "hivemind-memory");
const EXTENSIONS_DIR = join(PI_AGENT_DIR, "extensions");
const EXTENSION_PATH = join(EXTENSIONS_DIR, "hivemind.ts");
const VERSION_DIR = join(PI_AGENT_DIR, ".hivemind");

const HIVEMIND_BLOCK_START = "<!-- BEGIN hivemind-memory -->";
const HIVEMIND_BLOCK_END = "<!-- END hivemind-memory -->";

const HIVEMIND_BLOCK_BODY = `${HIVEMIND_BLOCK_START}
## Hivemind Memory

You have access to global org memory at \`~/.deeplake/memory/\`. Always check both
your local context AND Hivemind memory when the user asks you to recall, look up,
or remember anything.

- Three hivemind tools are registered: \`hivemind_search\`, \`hivemind_read\`, \`hivemind_index\`. **Prefer these** — one call returns ranked hits in a single SQL query.
- Fall back to direct filesystem if the tools fail:
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

  // 1. Skill drop — agent context.
  ensureDir(SKILL_DIR);
  writeFileSync(join(SKILL_DIR, "SKILL.md"), SKILL_BODY);

  // 2. AGENTS.md hivemind block (idempotent upsert).
  const prior = existsSync(AGENTS_MD) ? readFileSync(AGENTS_MD, "utf-8") : null;
  const next = upsertHivemindBlock(prior);
  writeFileSync(AGENTS_MD, next);

  // 3. Extension — autocapture + first-class hivemind tools.
  const srcExtension = join(pkgRoot(), "pi", "extension-source", "hivemind.ts");
  if (!existsSync(srcExtension)) {
    throw new Error(`pi extension source missing at ${srcExtension}. Reinstall the @deeplake/hivemind package.`);
  }
  ensureDir(EXTENSIONS_DIR);
  copyFileSync(srcExtension, EXTENSION_PATH);

  ensureDir(VERSION_DIR);
  writeVersionStamp(VERSION_DIR, getVersion());

  log(`  pi             skill installed -> ${SKILL_DIR}`);
  log(`  pi             AGENTS.md updated -> ${AGENTS_MD}`);
  log(`  pi             extension installed -> ${EXTENSION_PATH}`);
}

export function uninstallPi(): void {
  if (existsSync(SKILL_DIR)) {
    rmSync(SKILL_DIR, { recursive: true, force: true });
    log(`  pi             removed ${SKILL_DIR}`);
  }
  if (existsSync(EXTENSION_PATH)) {
    rmSync(EXTENSION_PATH, { force: true });
    log(`  pi             removed extension ${EXTENSION_PATH}`);
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
