#!/usr/bin/env node

/**
 * SessionStart hook:
 * 1. If no credentials → run device flow login (opens browser)
 * 2. Inject Deeplake memory instructions into Claude's context
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr } from "../utils/sql.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";
import { getInstalledVersion } from "../utils/version-check.js";
import { makeWikiLogger } from "../utils/wiki-log.js";
import { autoUpdate } from "./shared/autoupdate.js";
import { autoPullSkills } from "../skillify/auto-pull.js";
const log = (msg: string) => _log("session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Hivemind requires its npm bin (`hivemind` from @deeplake/hivemind, declared in
// package.json `bin`) to be on PATH. Inject text uses the bare `hivemind <sub>` form
// — no per-agent path resolution needed. Marketplace-only installs without
// `npm i -g @deeplake/hivemind` are unsupported (documented in README + RELEASE_CHECKLIST).

const context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) — global memory shared across all sessions, users, and agents in the org

Deeplake memory has THREE tiers — pick the right one for the question:
1. ~/.deeplake/memory/index.md   — auto-generated index, top 50 most-recently-updated entries with \`Created\` + \`Last Updated\` + \`Project\` + \`Description\` columns. ~5 KB. **For "what's recent / who did X this week / since <date>" queries, START HERE** and trust the \`Last Updated\` column over any \`Started:\` line in summary bodies.
2. ~/.deeplake/memory/summaries/ — condensed wiki summaries per session (~3 KB each). For keyword/topic recall, search these.
3. ~/.deeplake/memory/sessions/  — raw full-dialogue JSONL (~5 KB each). FALLBACK only — use when summaries don't contain the exact quote/turn you need.

Search workflow:
  - Time-based ("last week", "today", "since X"): \`cat ~/.deeplake/memory/index.md\` and read the most-recent rows.
  - Keyword/topic recall: use the **Bash tool** with \`grep -r "keyword" ~/.deeplake/memory/summaries/\`. The Bash hook routes this through hybrid lexical+semantic search — synonyms / paraphrases match too. Then \`cat\` the top-matching summary to pull the answer.
  - Raw transcript fallback only: \`grep -r "keyword" ~/.deeplake/memory/sessions/\` (use sparingly — JSONL is verbose).

Tool choice on this mount:
  ✅ Bash tool with \`grep -r\` / \`cat\` / \`ls\` / \`head\` / \`tail\` — supported, fast.
  ❌ Built-in Grep tool — not supported on this path; use Bash grep instead.
  ❌ \`grep\` without a \`summaries/\` or \`sessions/\` suffix — too noisy, drowns the answer.

Organization management — each argument is SEPARATE (do NOT quote subcommands together):
- hivemind login                              — SSO login
- hivemind whoami                             — show current user/org
- hivemind org list                           — list organizations
- hivemind org switch <name-or-id>            — switch organization
- hivemind workspaces                         — list workspaces
- hivemind workspace <id>                     — switch workspace
- hivemind invite <email> <ADMIN|WRITE|READ>  — invite member (ALWAYS ask user which role before inviting)
- hivemind members                            — list members
- hivemind remove <user-id>                   — remove member

Skill management (mine + share reusable Claude skills across the org):
- hivemind skillify                                  — show scope, team, install, per-project state
- hivemind skillify pull                             — sync project skills from the org table to local FS
- hivemind skillify pull --user <email>              — only skills authored by that user
- hivemind skillify pull --users <a,b,c>             — only skills from those authors
- hivemind skillify pull --all-users                 — explicit "no author filter" (default)
- hivemind skillify pull --to <project|global>       — install location (project=cwd/.claude/skills, global=~/.claude/skills)
- hivemind skillify pull --dry-run                   — preview without touching disk
- hivemind skillify pull --force                     — overwrite local files even if up-to-date (creates .bak)
- hivemind skillify pull <skill-name>                — pull only that one skill (combines with --user)
- hivemind skillify unpull                           — remove every skill previously installed by pull
- hivemind skillify unpull --user <email>            — remove only that author's pulls
- hivemind skillify unpull --not-mine                — remove all pulls except your own
- hivemind skillify unpull --dry-run                 — preview without touching disk
- hivemind skillify scope <me|team>                  — sharing scope for newly mined skills
- hivemind skillify install <project|global>         — default install location for new skills
- hivemind skillify promote <skill-name>             — move a project skill to the global location
- hivemind skillify team add|remove|list <name>      — manage team member list

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem. Avoid bash brace expansions like \`{1..10}\` (not fully supported); spell out paths explicitly. Bash output is capped at 10MB total — avoid \`for f in *.json; do cat $f\` style loops on the whole sessions dir.

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;

const HOME = homedir();
const { log: wikiLog } = makeWikiLogger(join(HOME, ".claude", "hooks"));

/** Create a placeholder summary via direct SQL INSERT (no DeeplakeFs bootstrap needed). */
async function createPlaceholder(api: DeeplakeApi, table: string, sessionId: string, cwd: string, userName: string, orgName: string, workspaceId: string, pluginVersion: string): Promise<void> {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;

  const existing = await api.query(
    `SELECT path FROM "${table}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`
  );
  if (existing.length > 0) {
    wikiLog(`SessionStart: summary exists for ${sessionId} (resumed)`);
    return;
  }

  const now = new Date().toISOString();
  const projectName = cwd.split("/").pop() ?? "unknown";
  const sessionSource = `/sessions/${userName}/${userName}_${orgName}_${workspaceId}_${sessionId}.jsonl`;
  const content = [
    `# Session ${sessionId}`,
    `- **Source**: ${sessionSource}`,
    `- **Started**: ${now}`,
    `- **Project**: ${projectName}`,
    `- **Status**: in-progress`,
    "",
  ].join("\n");
  const filename = `${sessionId}.md`;

  await api.query(
    `INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ` +
    `${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'claude_code', '${sqlStr(pluginVersion)}', '${now}', '${now}')`
  );

  wikiLog(`SessionStart: created placeholder for ${sessionId} (${cwd})`);
}

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  // Skip if this is a sub-session spawned by the wiki worker
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const __hookT0 = Date.now();
  log(`hook entered (pid=${process.pid})`);

  const input = await readStdin<SessionStartInput>();

  let creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — run /hivemind:login to authenticate");
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    // Backfill userName if missing (for users who logged in before this field was added)
    if (creds.token && !creds.userName) {
      try {
        const { userInfo } = await import("node:os");
        creds.userName = userInfo().username ?? "unknown";
        saveCredentials(creds);
        log(`backfilled and persisted userName: ${creds.userName}`);
      } catch { /* non-fatal */ }
    }
  }

  // Centralized autoupdate fires BEFORE the DB ensure-table calls — those
  // can stall for tens of seconds against a slow/unreachable backend, and
  // autoUpdate has no dependency on table state. Run it first so the user
  // sees the upgrade notice promptly even when the API is down.
  await autoUpdate(creds, { agent: "claude" });

  // Resolve the installed plugin version once up front — it's stamped on
  // every row this session writes (placeholder + capture) and is also used
  // for the user-visible update notice below.
  // getInstalledVersion swallows its own fs errors and returns null.
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  const pluginVersion = current ?? "";

  // Ensure tables exist and (when capture is enabled) create the placeholder
  // summary via direct SQL. Tables must always be synced so queries return
  // fresh data — only the placeholder INSERT is skipped when HIVEMIND_CAPTURE=false
  // (benchmark runs, explicit opt-out). Mirrors the guard already in
  // session-start-setup.ts / session-end.ts / codex hooks.
  const captureEnabled = process.env.HIVEMIND_CAPTURE !== "false";
  if (input.session_id && creds?.token) {
    try {
      const config = loadConfig();
      if (config) {
        const table = config.tableName;
        const sessionsTable = config.sessionsTableName;
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
        await api.ensureTable();
        await api.ensureSessionsTable(sessionsTable);
        if (captureEnabled) {
          await createPlaceholder(api, table, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId, pluginVersion);
          log("placeholder created");
        } else {
          log("placeholder skipped (HIVEMIND_CAPTURE=false)");
        }
      }
    } catch (e: any) {
      log(`placeholder failed: ${e.message}`);
      wikiLog(`SessionStart: placeholder failed for ${input.session_id}: ${e.message}`);
    }
  }

  // Auto-pull skills from all org users into ~/.claude/skills/ on every
  // SessionStart. File writes inside runPull are idempotent (skipped
  // when local version is at-or-newer than remote), so re-running each
  // session is cheap on disk; the only per-call cost is the SQL
  // round-trip. Bounded by a 5s timeout so a slow Deeplake never
  // freezes SessionStart. Hard opt-out via HIVEMIND_AUTOPULL_DISABLED=1.
  // All failures swallowed inside autoPullSkills (documented as
  // never-rejecting), so no try/catch needed here.
  const pullResult = await autoPullSkills();
  log(`autopull: pulled=${pullResult.pulled} skipped=${pullResult.skipped}`);

  // Version notice in additionalContext — informational only; the
  // upgrade-applied signal goes to stderr from inside autoUpdate (which
  // already fired earlier in main(), before the DB ensure-table calls).
  const updateNotice = current ? `\n\n✅ Hivemind v${current}` : "";

  // No placeholder substitution needed — inject uses bare `hivemind <sub>` form.
  const resolvedContext = context;
  const additionalContext = creds?.token
    ? `${resolvedContext}\n\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${updateNotice}`
    : `${resolvedContext}\n\n⚠️ Not logged in to Deeplake. Memory search will not work. Ask the user to run /hivemind:login to authenticate.${updateNotice}`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  }));
  log(`hook done (${Date.now() - __hookT0}ms total)`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
