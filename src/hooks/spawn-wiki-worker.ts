/**
 * Shared helper for spawning the detached wiki-worker.js process.
 * Called from session-end.ts (always) and capture.ts (periodic trigger).
 */

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { Config } from "../config.js";
import { GRAPH_PROMPT_TEMPLATE } from "./knowledge-graph.js";
import { MEMORY_FACT_PROMPT_TEMPLATE } from "./memory-facts.js";
import { utcTimestamp } from "../utils/debug.js";

const HOME = homedir();
export const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");

export const WIKI_PROMPT_TEMPLATE = `You are maintaining a persistent wiki from a session transcript. This page will become part of a long-lived knowledge base that future agents will search through index.md before opening the source session. Write for retrieval, not storytelling.

The session may be a coding session, a meeting, or a personal conversation. Your job is to turn the raw transcript into a dense, factual wiki page that preserves names, dates, relationships, preferences, plans, titles, and exact status changes.

SESSION JSONL path: __JSONL__
SUMMARY FILE to write: __SUMMARY__
SESSION ID: __SESSION_ID__
PROJECT: __PROJECT__
PREVIOUS JSONL OFFSET (lines already processed): __PREV_OFFSET__
CURRENT JSONL LINES: __JSONL_LINES__

Steps:
1. Read the session JSONL at the path above.
   - If PREVIOUS JSONL OFFSET > 0, this is a resumed session. Read the existing summary file first,
     then focus on lines AFTER the offset for new content. Merge new facts into the existing summary.
   - If offset is 0, generate from scratch.
   - Treat the JSONL as the source of truth. Do not invent facts.

2. Write the summary file at the path above with this EXACT format. The header fields (Source, Project) are pre-filled — copy them VERBATIM, do NOT replace them with paths from the JSONL content:

# Session __SESSION_ID__
- **Source**: __JSONL_SERVER_PATH__
- **Date**: <primary real-world date/time for the session if the transcript contains one; otherwise "unknown">
- **Participants**: <comma-separated names or roles of the main participants>
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__
- **Topics**: <comma-separated topics, themes, or workstreams>
- **JSONL offset**: __JSONL_LINES__

## What Happened
<2-4 dense sentences. What happened, why it mattered, and what changed. Prefer specific names/titles/dates over abstractions.>

## Searchable Facts
<Bullet list of atomic facts. One fact per bullet. Each bullet should be able to answer a future query on its own.
Include exact names, titles, identity labels, relationship status clues, home countries/origins, occupations, preferences, collections, books/media titles, pets, family details, goals, plans, locations, organizations, bugs, APIs, dates, and relative-time resolutions when the session date makes them unambiguous.>

## People
<For each person mentioned: name, role/relationship, notable traits/preferences/goals, and what they did or said. Format: **Name** — role/relationship — facts>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs, places, organizations, events, books, songs, artworks, pets, or products.
Format: **entity** (type) — why it matters, relevant state/details>

## Decisions & Reasoning
<Every decision made and WHY. Not just "did X" but "did X because Y, considered Z but rejected it because W". If no explicit decision happened, say "- None explicit.">

## Files Modified
<bullet list: path (new/modified/deleted) — what changed. If none, say "- None.">

## Open Questions / TODO
<Anything unresolved, blocked, explicitly deferred, or worth following up later. If none, say "- None explicit.">

IMPORTANT:
- Be exhaustive. If a detail exists in the session and could answer a later question, it should be in the wiki.
- Favor exact nouns and titles over generic paraphrases. Preserve exact book names, organization names, file names, feature names, and self-descriptions.
- Keep facts canonical and query-friendly: "Ava is single", "Leo's home country is Brazil", "The team chose retries because the API returned 429s".
- Resolve relative dates like "last year" or "next month" against the session's own date when the source makes that possible. If it is ambiguous, keep the relative phrase instead of guessing.
- Do not omit beneficiary groups or targets of goals (for example who a project, career, or effort is meant to help).
- Do not leak absolute filesystem paths beyond the pre-filled Source field.

PRIVACY: Never include absolute filesystem paths (e.g. /home/user/..., /Users/..., C:\\\\...) in the summary. Use only project-relative paths or the project name. The Source and Project fields above are already correct — do not change them.

LENGTH LIMIT: Keep the total summary under 4000 characters. Be dense and concise — prioritize facts over prose. If a session is short, the summary should be short too.`;

export function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${utcTimestamp()}] ${msg}\n`);
  } catch { /* ignore */ }
}

export function findClaudeBin(): string {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join(HOME, ".claude", "local", "claude");
  }
}

export interface SpawnOptions {
  config: Config;
  sessionId: string;
  cwd: string;
  bundleDir: string;
  reason: string;
}

export function spawnWikiWorker(opts: SpawnOptions): void {
  const { config, sessionId, cwd, bundleDir, reason } = opts;
  const projectName = cwd.split("/").pop() || "unknown";

  const tmpDir = join(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const configFile = join(tmpDir, "config.json");
  writeFileSync(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    memoryTable: config.tableName,
    sessionsTable: config.sessionsTableName,
    graphNodesTable: config.graphNodesTableName,
    graphEdgesTable: config.graphEdgesTableName,
    factsTable: config.factsTableName,
    entitiesTable: config.entitiesTableName,
    factEntityLinksTable: config.factEntityLinksTableName,
    sessionId,
    userName: config.userName,
    project: projectName,
    tmpDir,
    claudeBin: findClaudeBin(),
    wikiLog: WIKI_LOG,
    hooksDir: join(HOME, ".claude", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE,
    graphPromptTemplate: GRAPH_PROMPT_TEMPLATE,
    factPromptTemplate: MEMORY_FACT_PROMPT_TEMPLATE,
  }));

  wikiLog(`${reason}: spawning summary worker for ${sessionId}`);

  const workerPath = join(bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  wikiLog(`${reason}: spawned summary worker for ${sessionId}`);
}

export function bundleDirFromImportMeta(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
