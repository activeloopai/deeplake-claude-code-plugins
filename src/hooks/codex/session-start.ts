#!/usr/bin/env node

/**
 * Codex SessionStart hook (fast path):
 * Only reads local credentials and injects context into Codex's developer prompt.
 * All server calls (table setup, placeholder, version check) are handled by
 * session-start-setup.js which runs as a separate async hook.
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model, source }
 * Codex output: plain text on stdout (added as developer context)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { autoPullSkills } from "../../skillify/auto-pull.js";
const log = (msg: string) => _log("codex-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Hivemind requires its npm bin (`hivemind` from @deeplake/hivemind) on PATH.
// Inject text uses bare `hivemind <sub>` form — no per-agent path resolution needed.

const context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Deeplake memory has THREE tiers — pick the right one for the question:
1. ~/.deeplake/memory/index.md   — auto-generated index, top 50 most-recently-updated entries with Created + Last Updated + Project + Description columns. ~5 KB. **For "what's recent / who did X this week / since <date>" queries, START HERE** and trust the Last Updated column over any "Started:" line in summary bodies.
2. ~/.deeplake/memory/summaries/ — condensed wiki summaries per session (~3 KB each). For keyword/topic recall, search these.
3. ~/.deeplake/memory/sessions/  — raw full-dialogue JSONL (~5 KB each). FALLBACK only — use when summaries don't contain the exact quote/turn you need.

Search workflow:
- Time-based ("last week", "today", "since X"): cat ~/.deeplake/memory/index.md and read the most-recent rows.
- Keyword/topic recall: grep -r "keyword" ~/.deeplake/memory/summaries/ (the shell hook routes this through hybrid lexical+semantic search — synonyms match too). Then cat the top-matching summary.
- Raw transcript fallback only: grep -r "keyword" ~/.deeplake/memory/sessions/ (use sparingly — JSONL is verbose).

✅ grep -r "keyword" ~/.deeplake/memory/summaries/
❌ grep without a summaries/ or sessions/ suffix — too noisy

IMPORTANT: Only use bash builtins (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) on ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem.
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

interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexSessionStartInput>();

  const creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — run auth login to authenticate");
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }

  // Spawn async setup (table creation, placeholder, version check) as detached process.
  // Codex doesn't support async hooks, so we use the same pattern as the wiki worker.
  if (creds?.token) {
    const setupScript = join(__bundleDir, "session-start-setup.js");
    const child = spawn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env },
    });
    // Feed the same stdin input to the setup process
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    log("spawned async setup process");
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
  const current = getInstalledVersion(__bundleDir, ".codex-plugin");
  if (current) {
    versionNotice = `\nHivemind v${current}`;
  }

  // No placeholder substitution — inject already uses bare `hivemind <sub>` form.
  const additionalContext = creds?.token
    ? `${context}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}`
    : `${context}\nNot logged in to Deeplake. Run: hivemind login${versionNotice}`;

  // Codex SessionStart: plain text on stdout is added as developer context.
  // JSON { additionalContext } format is rejected by Codex 0.118.0.
  console.log(additionalContext);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
