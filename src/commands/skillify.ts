#!/usr/bin/env node

/**
 * CLI surface for skillify scope, team, install, and pull management.
 *
 * Usage:
 *   hivemind skillify                              — show current scope, team, status
 *   hivemind skillify scope <me|team>              — set the mining scope
 *   hivemind skillify install <project|global>     — set where new skills are written
 *   hivemind skillify promote <skill-name>         — move a project skill to global
 *   hivemind skillify team add <username>          — add a username to the team list
 *   hivemind skillify team remove <username>       — remove a username from the team list
 *   hivemind skillify team list                    — list current team members
 *   hivemind skillify pull [skill-name] [opts]     — fetch skills from Deeplake to local FS
 *   hivemind skillify status                       — show counter + per-project state
 *
 * The team list is consumed by the worker when scope=team: SQL filter
 * becomes `author IN (<team>)`. scope=me filters by current user only.
 * A legacy scope=org value (no author filter) was retired; the parser
 * silently coerces it to "team" when read from an old config.json so
 * users who set it once don't get a hard failure on next session.
 */

import { readdirSync, existsSync, readFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadScopeConfig, saveScopeConfig, type Scope, type InstallLocation } from "../skillify/scope-config.js";
import { runPull, type PullSummary } from "../skillify/pull.js";
import { runUnpull } from "../skillify/unpull.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";

// Compute lazily so tests that swap `process.env.HOME` actually affect the
// path. A module-level `const STATE_DIR = join(homedir(), ...)` would
// capture the developer's real home at import time and bypass HOME
// isolation, causing test runs to read & pollute ~/.deeplake/state/skillify.
function stateDir(): string {
  return join(homedir(), ".deeplake", "state", "skillify");
}

function showStatus(): void {
  const cfg = loadScopeConfig();
  console.log(`scope:   ${cfg.scope}`);
  console.log(`team:    ${cfg.team.length === 0 ? "(empty)" : cfg.team.join(", ")}`);
  console.log(`install: ${cfg.install}  (${cfg.install === "global" ? "~/.claude/skills/" : "<project>/.claude/skills/"})`);

  const dir = stateDir();
  if (!existsSync(dir)) {
    console.log(`state: (no projects tracked yet)`);
    return;
  }
  // Filter out skillify's own bookkeeping files. `config.json` is the
  // scope/team/install settings; `pulled.json` is the unpull manifest;
  // `autopull-last-run.json` is the (now-removed) throttle file that pre-
  // rename installs may still contain. None of these represent a "tracked
  // project" and counting them inflates the status output (and the `for`
  // loop below would JSON.parse them with the wrong shape).
  const files = readdirSync(dir).filter(
    f =>
      f.endsWith(".json") &&
      f !== "config.json" &&
      f !== "pulled.json" &&
      f !== "autopull-last-run.json",
  );
  if (files.length === 0) {
    console.log(`state: (no projects tracked yet)`);
    return;
  }
  console.log(`state: ${files.length} project(s) tracked`);
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf-8")) as {
        project: string;
        counter: number;
        lastDate?: string | null;
        updatedAt?: number;
        skillsGenerated?: string[];
      };
      // Prefer `updatedAt` (always written on counter bump) over `lastDate`
      // (only written on a KEEP/MERGE mining verdict). An active project
      // with no successful mining yet would otherwise show "last=never".
      const last =
        typeof s.updatedAt === "number"
          ? new Date(s.updatedAt).toISOString()
          : s.lastDate ?? "never";
      const skills = Array.isArray(s.skillsGenerated) && s.skillsGenerated.length > 0
        ? s.skillsGenerated.join(", ")
        : "none";
      console.log(`  - ${s.project} (counter=${s.counter}, last=${last}, skills=${skills})`);
    } catch { /* skip malformed */ }
  }
}

function setScope(scope: string): void {
  if (scope !== "me" && scope !== "team") {
    console.error(`Invalid scope '${scope}'. Use one of: me, team`);
    process.exit(1);
  }
  const cfg = loadScopeConfig();
  saveScopeConfig({ ...cfg, scope: scope as Scope });
  console.log(`Scope set to '${scope}'.`);
  if (scope === "team" && cfg.team.length === 0) {
    console.log(`Note: team list is empty. Use 'hivemind skillify team add <username>' to populate it.`);
  }
}

