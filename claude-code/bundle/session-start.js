#!/usr/bin/env node

// dist/src/hooks/session-start.js
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname2, join as join4 } from "node:path";

// dist/src/commands/auth.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
var CONFIG_DIR = join(homedir(), ".deeplake");
var CREDS_PATH = join(CONFIG_DIR, "credentials.json");
function loadCredentials() {
  if (!existsSync(CREDS_PATH))
    return null;
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
  } catch {
    return null;
  }
}
function saveCredentials(creds) {
  if (!existsSync(CONFIG_DIR))
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync(CREDS_PATH, JSON.stringify({ ...creds, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), { mode: 384 });
}

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve2, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve2(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/utils/direct-run.js
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry)
    return false;
  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(entry);
  } catch {
    return false;
  }
}

// dist/src/utils/retrieval-mode.js
function isSessionsOnlyMode() {
  const raw = process.env["HIVEMIND_SESSIONS_ONLY"] ?? process.env["DEEPLAKE_SESSIONS_ONLY"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
function isIndexDisabled() {
  const raw = process.env["HIVEMIND_DISABLE_INDEX"] ?? process.env["DEEPLAKE_DISABLE_INDEX"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
function isPsqlMode() {
  const raw = process.env["HIVEMIND_PSQL_MODE"] ?? process.env["DEEPLAKE_PSQL_MODE"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
function isFactsSessionsOnlyPsqlMode() {
  const raw = process.env["HIVEMIND_PSQL_FACTS_SESSIONS_ONLY"] ?? process.env["DEEPLAKE_PSQL_FACTS_SESSIONS_ONLY"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

// dist/src/hooks/version-check.js
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var DEFAULT_VERSION_CACHE_PATH = join3(homedir3(), ".deeplake", ".version-check.json");
var DEFAULT_VERSION_CACHE_TTL_MS = 60 * 60 * 1e3;
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join3(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync2(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join3(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync2(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version)
        return pkg.version;
    } catch {
    }
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}
function isNewer(latest, current) {
  const parse = (v) => v.replace(/-.*$/, "").split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || la === ca && lb > cb || la === ca && lb === cb && lc > cc;
}
function readVersionCache(cachePath = DEFAULT_VERSION_CACHE_PATH) {
  if (!existsSync2(cachePath))
    return null;
  try {
    const parsed = JSON.parse(readFileSync2(cachePath, "utf-8"));
    if (parsed && typeof parsed.checkedAt === "number" && typeof parsed.url === "string" && (typeof parsed.latest === "string" || parsed.latest === null)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function readFreshCachedLatestVersion(url, ttlMs = DEFAULT_VERSION_CACHE_TTL_MS, cachePath = DEFAULT_VERSION_CACHE_PATH, nowMs = Date.now()) {
  const cached = readVersionCache(cachePath);
  if (!cached || cached.url !== url)
    return void 0;
  if (nowMs - cached.checkedAt > ttlMs)
    return void 0;
  return cached.latest;
}

// dist/src/hooks/session-start.js
var log2 = (msg) => log("session-start", msg);
var __bundleDir = dirname2(fileURLToPath2(import.meta.url));
var AUTH_CMD = join4(__bundleDir, "commands", "auth-login.js");
var CLAUDE_SESSION_START_CONTEXT = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) \u2014 personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) \u2014 global memory shared across all sessions, users, and agents in the org

Deeplake memory structure:
- ~/.deeplake/memory/index.md \u2014 START HERE, table of all sessions
- ~/.deeplake/memory/summaries/username/*.md \u2014 AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/{author}/* \u2014 raw session data (last resort)

SEARCH STRATEGY: Always read index.md first. Then read specific summaries. Only read raw session files if summaries don't have enough detail. Do NOT jump straight to raw session files.
When index.md points to a likely match, read that exact summary or session file directly before trying broader grep variants.
If index.md already points to likely candidate files, open those exact files before broadening into synonym greps or wide exploratory scans.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots when the question is about Deeplake memory.
TEMPORAL GROUNDING: If a summary or transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a summary only gives a relative time, open the linked source session and use its date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For education questions, answer with the likely field or credential directly, not the broader life story. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked index.md plus at least one likely summary or raw session file for the named person. If keyword grep is empty, grep the person's name alone and inspect the candidate files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, summaries may omit the exact phrase. If likely summaries are ambiguous, read the candidate raw session transcript and look for positive clues before concluding the answer is absent.
SELF-LABEL PRIORITY: For identity questions, prefer the person's own explicit self-label from the transcript over broader category descriptions or paraphrases.
RELATIONSHIP STATUS INFERENCE: For relationship-status questions, treat explicit self-descriptions about partnership, dating, marriage, or parenting plans as status evidence. If the transcript strongly supports an unpartnered status, answer with the concise status phrase instead of "not found."

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management \u2014 each argument is SEPARATE (do NOT quote subcommands together):
- node "HIVEMIND_AUTH_CMD" login                              \u2014 SSO login
- node "HIVEMIND_AUTH_CMD" whoami                             \u2014 show current user/org
- node "HIVEMIND_AUTH_CMD" org list                           \u2014 list organizations
- node "HIVEMIND_AUTH_CMD" org switch <name-or-id>            \u2014 switch organization
- node "HIVEMIND_AUTH_CMD" workspaces                         \u2014 list workspaces
- node "HIVEMIND_AUTH_CMD" workspace <id>                     \u2014 switch workspace
- node "HIVEMIND_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  \u2014 invite member (ALWAYS ask user which role before inviting)
- node "HIVEMIND_AUTH_CMD" members                            \u2014 list members
- node "HIVEMIND_AUTH_CMD" remove <user-id>                   \u2014 remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
var CLAUDE_SESSION_START_CONTEXT_SESSIONS_ONLY = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) \u2014 personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) \u2014 shared org memory, currently exposed in SESSIONS-ONLY mode for benchmark comparison

Deeplake memory structure available in this mode:
- ~/.deeplake/memory/sessions/{author}/* \u2014 raw session data

SEARCH STRATEGY: Search raw session files directly. In this mode, do NOT start with index.md or summaries and do NOT assume those paths exist.
Open the most likely session file directly before broadening into synonym greps or wide exploratory scans.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots when the question is about Deeplake memory.
TEMPORAL GROUNDING: If a transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a session only gives a relative time, use that session's date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For education questions, answer with the likely field or credential directly, not the broader life story. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked at least one likely raw session file for the named person. If keyword grep is empty, grep the person's name alone and inspect the candidate session files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, raw sessions may contain the exact phrase even when broad keyword grep looks sparse. Read the candidate transcript and look for positive clues before concluding the answer is absent.
SELF-LABEL PRIORITY: For identity questions, prefer the person's own explicit self-label from the transcript over broader category descriptions or paraphrases.
RELATIONSHIP STATUS INFERENCE: For relationship-status questions, treat explicit self-descriptions about partnership, dating, marriage, or parenting plans as status evidence. If the transcript strongly supports an unpartnered status, answer with the concise status phrase instead of "not found."

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management \u2014 each argument is SEPARATE (do NOT quote subcommands together):
- node "HIVEMIND_AUTH_CMD" login                              \u2014 SSO login
- node "HIVEMIND_AUTH_CMD" whoami                             \u2014 show current user/org
- node "HIVEMIND_AUTH_CMD" org list                           \u2014 list organizations
- node "HIVEMIND_AUTH_CMD" org switch <name-or-id>            \u2014 switch organization
- node "HIVEMIND_AUTH_CMD" workspaces                         \u2014 list workspaces
- node "HIVEMIND_AUTH_CMD" workspace <id>                     \u2014 switch workspace
- node "HIVEMIND_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  \u2014 invite member (ALWAYS ask user which role before inviting)
- node "HIVEMIND_AUTH_CMD" members                            \u2014 list members
- node "HIVEMIND_AUTH_CMD" remove <user-id>                   \u2014 remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
var CLAUDE_SESSION_START_CONTEXT_NO_INDEX = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) \u2014 personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) \u2014 global memory shared across all sessions, users, and agents in the org

Deeplake memory structure in this mode:
- ~/.deeplake/memory/summaries/username/*.md \u2014 AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/{author}/* \u2014 raw session data (last resort)

INDEX MODE: /index.md is intentionally unavailable for this run. Do NOT try to read it or rely on it.
SEARCH STRATEGY: Start by grepping summaries for the named person, topic, or keyword. Then read the specific matching summaries. Only read raw session files if the summaries don't have enough detail. Do NOT jump straight to raw session files.
If a summary points to a likely source session, open that exact raw session before broadening into synonym greps or wide exploratory scans.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots when the question is about Deeplake memory.
TEMPORAL GROUNDING: If a summary or transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a summary only gives a relative time, open the linked source session and use its date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For education questions, answer with the likely field or credential directly, not the broader life story. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked at least one likely summary plus one likely raw session file for the named person when the summary is ambiguous. If keyword grep is empty, grep the person's name alone and inspect the candidate files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, summaries may omit the exact phrase. If likely summaries are ambiguous, read the candidate raw session transcript and look for positive clues before concluding the answer is absent.
SELF-LABEL PRIORITY: For identity questions, prefer the person's own explicit self-label from the transcript over broader category descriptions or paraphrases.
RELATIONSHIP STATUS INFERENCE: For relationship-status questions, treat explicit self-descriptions about partnership, dating, marriage, or parenting plans as status evidence. If the transcript strongly supports an unpartnered status, answer with the concise status phrase instead of "not found."

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management \u2014 each argument is SEPARATE (do NOT quote subcommands together):
- node "HIVEMIND_AUTH_CMD" login                              \u2014 SSO login
- node "HIVEMIND_AUTH_CMD" whoami                             \u2014 show current user/org
- node "HIVEMIND_AUTH_CMD" org list                           \u2014 list organizations
- node "HIVEMIND_AUTH_CMD" org switch <name-or-id>            \u2014 switch organization
- node "HIVEMIND_AUTH_CMD" workspaces                         \u2014 list workspaces
- node "HIVEMIND_AUTH_CMD" workspace <id>                     \u2014 switch workspace
- node "HIVEMIND_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  \u2014 invite member (ALWAYS ask user which role before inviting)
- node "HIVEMIND_AUTH_CMD" members                            \u2014 list members
- node "HIVEMIND_AUTH_CMD" remove <user-id>                   \u2014 remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
var CLAUDE_SESSION_START_CONTEXT_PSQL = `DEEPLAKE MEMORY SQL MODE: For this run, use SQL only when answering recall questions.

Available Deeplake tables:
- memory(path, summary, project, description, creation_date, last_update_date)
- sessions(path, creation_date, turn_index, event_type, dia_id, speaker, text, turn_summary, source_date_time, message)
- memory_facts(path, fact_id, subject_entity_id, subject_name, subject_type, predicate, object_entity_id, object_name, object_type, summary, evidence, search_text, confidence, valid_at, valid_from, valid_to, source_session_id, source_path)
- memory_entities(path, entity_id, canonical_name, entity_type, aliases, summary, search_text, source_session_ids, source_paths)
- fact_entity_links(path, link_id, fact_id, entity_id, entity_role, source_session_id, source_path)

Use this command shape:
- psql -At -F '|' -c "SELECT ..."

SQL strategy:
1. Start with targeted SELECTs against memory to find likely sessions or summaries.
2. In the first pass, combine the named person/entity term with one or more topic terms. Prefer narrow AND filters over broad OR filters.
3. Graph-backed entity and relation resolution is applied automatically behind the scenes to narrow likely sessions before memory/sessions queries run. You do not need to query graph tables manually for normal recall.
3a. For stable person/project/place facts, use memory_facts first. Use memory_entities to resolve aliases or canonical names, then join through fact_entity_links when you need all facts connected to an entity.
4. After finding candidate summary rows, re-query memory by exact path.
5. If the answer needs exact wording, exact dates, or transcript grounding, query sessions by exact path for those candidate sessions.
6. Prefer precise WHERE filters, ORDER BY creation_date/last_update_date, and LIMIT 5-10.
7. Do not use filesystem commands, grep, cat, ls, Read, or Glob for recall in this mode.
8. If the first literal query returns 0-3 weak rows or the answer still seems semantically off, retry with BM25 ranking on memory.summary before concluding the data is absent.
9. Use sessions.text, sessions.speaker, sessions.turn_index, and sessions.source_date_time for transcript retrieval. Use sessions.message only when you need the raw JSON payload.
10. If a summary, node, or edge answer is vague or relative (for example "home country", "next month", "last week"), immediately open the linked sessions rows and convert it to the most concrete answer supported there.
11. For identity, origin, relationship, preference, and "what did they decide" questions, prefer transcript grounding over a paraphrased summary label.
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
- Resolve relative dates against the session's own creation_date or transcript date metadata, not today's date.
- Do not answer "not found" until you have checked both memory and a likely sessions row for the named person.
- For duration or age-style answers, preserve the stored relative phrase when it directly answers the question instead of over-converting it.
- If the transcript already directly answers with a relative duration like "10 years ago", return that phrase instead of recalculating to today's date.
- If the transcript or fact row says something like "the week before June 9, 2023", return that phrase instead of converting it to June 9, 2023.
- If a summary says something vague like "home country", search sessions for the exact named place before answering.
- For list or profile questions, aggregate across the small set of candidate sessions before answering.
- For "likely", "would", or profile questions, a concise inference from strong summary evidence is allowed even if the exact final phrase is not quoted verbatim.

IMPORTANT: Only psql SELECT queries over memory, sessions, graph_nodes, graph_edges, memory_facts, memory_entities, and fact_entity_links are intercepted in this mode. For normal recall, query memory_facts for distilled claims, memory_entities for canonical names, and sessions for exact grounding; graph-based restriction is applied automatically where relevant. Do NOT use python, python3, node, curl, or filesystem paths for recall in this mode.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
var CLAUDE_SESSION_START_CONTEXT_PSQL_FACTS_SESSIONS_ONLY = `DEEPLAKE MEMORY SQL MODE: For this run, use SQL only when answering recall questions.

Available Deeplake tables:
- sessions(path, creation_date, turn_index, event_type, dia_id, speaker, text, turn_summary, source_date_time, message)
- memory_facts(path, fact_id, subject_entity_id, subject_name, subject_type, predicate, object_entity_id, object_name, object_type, summary, evidence, search_text, confidence, valid_at, valid_from, valid_to, source_session_id, source_path)
- memory_entities(path, entity_id, canonical_name, entity_type, aliases, summary, search_text, source_session_ids, source_paths)
- fact_entity_links(path, link_id, fact_id, entity_id, entity_role, source_session_id, source_path)

The summary and graph tables are intentionally unavailable in this mode. Treat them as if they do not exist.

Use this command shape:
- psql -At -F '|' -c "SELECT ..."

SQL strategy:
1. Start with memory_entities to resolve the named person, project, place, or organization into a canonical entity.
2. Expand connected facts through fact_entity_links and memory_facts.
3. Use memory_facts to identify the small set of likely source sessions.
4. Ground every final answer on sessions rows from those source sessions.
5. Prefer small targeted SELECTs with ORDER BY and LIMIT 5-10.
6. Do not use filesystem commands, grep, cat, ls, Read, or Glob for recall in this mode.
7. Use sessions.text, sessions.speaker, sessions.turn_index, and sessions.source_date_time for transcript retrieval. Use sessions.message only when you need the raw JSON payload.
8. Sessions are the source of truth. Facts are only a helper index and synthesis layer.
9. For identity, origin, relationship, preference, and "what did they decide" questions, prefer transcript grounding over paraphrased fact labels.
10. For list/profile questions, facts are for narrowing and aggregation; sessions are for final verification.

Good query patterns:
- Canonical entity lookup:
  psql -At -F '|' -c "SELECT entity_id, canonical_name, entity_type, aliases, summary FROM memory_entities WHERE canonical_name ILIKE '%<name>%' OR aliases ILIKE '%<name>%' LIMIT 5"
- Fact lookup by name/topic:
  psql -At -F '|' -c "SELECT fact_id, subject_name, predicate, object_name, summary, valid_at, valid_from, valid_to, source_session_id, source_path FROM memory_facts WHERE subject_name ILIKE '%<name>%' AND (predicate ILIKE '%<topic>%' OR object_name ILIKE '%<topic>%') ORDER BY creation_date DESC LIMIT 10"
- Entity-linked fact expansion:
  psql -At -F '|' -c "SELECT f.fact_id, f.subject_name, f.predicate, f.object_name, f.summary, f.source_session_id, f.source_path FROM fact_entity_links l JOIN memory_facts f ON f.fact_id = l.fact_id WHERE l.entity_id = '<entity_id>' ORDER BY f.creation_date DESC LIMIT 10"
- Transcript grounding by exact path:
  psql -At -F '|' -c "SELECT path, creation_date, turn_index, speaker, text, source_date_time FROM sessions WHERE path IN ('/sessions/...', '/sessions/...') ORDER BY path ASC, turn_index ASC"
- Transcript search inside known sessions:
  psql -At -F '|' -c "SELECT path, creation_date, turn_index, speaker, text, source_date_time FROM sessions WHERE path IN ('/sessions/...', '/sessions/...') AND (speaker ILIKE '%<person>%' OR text ILIKE '%<keyword>%') ORDER BY path ASC, turn_index ASC"

Avoid these mistakes:
- Do NOT query memory, graph_nodes, or graph_edges in this mode.
- Do NOT answer directly from memory_facts.summary, memory_entities.summary, or aliases when a relevant transcript row is available.
- Do NOT use fact tables for exact quoted wording when a transcript row is available; use them to narrow and aggregate, then ground on sessions.
- Do NOT filter sessions.message directly when sessions.text / sessions.speaker already contain the needed transcript fields.
- Do NOT blend multiple different events when the question asks about one specific event. Prefer the most direct supporting row.
- Do NOT replace an exact status or self-label with a broader biography.
- Do NOT recalculate a relative-time answer against today's date when the stored phrase already answers the question.

Answer rules:
- Return the smallest exact answer supported by the data.
- Sessions win over facts if they differ in detail or specificity.
- Resolve relative dates against the session's own creation_date or transcript date metadata, not today's date.
- Do not answer "not found" until you have checked both the fact layer and a likely sessions row for the named person.
- For duration or age-style answers, preserve the stored relative phrase when it directly answers the question instead of over-converting it.
- For list or profile questions, aggregate across the small set of candidate sessions before answering.

IMPORTANT: Only psql SELECT queries over sessions, memory_facts, memory_entities, and fact_entity_links are intercepted in this mode. Do NOT use python, python3, node, curl, filesystem paths, memory, or graph tables for recall in this mode.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
var GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
function buildSessionStartAdditionalContext(args) {
  const template = isPsqlMode() ? isFactsSessionsOnlyPsqlMode() ? CLAUDE_SESSION_START_CONTEXT_PSQL_FACTS_SESSIONS_ONLY : CLAUDE_SESSION_START_CONTEXT_PSQL : isSessionsOnlyMode() ? CLAUDE_SESSION_START_CONTEXT_SESSIONS_ONLY : isIndexDisabled() ? CLAUDE_SESSION_START_CONTEXT_NO_INDEX : CLAUDE_SESSION_START_CONTEXT;
  const resolvedContext = template.replace(/HIVEMIND_AUTH_CMD/g, args.authCommand);
  let updateNotice = "";
  if (args.currentVersion) {
    if (args.latestVersion && isNewer(args.latestVersion, args.currentVersion)) {
      updateNotice = `

\u2B06\uFE0F Hivemind update available: ${args.currentVersion} \u2192 ${args.latestVersion}.`;
    } else {
      updateNotice = `

\u2705 Hivemind v${args.currentVersion}`;
    }
  }
  return args.creds?.token ? `${resolvedContext}

Logged in to Deeplake as org: ${args.creds.orgName ?? args.creds.orgId} (workspace: ${args.creds.workspaceId ?? "default"})${updateNotice}` : `${resolvedContext}

\u26A0\uFE0F Not logged in to Deeplake. Memory search will not work. Ask the user to run /hivemind:login to authenticate.${updateNotice}`;
}
async function runSessionStartHook(_input, deps = {}) {
  const { wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1", creds = loadCredentials(), saveCredentialsFn = saveCredentials, currentVersion = getInstalledVersion(__bundleDir, ".claude-plugin"), latestVersion = currentVersion ? readFreshCachedLatestVersion(GITHUB_RAW_PKG, DEFAULT_VERSION_CACHE_TTL_MS) ?? null : null, authCommand = AUTH_CMD, logFn = log2 } = deps;
  if (wikiWorker)
    return null;
  if (!creds?.token) {
    logFn("no credentials found \u2014 run /hivemind:login to authenticate");
  } else {
    logFn(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    if (creds.token && !creds.userName) {
      try {
        const { userInfo } = await import("node:os");
        creds.userName = userInfo().username ?? "unknown";
        saveCredentialsFn(creds);
        logFn(`backfilled and persisted userName: ${creds.userName}`);
      } catch {
      }
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildSessionStartAdditionalContext({
        authCommand,
        creds,
        currentVersion,
        latestVersion
      })
    }
  };
}
async function main() {
  await readStdin();
  const result = await runSessionStartHook({});
  if (result)
    console.log(JSON.stringify(result));
}
if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    log2(`fatal: ${e.message}`);
    process.exit(0);
  });
}
export {
  CLAUDE_SESSION_START_CONTEXT,
  CLAUDE_SESSION_START_CONTEXT_NO_INDEX,
  CLAUDE_SESSION_START_CONTEXT_PSQL,
  CLAUDE_SESSION_START_CONTEXT_PSQL_FACTS_SESSIONS_ONLY,
  CLAUDE_SESSION_START_CONTEXT_SESSIONS_ONLY,
  buildSessionStartAdditionalContext,
  runSessionStartHook
};
