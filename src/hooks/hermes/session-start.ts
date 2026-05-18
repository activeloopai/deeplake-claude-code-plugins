/**
 * Hermes on_session_start hook.
 *
 * Hermes hook spec (from agent/shell_hooks.py):
 *   stdin  JSON: { hook_event_name, tool_name?, tool_input?, session_id, cwd, extra? }
 *   stdout JSON: { context: "..." } injects context into pre_llm_call;
 *                for on_session_start, the recommended shape is also { context }
 *                — the docstring describes pre_llm_call but the same wire is
 *                used for session start.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { renderSkillifyCommands } from "../../cli/skillify-spec.js";
import { countLocalManifestEntries } from "../../skillify/local-manifest.js";
import { maybeAutoMineLocal } from "../../skillify/spawn-mine-local-worker.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { autoUpdate } from "../shared/autoupdate.js";
import { autoPullSkills } from "../../skillify/auto-pull.js";
const log = (msg: string) => _log("hermes-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Hivemind requires its npm bin (`hivemind` from @deeplake/hivemind) on PATH.
// Inject text uses bare `hivemind <sub>` form — no per-agent path resolution needed.

const context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) → summaries/*.md → sessions/*.jsonl (last resort). Do NOT jump straight to JSONL.
Search: use \`grep\` (NOT \`rg\`/ripgrep). Example: grep -ri "keyword" ~/.deeplake/memory/
You also have hivemind MCP tools registered: hivemind_search, hivemind_read, hivemind_index. Prefer these — one tool call returns ranked hits across all summaries and sessions in a single SQL query.
IMPORTANT: Only use these bash builtins to interact with ~/.deeplake/memory/: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find. Do NOT use rg/ripgrep, python, python3, node, curl, or other interpreters.
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
${renderSkillifyCommands()}

Embeddings (semantic memory search) — opt-in, persisted in ~/.deeplake/config.json:
- hivemind embeddings install               — download deps (~600MB), symlink agents, set enabled:true
- hivemind embeddings enable                — flip enabled:true (run install first if deps missing)
- hivemind embeddings disable               — flip enabled:false + SIGTERM daemon (deps stay on disk)
- hivemind embeddings uninstall [--prune]   — remove agent symlinks + disable; --prune wipes deps too
- hivemind embeddings status                — show config + deps + per-agent link state`;

interface HermesSessionStartInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

async function createPlaceholder(
  api: DeeplakeApi,
  table: string,
  sessionId: string,
  cwd: string,
  userName: string,
  orgName: string,
  workspaceId: string,
  pluginVersion: string,
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
    `INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ` +
    `${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'hermes', '${sqlStr(pluginVersion)}', '${now}', '${now}')`,
  );
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;
  const input = await readStdin<HermesSessionStartInput>();
  const sessionId = input.session_id ?? `hermes-${Date.now()}`;
  const cwd = input.cwd ?? process.cwd();

  const creds = loadCredentials();
  const captureEnabled = process.env.HIVEMIND_CAPTURE !== "false";

  if (!creds?.token) {
    // Auto-trigger mine-local on first SessionStart for unauthenticated
    // users. Detached spawn — see spawn-mine-local-worker.ts for the
    // full set of guards. Next session shows the count via
    // countLocalManifestEntries().
    maybeAutoMineLocal();
  }

  // Centralized autoupdate fires BEFORE the DB ensure-table calls — those
  // can stall for tens of seconds against a slow/unreachable backend, and
  // autoUpdate has no dependency on table state. Run it first so the user
  // sees the upgrade notice promptly even when the API is down.
  await autoUpdate(creds, { agent: "hermes" });

  // Resolve plugin version once — also stamped on the placeholder row.
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  const pluginVersion = current ?? "";

  if (creds?.token && captureEnabled) {
    try {
      const config = loadConfig();
      if (config) {
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
        await api.ensureTable();
        await api.ensureSessionsTable(config.sessionsTableName);
        await createPlaceholder(api, config.tableName, sessionId, cwd, config.userName, config.orgName, config.workspaceId, pluginVersion);
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
  if (current) versionNotice = `\nHivemind v${current}`;

  // No placeholder substitution — inject already uses bare `hivemind <sub>` form.
  const localMined = countLocalManifestEntries();
  const localMinedNote = localMined > 0
    ? `\n${localMined} local skill${localMined === 1 ? "" : "s"} from past 'hivemind skillify mine-local' run(s) live in ~/.claude/skills/. Run 'hivemind login' to start sharing new mining results with your team.`
    : "";
  const additional = creds?.token
    ? `${context}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}`
    : `${context}\nNot logged in to Deeplake. Run: hivemind login${localMinedNote}${versionNotice}`;

  // Hermes expects { context: "..." } on stdout
  console.log(JSON.stringify({ context: additional }));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
