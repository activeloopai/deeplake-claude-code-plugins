#!/usr/bin/env node

/**
 * Cursor sessionStart hook.
 *
 * Cursor 1.7+ docs: https://cursor.com/docs/agent/hooks
 *
 * Input (from common payload + sessionStart-specific):
 *   { session_id, is_background_agent, composer_mode,
 *     conversation_id, generation_id, model, hook_event_name,
 *     cursor_version, workspace_roots, user_email, transcript_path }
 *
 * Output (JSON to stdout):
 *   { additional_context: "string injected into agent context",
 *     env: { ... env vars exposed to subsequent hooks ... } }
 *
 * Cursor exit codes: 0 = success (use stdout JSON), 2 = block,
 * other = fail-open (proceed with action).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { autoUpdate } from "../shared/autoupdate.js";
import { autoPullSkills } from "../../skillify/auto-pull.js";
const log = (msg: string) => _log("cursor-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Hivemind requires its npm bin (`hivemind` from @deeplake/hivemind) on PATH.
// Inject text uses bare `hivemind <sub>` form — no per-agent path resolution needed.

const context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) → summaries/*.md → sessions/*.jsonl (last resort). Do NOT jump straight to JSONL.
Search: use \`grep\` (NOT \`rg\`/ripgrep). Example: grep -ri "keyword" ~/.deeplake/memory/
IMPORTANT: Only use these bash builtins to interact with ~/.deeplake/memory/: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find. Do NOT use rg/ripgrep, python, python3, node, curl, or other interpreters — they may not be installed and the memory filesystem only supports the listed builtins.
Do NOT spawn subagents to read deeplake memory.

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

SKILLS (skillify) — mine + share reusable skills across the org:
- hivemind skillify                         — show scope/team/install + per-project state
- hivemind skillify pull                    — sync project skills from the org table
- hivemind skillify pull --user <email>     — only that author's skills
- hivemind skillify pull --users a,b,c      — multiple authors (CSV)
- hivemind skillify pull --all-users        — explicit "no author filter"
- hivemind skillify pull --to project|global  — install location
- hivemind skillify pull --dry-run          — preview only
- hivemind skillify pull --force            — overwrite local (creates .bak)
- hivemind skillify pull <skill-name>       — pull only that skill (combines with --user)
- hivemind skillify unpull                  — remove every skill previously installed by pull
- hivemind skillify unpull --user <email>   — remove only that author's pulls
- hivemind skillify unpull --not-mine       — remove all pulls except your own
- hivemind skillify unpull --dry-run        — preview without touching disk
- hivemind skillify scope <me|team|org>     — sharing scope for new skills
- hivemind skillify install <project|global>  — default install location
- hivemind skillify team add|remove|list <name>  — manage team list`;

interface CursorSessionStartInput {
  session_id?: string;
  conversation_id?: string;
  hook_event_name?: string;
  workspace_roots?: string[];
  cursor_version?: string;
  user_email?: string | null;
  transcript_path?: string | null;
  is_background_agent?: boolean;
  composer_mode?: string;
}

/** Resolve the session id Cursor uses (sessionStart provides session_id; reuse conversation_id otherwise). */
function resolveSessionId(input: CursorSessionStartInput): string {
  return input.session_id ?? input.conversation_id ?? `cursor-${Date.now()}`;
}

function resolveCwd(input: CursorSessionStartInput): string {
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === "string") {
    return roots[0];
  }
  return process.cwd();
}

async function createPlaceholder(
  api: DeeplakeApi,
  table: string,
  sessionId: string,
  cwd: string,
  userName: string,
  orgName: string,
  workspaceId: string,
): Promise<void> {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;
  const existing = await api.query(
    `SELECT path FROM "${table}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`,
  );
  if (existing.length > 0) return;

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
    `INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ` +
    `${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'cursor', '${now}', '${now}')`,
  );
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const input = await readStdin<CursorSessionStartInput>();
  const sessionId = resolveSessionId(input);
  const cwd = resolveCwd(input);

  const creds = loadCredentials();
  if (!creds?.token) {
    log("no credentials found");
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }

  // Centralized autoupdate fires BEFORE the DB ensure-table calls — those
  // can stall for tens of seconds against a slow/unreachable backend, and
  // autoUpdate has no dependency on table state. Run it first so the user
  // sees the upgrade notice promptly even when the API is down.
  await autoUpdate(creds, { agent: "cursor" });

  const captureEnabled = process.env.HIVEMIND_CAPTURE !== "false";
  if (creds?.token && captureEnabled) {
    try {
      const config = loadConfig();
      if (config) {
        const table = config.tableName;
        const sessionsTable = config.sessionsTableName;
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
        await api.ensureTable();
        await api.ensureSessionsTable(sessionsTable);
        await createPlaceholder(api, table, sessionId, cwd, config.userName, config.orgName, config.workspaceId);
        log("placeholder created");
      }
    } catch (e: any) {
      log(`placeholder failed: ${e.message}`);
    }
  }

  // Auto-pull skills from all org users on every SessionStart (5s timeout).
  // File writes inside runPull are idempotent (skipped when local version
  // is at-or-newer than remote), so re-running every session is cheap on
  // disk; the only per-call cost is the SQL round-trip. autoPullSkills
  // never rejects — all errors are swallowed inside. Hard opt-out:
  // HIVEMIND_AUTOPULL_DISABLED=1.
  const pullResult = await autoPullSkills();
  log(`autopull: pulled=${pullResult.pulled} skipped=${pullResult.skipped}`);

  let versionNotice = "";
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  if (current) versionNotice = `\nHivemind v${current}`;

  // No placeholder substitution — inject already uses bare `hivemind <sub>` form.
  const additionalContext = creds?.token
    ? `${context}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}`
    : `${context}\nNot logged in to Deeplake. Run: hivemind login${versionNotice}`;

  console.log(JSON.stringify({ additional_context: additionalContext }));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
