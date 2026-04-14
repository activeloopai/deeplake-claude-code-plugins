#!/usr/bin/env node

/**
 * SessionStart hook:
 * 1. If no credentials → run device flow login (opens browser)
 * 2. Inject Deeplake memory instructions into Claude's context
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials, login } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr } from "../utils/sql.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log, utcTimestamp } from "../utils/debug.js";
const log = (msg: string) => _log("session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

const context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) — global memory shared across all sessions, users, and agents in the org

Deeplake memory structure:
- ~/.deeplake/memory/index.md — START HERE, table of all sessions
- ~/.deeplake/memory/summaries/username/*.md — AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/username/*.jsonl — raw session data (last resort)

SEARCH STRATEGY: Always read index.md first. Then read specific summaries. Only read raw JSONL if summaries don't have enough detail. Do NOT jump straight to JSONL files.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management — each argument is SEPARATE (do NOT quote subcommands together):
- node "DEEPLAKE_AUTH_CMD" login                              — SSO login
- node "DEEPLAKE_AUTH_CMD" whoami                             — show current user/org
- node "DEEPLAKE_AUTH_CMD" org list                           — list organizations
- node "DEEPLAKE_AUTH_CMD" org switch <name-or-id>            — switch organization
- node "DEEPLAKE_AUTH_CMD" workspaces                         — list workspaces
- node "DEEPLAKE_AUTH_CMD" workspace <id>                     — switch workspace
- node "DEEPLAKE_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  — invite member (ALWAYS ask user which role before inviting)
- node "DEEPLAKE_AUTH_CMD" members                            — list members
- node "DEEPLAKE_AUTH_CMD" remove <user-id>                   — remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;

const GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
const VERSION_CHECK_TIMEOUT = 3000; // 3s — don't block session start

function getInstalledVersion(): string | null {
  // Walk up from the bundle directory to find the nearest package.json.
  // Depending on install method the layout varies:
  //   marketplace: <root>/claude-code/bundle/  → package.json is 2 levels up
  //   cache:       <root>/bundle/              → package.json is 1 level up (if present)
  let dir = __bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version) return pkg.version;
    } catch { /* not here, keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_RAW_PKG, { signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT) });
    if (!res.ok) return null;
    const pkg = await res.json();
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
}

const HOME = homedir();
const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${utcTimestamp()}] ${msg}\n`);
  } catch { /* ignore */ }
}

/** Create a placeholder summary via direct SQL INSERT (no DeeplakeFs bootstrap needed). */
async function createPlaceholder(api: DeeplakeApi, table: string, sessionId: string, cwd: string, userName: string, orgName: string, workspaceId: string): Promise<void> {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;

  // Check if summary already exists (resumed session)
  await api.query(`SELECT deeplake_sync_table('${table}')`);
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
    `INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ` +
    `${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'claude_code', '${now}', '${now}')`
  );

  wikiLog(`SessionStart: created placeholder for ${sessionId} (${cwd})`);
}

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  // Skip if this is a sub-session spawned by the wiki worker
  if (process.env.DEEPLAKE_WIKI_WORKER === "1") return;

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

  // Create placeholder summary + ensure sessions table via direct SQL (no DeeplakeFs bootstrap)
  if (input.session_id && creds?.token) {
    try {
      const config = loadConfig();
      if (config) {
        const table = config.tableName;
        const sessionsTable = config.sessionsTableName;
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
        // Ensure both tables exist (once per session)
        await api.ensureTable();
        await api.ensureSessionsTable(sessionsTable);
        await createPlaceholder(api, table, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
        log("placeholder created");
      }
    } catch (e: any) {
      log(`placeholder failed: ${e.message}`);
      wikiLog(`SessionStart: placeholder failed for ${input.session_id}: ${e.message}`);
    }
  }

  // Version check (non-blocking — failures are silently ignored)
  const autoupdate = creds?.autoupdate !== false; // default: true
  let updateNotice = "";
  try {
    const current = getInstalledVersion();
    if (current) {
      const latest = await getLatestVersion();
      if (latest && isNewer(latest, current)) {
        if (autoupdate) {
          log(`autoupdate: updating ${current} → ${latest}`);
          try {
            const scopes = ["user", "project", "local", "managed"];
            const cmd = scopes
              .map(s => `claude plugin update hivemind@hivemind --scope ${s} 2>/dev/null`)
              .join("; ");
            execSync(cmd, { stdio: "ignore", timeout: 60_000 });
            // Clean up old cached versions, keep only the latest
            try {
              const cacheParent = join(homedir(), ".claude", "plugins", "cache", "hivemind", "hivemind");
              const entries = readdirSync(cacheParent, { withFileTypes: true });
              for (const e of entries) {
                if (e.isDirectory() && e.name !== latest) {
                  rmSync(join(cacheParent, e.name), { recursive: true, force: true });
                  log(`cache cleanup: removed old version ${e.name}`);
                }
              }
            } catch (e: any) {
              log(`cache cleanup failed: ${e.message}`);
            }
            updateNotice = `\n\n✅ Hivemind auto-updated: ${current} → ${latest}. Run /reload-plugins to apply.`;
            process.stderr.write(`✅ Hivemind auto-updated: ${current} → ${latest}. Run /reload-plugins to apply.\n`);
            log(`autoupdate succeeded: ${current} → ${latest}`);
          } catch (e: any) {
            updateNotice = `\n\n⬆️ Hivemind update available: ${current} → ${latest}. Auto-update failed — run /hivemind:update to upgrade manually.`;
            process.stderr.write(`⬆️ Hivemind update available: ${current} → ${latest}. Auto-update failed — run /hivemind:update to upgrade manually.\n`);
            log(`autoupdate failed: ${e.message}`);
          }
        } else {
          updateNotice = `\n\n⬆️ Hivemind update available: ${current} → ${latest}. Run /hivemind:update to upgrade.`;
          process.stderr.write(`⬆️ Hivemind update available: ${current} → ${latest}. Run /hivemind:update to upgrade.\n`);
          log(`update available (autoupdate off): ${current} → ${latest}`);
        }
      } else {
        log(`version up to date: ${current}`);
        updateNotice = `\n\n✅ Hivemind v${current} (up to date)`;
      }
    }
  } catch (e: any) {
    log(`version check failed: ${e.message}`);
  }

  const resolvedContext = context.replace(/DEEPLAKE_AUTH_CMD/g, AUTH_CMD);
  const additionalContext = creds?.token
    ? `${resolvedContext}\n\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${updateNotice}`
    : `${resolvedContext}\n\n⚠️ Not logged in to Deeplake. Memory search will not work. Ask the user to run /hivemind:login to authenticate.${updateNotice}`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  }));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