function setInstall(loc: string): void {
  if (loc !== "project" && loc !== "global") {
    console.error(`Invalid install location '${loc}'. Use one of: project, global`);
    process.exit(1);
  }
  const cfg = loadScopeConfig();
  saveScopeConfig({ ...cfg, install: loc as InstallLocation });
  const path = loc === "global" ? join(homedir(), ".claude", "skills") : "<cwd>/.claude/skills";
  console.log(`Install location set to '${loc}'. New skills will be written to ${path}/<name>/SKILL.md.`);
}

function promoteSkill(name: string, cwd: string): void {
  if (!name) { console.error("Usage: hivemind skillify promote <skill-name>"); process.exit(1); }
  const projectPath = join(cwd, ".claude", "skills", name);
  const globalPath = join(homedir(), ".claude", "skills", name);
  if (!existsSync(join(projectPath, "SKILL.md"))) {
    console.error(`Skill '${name}' not found at ${projectPath}/SKILL.md`);
    process.exit(1);
  }
  if (existsSync(join(globalPath, "SKILL.md"))) {
    console.error(`Skill '${name}' already exists at ${globalPath}/SKILL.md — refusing to overwrite. Remove it first or rename the project skill.`);
    process.exit(1);
  }
  mkdirSync(dirname(globalPath), { recursive: true });
  renameSync(projectPath, globalPath);
  console.log(`Promoted '${name}' from ${projectPath} → ${globalPath}.`);
}

function teamAdd(name: string): void {
  if (!name) { console.error("Usage: hivemind skillify team add <username>"); process.exit(1); }
  const cfg = loadScopeConfig();
  if (cfg.team.includes(name)) {
    console.log(`'${name}' is already in the team list.`);
    return;
  }
  const next = [...cfg.team, name].sort();
  saveScopeConfig({ ...cfg, team: next });
  console.log(`Added '${name}' to team. Team is now: ${next.join(", ")}`);
}

function teamRemove(name: string): void {
  if (!name) { console.error("Usage: hivemind skillify team remove <username>"); process.exit(1); }
  const cfg = loadScopeConfig();
  if (!cfg.team.includes(name)) {
    console.log(`'${name}' is not in the team list.`);
    return;
  }
  const next = cfg.team.filter(n => n !== name);
  saveScopeConfig({ ...cfg, team: next });
  console.log(`Removed '${name}' from team. Team is now: ${next.length === 0 ? "(empty)" : next.join(", ")}`);
}

function teamList(): void {
  const cfg = loadScopeConfig();
  if (cfg.team.length === 0) {
    console.log(`(team list is empty)`);
    return;
  }
  for (const n of cfg.team) console.log(n);
}

function usage(): void {
  console.log("Usage:");
  console.log("  hivemind skillify                            show current scope, team, install, and per-project state");
  console.log("  hivemind skillify scope <me|team>            set the mining scope");
  console.log("  hivemind skillify install <project|global>   set where new skills are written");
  console.log("  hivemind skillify promote <skill-name>       move a project skill to the global location");
  console.log("  hivemind skillify team add <username>        add a username to the team list");
  console.log("  hivemind skillify team remove <username>     remove a username from the team list");
  console.log("  hivemind skillify team list                  list current team members");
  console.log("  hivemind skillify pull [skill-name] [opts]   fetch skills from Deeplake to local FS");
  console.log("    Options for pull:");
  console.log("      --to <project|global>     destination (default: global)");
  console.log("      --user <name>             only skills authored by this user");
  console.log("      --users <a,b,c>           only skills authored by these users");
  console.log("      --all-users               all authors (default — equivalent to no filter)");
  console.log("      --dry-run                 show what would be written, don't touch disk");
  console.log("      --force                   overwrite even when local version >= remote");
  console.log("  hivemind skillify unpull [opts]              remove skills previously installed by pull");
  console.log("    Options for unpull:");
  console.log("      --to <project|global>     where to scan (default: global)");
  console.log("      --user <name>             only entries authored by this user");
  console.log("      --users <a,b,c>           only entries authored by these users");
  console.log("      --not-mine                remove all pulled entries except your own");
  console.log("      --dry-run                 show what would be removed");
  console.log("      --all                     also remove flat-layout (locally-mined) entries");
  console.log("      --legacy-cleanup          also remove pre-`--author`-layout legacy `<projectKey>/` dirs");
  console.log("  hivemind skillify status                     show per-project state");
}

