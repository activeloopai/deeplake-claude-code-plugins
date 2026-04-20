#!/usr/bin/env node

// dist/src/hooks/codex/session-start.js
import { spawn } from "node:child_process";
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

// dist/src/hooks/codex/session-start.js
var log2 = (msg) => log("codex-session-start", msg);
var __bundleDir = dirname2(fileURLToPath2(import.meta.url));
var AUTH_CMD = join4(__bundleDir, "commands", "auth-login.js");
var CODEX_SESSION_START_CONTEXT = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) \u2192 summaries/*.md \u2192 sessions/{author}/* (last resort). Do NOT jump straight to raw session files.
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
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;
var CODEX_SESSION_START_CONTEXT_SESSIONS_ONLY = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

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
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;
var CODEX_SESSION_START_CONTEXT_NO_INDEX = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure in this mode: summaries/*.md \u2192 sessions/{author}/* (last resort). /index.md is intentionally unavailable, so do NOT read it or rely on it.
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
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;
var CODEX_SESSION_START_CONTEXT_PSQL = `DEEPLAKE MEMORY SQL MODE: Use SQL only for Deeplake recall tasks.

Available tables:
- memory(path, summary, project, description, creation_date, last_update_date)
- sessions(path, creation_date, turn_index, event_type, dia_id, speaker, text, turn_summary, source_date_time, message)

Use this command shape:
- psql -At -F '|' -c "SELECT ..."

Workflow:
1. Query memory first to identify likely summaries.
2. In the first pass, combine the named person/entity term with one or more topic terms. Prefer narrow AND filters over broad OR filters.
3. Re-query memory by exact path for the small set of summary rows you selected.
4. Query sessions by exact path for transcript evidence or unresolved dates.
5. Prefer small targeted SELECTs with ORDER BY and LIMIT 5-10.
6. Do not use filesystem commands, grep, cat, ls, Read, or Glob for recall in this mode.
7. If the first summary query returns 0-3 weak rows or the answer still seems semantically off, retry with BM25 ranking on memory before concluding the data is absent.
8. Use sessions.text, sessions.speaker, sessions.turn_index, and sessions.source_date_time for transcript retrieval. Use sessions.message only when you need the raw JSON payload.
9. If a summary answer is vague or relative (for example "home country", "next month", "last week"), immediately open the linked sessions rows and convert it to the most concrete answer supported there.
10. For identity, origin, relationship, and "what did they decide" questions, prefer the exact self-description or named entity from sessions over a paraphrased summary label.

Good query patterns:
- Candidate summaries:
  psql -At -F '|' -c "SELECT path, summary, creation_date FROM memory WHERE summary ILIKE '%<person>%' AND (summary ILIKE '%<topic1>%' OR summary ILIKE '%<topic2>%') ORDER BY creation_date DESC LIMIT 5"
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
- Do NOT blend multiple different events when the question asks about one specific event. Prefer the most direct supporting row.

Answer rules:
- Return the smallest exact answer supported by the data.
- Resolve relative dates against session metadata, not today's date.
- Do not answer "not found" until you have checked both memory and a likely sessions row.
- Preserve direct relative-duration answers when they already match the question.
- If the transcript already directly answers with a relative duration like "10 years ago", return that phrase instead of recalculating to today's date.
- If a summary says something vague like "home country", search sessions for the exact named place before answering.
- Aggregate across the small candidate set before answering profile or list questions.
- For "likely", "would", or profile questions, a concise inference from strong summary evidence is allowed even if the exact final phrase is not quoted verbatim.

Only psql SELECT queries over memory and sessions are intercepted in this mode. Do NOT use python, python3, node, curl, or filesystem paths for recall in this mode.`;
function buildCodexSessionStartContext(args) {
  const versionNotice = args.currentVersion ? `
Hivemind v${args.currentVersion}` : "";
  const template = isPsqlMode() ? CODEX_SESSION_START_CONTEXT_PSQL : isSessionsOnlyMode() ? CODEX_SESSION_START_CONTEXT_SESSIONS_ONLY : isIndexDisabled() ? CODEX_SESSION_START_CONTEXT_NO_INDEX : CODEX_SESSION_START_CONTEXT;
  return args.creds?.token ? `${template}
Logged in to Deeplake as org: ${args.creds.orgName ?? args.creds.orgId} (workspace: ${args.creds.workspaceId ?? "default"})${versionNotice}` : `${template}
Not logged in to Deeplake. Run: node "${args.authCommand}" login${versionNotice}`;
}
async function runCodexSessionStartHook(input, deps = {}) {
  const { wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1", creds = loadCredentials(), spawnFn = spawn, currentVersion = getInstalledVersion(__bundleDir, ".codex-plugin"), authCommand = AUTH_CMD, setupScript = join4(__bundleDir, "session-start-setup.js"), logFn = log2 } = deps;
  if (wikiWorker)
    return null;
  if (!creds?.token)
    logFn("no credentials found \u2014 run auth login to authenticate");
  else
    logFn(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  if (creds?.token) {
    const child = spawnFn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env }
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    logFn("spawned async setup process");
  }
  return buildCodexSessionStartContext({
    creds,
    currentVersion,
    authCommand
  });
}
async function main() {
  const input = await readStdin();
  const output = await runCodexSessionStartHook(input);
  if (output)
    console.log(output);
}
if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    log2(`fatal: ${e.message}`);
    process.exit(0);
  });
}
export {
  CODEX_SESSION_START_CONTEXT,
  CODEX_SESSION_START_CONTEXT_NO_INDEX,
  CODEX_SESSION_START_CONTEXT_PSQL,
  CODEX_SESSION_START_CONTEXT_SESSIONS_ONLY,
  buildCodexSessionStartContext,
  runCodexSessionStartHook
};
