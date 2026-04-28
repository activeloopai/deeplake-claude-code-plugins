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
//   1. ~/.pi/agent/AGENTS.md — global context (BEGIN/END marker upsert).
//      pi auto-loads AGENTS.md every turn, so the hivemind block is the
//      sole guidance surface — no per-agent SKILL.md drop. Pi loads skills
//      from both ~/.pi/agent/skills/ AND ~/.agents/skills/ (the shared
//      agentskills.io location), so dropping a per-agent skill collides
//      with the codex installer's ~/.agents/skills/hivemind-memory symlink.
//   2. ~/.pi/agent/extensions/hivemind.ts — TS extension for autocapture +
//      first-class hivemind_search / hivemind_read / hivemind_index tools.
//
// The extension is shipped as raw .ts; pi's runtime loader compiles it on
// load (uses tsx-style on-the-fly compilation). Self-contained — uses only
// Node builtins + pi types (which pi provides at runtime).

const PI_AGENT_DIR = join(HOME, ".pi", "agent");
const AGENTS_MD = join(PI_AGENT_DIR, "AGENTS.md");
const LEGACY_SKILL_DIR = join(PI_AGENT_DIR, "skills", "hivemind-memory");
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

export function upsertHivemindBlock(existing: string | null): string {
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

export function stripHivemindBlock(existing: string): string {
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

  // Clean up any per-agent SKILL.md left by an older installer — pi reads
  // skills from both ~/.pi/agent/skills/ and ~/.agents/skills/, so a local
  // drop collides with the codex installer's shared agentskills.io symlink.
  if (existsSync(LEGACY_SKILL_DIR)) {
    rmSync(LEGACY_SKILL_DIR, { recursive: true, force: true });
  }

  // 1. AGENTS.md hivemind block (idempotent upsert). Pi auto-loads this every turn.
  const prior = existsSync(AGENTS_MD) ? readFileSync(AGENTS_MD, "utf-8") : null;
  const next = upsertHivemindBlock(prior);
  writeFileSync(AGENTS_MD, next);

  // 2. Extension — autocapture + first-class hivemind tools.
  const srcExtension = join(pkgRoot(), "pi", "extension-source", "hivemind.ts");
  if (!existsSync(srcExtension)) {
    throw new Error(`pi extension source missing at ${srcExtension}. Reinstall the @deeplake/hivemind package.`);
  }
  ensureDir(EXTENSIONS_DIR);
  copyFileSync(srcExtension, EXTENSION_PATH);

  ensureDir(VERSION_DIR);
  writeVersionStamp(VERSION_DIR, getVersion());

  log(`  pi             AGENTS.md updated -> ${AGENTS_MD}`);
  log(`  pi             extension installed -> ${EXTENSION_PATH}`);
}

export function uninstallPi(): void {
  if (existsSync(LEGACY_SKILL_DIR)) {
    rmSync(LEGACY_SKILL_DIR, { recursive: true, force: true });
    log(`  pi             removed ${LEGACY_SKILL_DIR}`);
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