/** Parse a single string flag value out of `args`, removing the matched tokens. */
function takeFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  args.splice(idx, 2);
  return value;
}

function takeBooleanFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx < 0) return false;
  args.splice(idx, 1);
  return true;
}

async function pullSkills(args: string[]): Promise<void> {
  // Parse flags first so the remaining positional is the optional skill name
  const work = [...args];
  const toRaw = takeFlagValue(work, "--to") ?? "global";
  const userOne = takeFlagValue(work, "--user");
  const usersMany = takeFlagValue(work, "--users");
  const allUsers = takeBooleanFlag(work, "--all-users");
  const dryRun = takeBooleanFlag(work, "--dry-run");
  const force = takeBooleanFlag(work, "--force");
  const skillName = work[0];

  if (toRaw !== "project" && toRaw !== "global") {
    console.error(`Invalid --to '${toRaw}'. Use 'project' or 'global'.`);
    process.exit(1);
  }

  // Build the user filter list. --all-users (or no filter at all) → empty array
  // = no SQL author filter. --user X → ["X"]. --users a,b,c → ["a","b","c"].
  let users: string[] = [];
  if (allUsers) users = [];
  else if (userOne) users = [userOne];
  else if (usersMany) users = usersMany.split(",").map(s => s.trim()).filter(Boolean);

  const config = loadConfig();
  if (!config) {
    console.error("Not logged in. Run: hivemind login");
    process.exit(1);
  }
  const api = new DeeplakeApi(
    config.token, config.apiUrl, config.orgId, config.workspaceId, config.skillsTableName,
  );
  // Wrap api.query so it matches the QueryFn signature expected by runPull.
  const query = (sql: string) => api.query(sql) as Promise<Record<string, unknown>[]>;

  let summary: PullSummary;
  try {
    summary = await runPull({
      query,
      tableName: config.skillsTableName,
      install: toRaw,
      cwd: toRaw === "project" ? process.cwd() : undefined,
      users,
      skillName,
      dryRun,
      force,
    });
  } catch (e: any) {
    console.error(`pull failed: ${e?.message ?? e}`);
    process.exit(1);
  }

  // Pretty output
  const dest = toRaw === "global" ? join(homedir(), ".claude", "skills") : `${process.cwd()}/.claude/skills`;
  const filterDesc = users.length === 0 ? "all users" : users.join(", ");
  console.log(`Destination: ${dest}`);
  console.log(`Filter:      ${filterDesc}${skillName ? ` · skill='${skillName}'` : ""}${dryRun ? " · dry-run" : ""}${force ? " · force" : ""}`);
  console.log(`Scanned ${summary.scanned} remote skill(s).`);
  for (const e of summary.entries) {
    const tag = e.action === "wrote" ? "✓ wrote" : e.action === "dryrun" ? "→ would write" : "· skipped";
    const ver = e.localVersion === null ? `v${e.remoteVersion} (new)` : `v${e.localVersion} → v${e.remoteVersion}`;
    console.log(`  ${tag.padEnd(15)} ${e.name.padEnd(40)} ${ver.padEnd(20)} (${e.author}/${e.sourceAgent})`);
    if (e.manifestError) {
      // Skill is on disk but absent from pulled.json — `unpull` won't
      // be able to remove it. Loud warning so the user knows to either
      // delete it manually or repull (which retries the manifest write).
      console.warn(`    ⚠ manifest not updated: ${e.manifestError} — \`unpull\` will not see this entry until a successful repull.`);
    }
  }
  console.log(`Result: ${summary.wrote} written, ${summary.dryrun} dry-run, ${summary.skipped} skipped.`);
}

