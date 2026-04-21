#!/usr/bin/env node

/**
 * Codex SessionStart hook (fast path):
 * Only reads local credentials and injects context into Codex's developer prompt.
 * All server calls (table setup, placeholder, version check) are handled by
 * session-start-setup.js which runs as a separate async hook.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { isIndexDisabled, isPsqlMode, isSessionsOnlyMode } from "../../utils/retrieval-mode.js";
import { getInstalledVersion } from "../version-check.js";

const log = (msg: string) => _log("codex-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

export const CODEX_SESSION_START_CONTEXT = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) → summaries/*.md → sessions/{author}/* (last resort). Do NOT jump straight to raw session files.
When index.md identifies a likely match, read that exact summary or session path directly before broader grep variants.
If index.md already points to likely candidate files, open those exact files before broader synonym greps or wide exploratory scans.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots for Deeplake recall tasks.
TEMPORAL GROUNDING: If a summary or transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a summary only gives a relative time, open the linked source session and use its date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For education questions, answer with the likely field or credential directly, not the broader life story. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked index.md plus at least one likely summary or raw session file for the named person. If keyword grep is empty, grep the person's name alone and inspect the candidate files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, summaries may omit the exact phrase. If likely summaries are ambiguous, read the candidate raw session transcript and look for positive clues before concluding the answer is absent.
SELF-LABEL PRIORITY: For identity questions, prefer the person's own explicit self-label from the transcript over broader category descriptions or paraphrases.
RELATIONSHIP STATUS INFERENCE: For relationship-status questions, treat explicit self-descriptions about partnership, dating, marriage, or parenting plans as status evidence. If the transcript strongly supports an unpartnered status, answer with the concise status phrase instead of "not found."
Search: grep -r "keyword" ~/.deeplake/memory/
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;

export const CODEX_SESSION_START_CONTEXT_SESSIONS_ONLY = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

SESSIONS-ONLY mode is active for benchmark comparison. Available Deeplake recall paths are raw session files under sessions/{author}/*.
Do NOT start with index.md or summaries in this mode, and do NOT assume those paths exist.
Open the most likely session file directly before broader grep variants.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots for Deeplake recall tasks.
TEMPORAL GROUNDING: If a transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a session only gives a relative time, use its date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For education questions, answer with the likely field or credential directly, not the broader life story. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked at least one likely raw session file for the named person. If keyword grep is empty, grep the person's name alone and inspect the candidate session files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, raw sessions may contain the exact phrase even when broad keyword grep looks sparse. Read the candidate transcript and look for positive clues before concluding the answer is absent.
SELF-LABEL PRIORITY: For identity questions, prefer the person's own explicit self-label from the transcript over broader category descriptions or paraphrases.
RELATIONSHIP STATUS INFERENCE: For relationship-status questions, treat explicit self-descriptions about partnership, dating, marriage, or parenting plans as status evidence. If the transcript strongly supports an unpartnered status, answer with the concise status phrase instead of "not found."
Search: grep -r "keyword" ~/.deeplake/memory/
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;

export const CODEX_SESSION_START_CONTEXT_NO_INDEX = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure in this mode: summaries/*.md → sessions/{author}/* (last resort). /index.md is intentionally unavailable, so do NOT read it or rely on it.
Start by grepping summaries for the named person, topic, or keyword. Then open the specific matching summaries. Only read raw session files if summaries do not contain the exact detail.
If a summary points to a likely source session, read that exact raw session before broader grep variants.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots for Deeplake recall tasks.
TEMPORAL GROUNDING: If a summary or transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a summary only gives a relative time, open the linked source session and use its date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For education questions, answer with the likely field or credential directly, not the broader life story. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked at least one likely summary plus one likely raw session file when the summary is ambiguous. If keyword grep is empty, grep the person's name alone and inspect the candidate files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, summaries may omit the exact phrase. If likely summaries are ambiguous, read the candidate raw session transcript and look for positive clues before concluding the answer is absent.
SELF-LABEL PRIORITY: For identity questions, prefer the person's own explicit self-label from the transcript over broader category descriptions or paraphrases.
RELATIONSHIP STATUS INFERENCE: For relationship-status questions, treat explicit self-descriptions about partnership, dating, marriage, or parenting plans as status evidence. If the transcript strongly supports an unpartnered status, answer with the concise status phrase instead of "not found."
Search: grep -r "keyword" ~/.deeplake/memory/
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;

export const CODEX_SESSION_START_CONTEXT_PSQL = `DEEPLAKE MEMORY SQL MODE: Use SQL only for Deeplake recall tasks.

Available tables:
- memory(path, summary, project, description, creation_date, last_update_date)
- sessions(path, creation_date, turn_index, event_type, dia_id, speaker, text, turn_summary, source_date_time, message)
- memory_facts(path, fact_id, subject_entity_id, subject_name, subject_type, predicate, object_entity_id, object_name, object_type, summary, evidence, search_text, confidence, valid_at, valid_from, valid_to, source_session_id, source_path)
- memory_entities(path, entity_id, canonical_name, entity_type, aliases, summary, search_text, source_session_ids, source_paths)
- fact_entity_links(path, link_id, fact_id, entity_id, entity_role, source_session_id, source_path)

Use this command shape:
- psql -At -F '|' -c "SELECT ..."

Workflow:
1. Query memory first to identify likely summaries and sessions.
2. In the first pass, combine the named person/entity term with one or more topic terms. Prefer narrow AND filters over broad OR filters.
3. Graph-backed entity and relation resolution is applied automatically behind the scenes to narrow likely sessions before memory/sessions queries run. You do not need to query graph tables manually for normal recall.
3a. For stable person/project/place facts, use memory_facts first. Use memory_entities to resolve aliases or canonical names, then join through fact_entity_links when you need all facts connected to an entity.
4. Re-query memory by exact path for the small candidate set you selected.
5. Query sessions by exact path for transcript evidence or unresolved dates.
6. Prefer small targeted SELECTs with ORDER BY and LIMIT 5-10.
7. Do not use filesystem commands, grep, cat, ls, Read, or Glob for recall in this mode.
8. If the first literal query returns 0-3 weak rows or the answer still seems semantically off, retry with BM25 ranking on memory.summary.
9. Use sessions.text, sessions.speaker, sessions.turn_index, and sessions.source_date_time for transcript retrieval. Use sessions.message only when you need the raw JSON payload.
10. If a summary, node, or edge answer is vague or relative, immediately open the linked sessions rows and convert it to the most concrete answer supported there.
11. For identity, origin, relationship, preference, and "what did they decide" questions, prefer transcript grounding over paraphrased summary labels.
12. When memory_entities resolves a canonical entity, use fact_entity_links to expand the connected facts before deciding the fact layer is sparse.
13. For identity or relationship questions, prefer the narrowest explicit self-label or status label over broader biography or community descriptions.
14. For "when" questions, if the best evidence is already phrased relative to another dated event, return that relative phrase instead of inventing a different absolute date.
15. For list/profile questions, return a minimal comma-separated set of directly supported items. Do not pad the answer with adjacent hobbies, events, or explanations.
16. For artifact/title questions such as books, talks, projects, or artworks, prefer exact titled objects from facts or transcript over generic phrases like "a book" or "a speech".

Good query patterns:
- Candidate summaries:
  psql -At -F '|' -c "SELECT path, summary, creation_date FROM memory WHERE summary ILIKE '%<person>%' AND (summary ILIKE '%<topic1>%' OR summary ILIKE '%<topic2>%') ORDER BY creation_date DESC LIMIT 5"
- Canonical entity lookup:
  psql -At -F '|' -c "SELECT entity_id, canonical_name, entity_type, aliases, summary FROM memory_entities WHERE canonical_name ILIKE '%<name>%' OR aliases ILIKE '%<name>%' LIMIT 5"
- Fact lookup by entity:
  psql -At -F '|' -c "SELECT fact_id, subject_name, predicate, object_name, summary, valid_at, valid_from, valid_to, source_session_id FROM memory_facts WHERE subject_name ILIKE '%<name>%' AND (predicate ILIKE '%<topic>%' OR object_name ILIKE '%<topic>%') ORDER BY creation_date DESC LIMIT 10"
- Entity-linked fact expansion:
  psql -At -F '|' -c "SELECT f.fact_id, f.subject_name, f.predicate, f.object_name, f.summary FROM fact_entity_links l JOIN memory_facts f ON f.fact_id = l.fact_id WHERE l.entity_id = '<entity_id>' ORDER BY f.creation_date DESC LIMIT 10"
- Exact summary reread:
  psql -At -F '|' -c "SELECT path, summary FROM memory WHERE path IN ('/summaries/...', '/summaries/...')"
- Transcript grounding by exact path:
  psql -At -F '|' -c "SELECT path, creation_date, turn_index, speaker, text, source_date_time FROM sessions WHERE path IN ('/sessions/...', '/sessions/...') ORDER BY path ASC, turn_index ASC"
- Transcript search inside known sessions:
  psql -At -F '|' -c "SELECT path, creation_date, turn_index, speaker, text, source_date_time FROM sessions WHERE path IN ('/sessions/...', '/sessions/...') AND (speaker ILIKE '%<person>%' OR text ILIKE '%<keyword>%') ORDER BY path ASC, turn_index ASC"
- If literal ILIKE retrieval is sparse or semantically weak, retry with BM25 text ranking on summaries:
  psql -At -F '|' -c "SELECT path, summary, summary <#> '<person> <topic terms>' AS score FROM memory WHERE summary ILIKE '%<person>%' ORDER BY score DESC LIMIT 5"
- If graph entity lookup is sparse or semantically weak, retry with BM25 on graph nodes:
  psql -At -F '|' -c "SELECT node_id, canonical_name, node_type, summary, source_session_id, source_path, search_text <#> '<entity> <topic terms>' AS score FROM graph_nodes ORDER BY score DESC LIMIT 5"

Avoid these mistakes:
- Do NOT search person names via path ILIKE. Person names live in summary text, not session paths.
- Do NOT filter sessions.message directly when sessions.text / sessions.speaker already contain the needed transcript fields.
- Do NOT use fact tables for exact quoted wording when a transcript row is available; use them to narrow and aggregate, then ground on sessions.
- Do NOT stop at graph rows alone when the question asks for exact wording or time grounding. Use graph rows to narrow the search, then open the linked sessions.
- Do NOT blend multiple different events when the question asks about one specific event. Prefer the most direct supporting row.
- Do NOT replace an exact status or self-label with a broader biography.
- Do NOT recalculate a relative-time answer against today's date when the stored phrase already answers the question.
- Do NOT turn a short list question into a narrative list of loosely related activities.

Answer rules:
- Return the smallest exact answer supported by the data.
- Resolve relative dates against session metadata, not today's date.
- Do not answer "not found" until you have checked both memory and a likely sessions row.
- Preserve direct relative-duration answers when they already match the question.
- If the transcript already directly answers with a relative duration like "10 years ago", return that phrase instead of recalculating to today's date.
- If the transcript or fact row says something like "the week before June 9, 2023", return that phrase instead of converting it to June 9, 2023.
- If a summary says something vague like "home country", search sessions for the exact named place before answering.
- Aggregate across the small candidate set before answering profile or list questions.
- For "likely", "would", or profile questions, a concise inference from strong summary evidence is allowed even if the exact final phrase is not quoted verbatim.

Only psql SELECT queries over memory, sessions, graph_nodes, graph_edges, memory_facts, memory_entities, and fact_entity_links are intercepted in this mode. For normal recall, query memory_facts for distilled claims, memory_entities for canonical names, and sessions for exact grounding; graph-based restriction is applied automatically where relevant. Do NOT use python, python3, node, curl, or filesystem paths for recall in this mode.`;

export interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

export function buildCodexSessionStartContext(args: {
  creds: ReturnType<typeof loadCredentials>;
  currentVersion: string | null;
  authCommand: string;
}): string {
  const versionNotice = args.currentVersion ? `\nHivemind v${args.currentVersion}` : "";
  const template = isPsqlMode()
    ? CODEX_SESSION_START_CONTEXT_PSQL
    : isSessionsOnlyMode()
      ? CODEX_SESSION_START_CONTEXT_SESSIONS_ONLY
      : isIndexDisabled()
        ? CODEX_SESSION_START_CONTEXT_NO_INDEX
        : CODEX_SESSION_START_CONTEXT;
  return args.creds?.token
    ? `${template}\nLogged in to Deeplake as org: ${args.creds.orgName ?? args.creds.orgId} (workspace: ${args.creds.workspaceId ?? "default"})${versionNotice}`
    : `${template}\nNot logged in to Deeplake. Run: node "${args.authCommand}" login${versionNotice}`;
}

interface CodexSessionStartDeps {
  wikiWorker?: boolean;
  creds?: ReturnType<typeof loadCredentials>;
  spawnFn?: typeof spawn;
  currentVersion?: string | null;
  authCommand?: string;
  setupScript?: string;
  logFn?: (msg: string) => void;
}

export async function runCodexSessionStartHook(input: CodexSessionStartInput, deps: CodexSessionStartDeps = {}): Promise<string | null> {
  const {
    wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1",
    creds = loadCredentials(),
    spawnFn = spawn,
    currentVersion = getInstalledVersion(__bundleDir, ".codex-plugin"),
    authCommand = AUTH_CMD,
    setupScript = join(__bundleDir, "session-start-setup.js"),
    logFn = log,
  } = deps;

  if (wikiWorker) return null;

  if (!creds?.token) logFn("no credentials found — run auth login to authenticate");
  else logFn(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);

  if (creds?.token) {
    const child = spawnFn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env },
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    logFn("spawned async setup process");
  }

  return buildCodexSessionStartContext({
    creds,
    currentVersion,
    authCommand,
  });
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<CodexSessionStartInput>();
  const output = await runCodexSessionStartHook(input);
  if (output) console.log(output);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
