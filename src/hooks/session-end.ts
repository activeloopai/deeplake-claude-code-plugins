#!/usr/bin/env node

/**
 * SessionEnd (Stop) hook — builds session summaries and index.
 * Direct port of deeplake-wiki.sh from the CLI.
 *
 * Difference from CLI version: paths use ~/.deeplake/memory/ (plugin virtual FS)
 * instead of resolving a FUSE mount from mounts.json.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("session-end", msg);

const HOME = homedir();
const MEMORY_PATH = join(HOME, ".deeplake", "memory");
const SUMMARIES_DIR = join(MEMORY_PATH, "summaries");
const INDEX_FILE = join(MEMORY_PATH, "index.md");
const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");

interface StopInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
}

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}\n`);
  } catch { /* ignore */ }
}

function findClaudeBin(): string {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join(HOME, ".claude", "local", "claude");
  }
}

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId) return;

  const summaryFile = join(SUMMARIES_DIR, `${sessionId}.md`);

  // --- SessionStart-equivalent: create placeholder + index entry ---
  // The CLI version does this on SessionStart, but the plugin hooks.json
  // only wires session-end to Stop. So we handle both: create placeholder
  // if it doesn't exist yet, then generate summary.
  mkdirSync(SUMMARIES_DIR, { recursive: true });

  if (!existsSync(INDEX_FILE)) {
    writeFileSync(INDEX_FILE, [
      "# Session Index",
      "",
      "List of all Claude Code sessions with summaries.",
      "",
      "| Session | Date | Project | Description |",
      "|---------|------|---------|-------------|",
      "",
    ].join("\n"));
    wikiLog("Created index.md");
  }

  // --- Find the session JSONL ---
  // Plugin captures to ~/.deeplake/memory/session_<id>.jsonl via capture.ts
  const jsonl = join(MEMORY_PATH, `session_${sessionId}.jsonl`);

  if (!existsSync(jsonl)) {
    wikiLog(`SessionEnd: no JSONL for ${sessionId} at ${jsonl}`);
    return;
  }

  const jsonlSize = statSync(jsonl).size;
  const jsonlContent = readFileSync(jsonl, "utf-8");
  const jsonlLines = jsonlContent.split("\n").filter(Boolean).length;

  wikiLog(`SessionEnd: processing ${sessionId} (JSONL: ${jsonlSize} bytes, ${jsonlLines} lines)`);

  // Check if summary already exists (resumed session) — extract JSONL offset
  let prevOffset = 0;
  if (existsSync(summaryFile)) {
    const existing = readFileSync(summaryFile, "utf-8");
    const match = existing.match(/\*\*JSONL offset\*\*:\s*(\d+)/);
    if (match) prevOffset = parseInt(match[1], 10);
  }

  const claudeBin = findClaudeBin();

  // Build the prompt — same as deeplake-wiki.sh
  const wikiPrompt = `You are a session summarizer. Read the session JSONL and generate a structured summary.

SESSION JSONL path: ${jsonl}
SUMMARY FILE to write: ${summaryFile}
INDEX FILE to update: ${INDEX_FILE}
SESSION ID: ${sessionId}
PROJECT: ${cwd}
PREVIOUS JSONL OFFSET (lines already processed): ${prevOffset}
CURRENT JSONL LINES: ${jsonlLines}

Steps:
1. Read the session JSONL at the path above.
   - If PREVIOUS JSONL OFFSET > 0, this is a resumed session. Read the existing summary file first,
     then focus on lines AFTER the offset for new content. Merge new facts into the existing summary.
   - If offset is 0, generate from scratch.

2. Write the summary file at the path above with this format:

# Session ${sessionId}
- **Source**: session_${sessionId}.jsonl
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: ${cwd}
- **JSONL offset**: ${jsonlLines}

## Summary
<2-3 sentences of what was accomplished>

## Key Facts
<bullet list: every decision, bug fix, file change, entity, reasoning>

## Files Modified
<bullet list with (new/modified/deleted)>

3. Update the index file: find the line containing ${sessionId} and replace it with:
| [${sessionId}](summaries/${sessionId}.md) | <date> | <project> | <short 1-line description max 80 chars> |

If the line does not exist, append it.

Be factual and dense. Capture every detail that could be asked about later.`;

  // Spawn in background — don't block the session exit
  const child = spawn(claudeBin, [
    "-p", wikiPrompt,
    "--no-session-persistence",
    "--model", "haiku",
    "--permission-mode", "bypassPermissions",
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Redirect stdout/stderr to log file
  const { createWriteStream } = await import("node:fs");
  const logStream = createWriteStream(WIKI_LOG, { flags: "a" });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.unref();

  wikiLog(`SessionEnd: spawned wiki processor for ${sessionId} (pid ${child.pid})`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