async function unpullSkills(args: string[]): Promise<void> {
  const work = [...args];
  const toRaw = takeFlagValue(work, "--to") ?? "global";
  const userOne = takeFlagValue(work, "--user");
  const usersMany = takeFlagValue(work, "--users");
  const notMine = takeBooleanFlag(work, "--not-mine");
  const dryRun = takeBooleanFlag(work, "--dry-run");
  const all = takeBooleanFlag(work, "--all");
  const legacyCleanup = takeBooleanFlag(work, "--legacy-cleanup");

  // Throw rather than `process.exit(1)` so the dispatcher's `.catch` is
  // the single point that surfaces the failure — avoids a second exit
  // call (and a second mocked-throw in tests) that would manifest as an
  // unhandled promise rejection.
  if (toRaw !== "project" && toRaw !== "global") {
    throw new Error(`Invalid --to '${toRaw}'. Use 'project' or 'global'.`);
  }

  let users: string[] = [];
  if (userOne) users = [userOne];
  else if (usersMany) users = usersMany.split(",").map(s => s.trim()).filter(Boolean);

  // Unpull is a local filesystem operation: deleting `<root>/<dir>/` and
  // pruning `pulled.json`. The Deeplake API is never queried. The only
  // reason we need credentials is `--not-mine`, which compares each
  // entry's author to `config.userName`. Skip the login check otherwise so
  // a user who's been bounced from the org can still clean up their disk.
  let myUsername: string | undefined;
  if (notMine) {
    const config = loadConfig();
    if (!config) {
      throw new Error("--not-mine requires a logged-in user. Run: hivemind login");
    }
    myUsername = config.userName;
  }

  const summary = runUnpull({
    install: toRaw,
    cwd: toRaw === "project" ? process.cwd() : undefined,
    users,
    myUsername,
    notMine,
    dryRun,
    all,
    legacyCleanup,
  });

  const dest = toRaw === "global" ? join(homedir(), ".claude", "skills") : `${process.cwd()}/.claude/skills`;
  const filterParts: string[] = [];
  if (users.length > 0) filterParts.push(`users=${users.join(",")}`);
  if (notMine) filterParts.push("not-mine");
  if (all) filterParts.push("all");
  if (legacyCleanup) filterParts.push("legacy-cleanup");
  if (dryRun) filterParts.push("dry-run");
  const filterDesc = filterParts.length ? filterParts.join(" · ") : "(no filter — all pulled)";

  console.log(`Scanning:    ${dest}`);
  console.log(`Filter:      ${filterDesc}`);
  console.log(`Scanned ${summary.scanned} dir(s).`);
  for (const e of summary.entries) {
    const tag =
      e.action === "removed" ? "✓ removed" :
      e.action === "would-remove" ? "→ would remove" :
      e.action === "manifest-pruned" ? "⚠ pruned (orphan)" :
      "· kept";
    const id = e.dirName;
    const note = e.reason ? `  (${e.reason})` : "";
    console.log(`  ${tag.padEnd(20)} ${id.padEnd(50)} [${e.kind}]${note}`);
  }
  const prunedNote = summary.manifestPruned > 0 ? `, ${summary.manifestPruned} manifest-pruned` : "";
  console.log(`Result: ${summary.removed} removed, ${summary.wouldRemove} dry-run, ${summary.kept} kept${prunedNote}.`);
}

export function runSkillifyCommand(args: string[]): void {
  const sub = args[0];
  if (!sub || sub === "status") { showStatus(); return; }
  if (sub === "scope")   { setScope(args[1] ?? ""); return; }
  if (sub === "install") { setInstall(args[1] ?? ""); return; }
  if (sub === "promote") { promoteSkill(args[1] ?? "", process.cwd()); return; }
  if (sub === "pull") {
    pullSkills(args.slice(1)).catch(e => {
      console.error(`pull error: ${e?.message ?? e}`);
      process.exit(1);
    });
    return;
  }
  if (sub === "unpull") {
    unpullSkills(args.slice(1))
      .catch(e => {
        console.error(`unpull error: ${e?.message ?? e}`);
        process.exit(1);
      })
      // process.exit is mocked in unit tests as a throw; swallow that
      // secondary rejection so it doesn't surface as an unhandled error.
      // In production the real process.exit kills the process, so this
      // tail catch is unreachable.
      .catch(() => { /* test-only safety net */ });
    return;
  }
  if (sub === "team") {
    const action = args[1];
    if (action === "add")    { teamAdd(args[2] ?? ""); return; }
    if (action === "remove") { teamRemove(args[2] ?? ""); return; }
    if (action === "list")   { teamList(); return; }
    console.error("Usage: hivemind skillify team <add|remove|list> [name]");
    process.exit(1);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") { usage(); return; }
  console.error(`Unknown skillify subcommand: ${sub}`);
  usage();
  process.exit(1);
}

// Run as a standalone script only when invoked directly via Node — not when
// imported by the unified CLI (`bundle/cli.js`). Identify by the entry
// script's filename, the same pattern auth-login.ts uses.
if (process.argv[1] && process.argv[1].endsWith("skillify.js")) {
  runSkillifyCommand(process.argv.slice(2));
}
