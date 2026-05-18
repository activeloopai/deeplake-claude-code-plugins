import { installClaude, uninstallClaude } from "./install-claude.js";
import { installCodex, uninstallCodex } from "./install-codex.js";
import { installOpenclaw, uninstallOpenclaw } from "./install-openclaw.js";
import { installCursor, uninstallCursor } from "./install-cursor.js";
import { installHermes, uninstallHermes } from "./install-hermes.js";
import { installPi, uninstallPi } from "./install-pi.js";
import {
  disableEmbeddings,
  enableEmbeddings,
  installEmbeddings,
  statusEmbeddings,
  uninstallEmbeddings,
} from "./embeddings.js";
import { ensureLoggedIn, isLoggedIn, maybeShowOrgChoice } from "./auth.js";
import { runAuthCommand } from "../commands/auth-login.js";
import { runSkillifyCommand } from "../commands/skillify.js";
import { detectPlatforms, allPlatformIds, log, warn, type PlatformId } from "./util.js";
import { getVersion } from "./version.js";
import { runUpdate } from "./update.js";
import { renderCliHelpBlock } from "./skillify-spec.js";

const AUTH_SUBCOMMANDS = new Set([
  "whoami",
  "logout",
  "org",
  "workspaces",
  "workspace",
  "invite",
  "members",
  "remove",
  "autoupdate",
  "sessions",
]);

const USAGE = `
hivemind — one brain for every agent on your team

Usage:
  hivemind install   [--only <platforms>] [--skip-auth]
      Auto-detect assistants on this machine and install hivemind into each.
      --only takes a comma-separated list: ${allPlatformIds().join(",")}

  hivemind uninstall [--only <platforms>]
      Auto-detect installed assistants and remove hivemind from each.
      --only takes the same list to scope the removal.

  hivemind claude  install | uninstall
  hivemind codex   install | uninstall
  hivemind claw    install | uninstall
  hivemind cursor  install | uninstall
  hivemind hermes  install | uninstall
  hivemind pi      install | uninstall
      Install or remove hivemind for a specific assistant.

  hivemind login            Run device-flow login (open browser).
  hivemind status           Show which assistants are wired up.
  hivemind update [--dry-run]
      Check npm for a newer @deeplake/hivemind, upgrade the CLI, and refresh
      every detected agent bundle. Single command for all agents.

Semantic search (embeddings):
  hivemind embeddings install                Download @huggingface/transformers
                                             once (~600 MB) into a shared dir,
                                             symlink every detected agent
                                             plugin to it, and set
                                             embeddings.enabled = true in
                                             ~/.deeplake/config.json. Idempotent.
  hivemind embeddings enable                 Light opt-in: flip
                                             embeddings.enabled = true in
                                             ~/.deeplake/config.json. Use this
                                             after \`disable\` to turn back on
                                             without re-running install.
  hivemind embeddings disable                Light opt-out: flip
                                             embeddings.enabled = false and
                                             SIGTERM the running daemon. Shared
                                             deps stay on disk.
  hivemind embeddings uninstall [--prune]    Full opt-out: remove the per-agent
                                             symlinks, flip
                                             embeddings.enabled = false, and
                                             SIGTERM the daemon. --prune also
                                             deletes the shared dir to reclaim
                                             ~600 MB.
  hivemind embeddings status                 Show config + shared-deps + per-
                                             agent state.

  Add --with-embeddings to "hivemind install" (or "hivemind <agent> install")
  to run "embeddings install" automatically after installing the agent(s).

Skill management (mine + share reusable Claude skills across the org):
${renderCliHelpBlock()}

Account / org / workspace:
  hivemind whoami                          Show current user, org, workspace.
  hivemind logout                          Remove credentials.
  hivemind org list                        List organizations.
  hivemind org switch <name-or-id>         Switch active organization.
  hivemind workspaces                      List workspaces in current org.
  hivemind workspace list                  List workspaces (alias of 'workspaces').
  hivemind workspace switch <name-or-id>   Switch active workspace.
  hivemind members                         List org members.
  hivemind invite <email> <ADMIN|WRITE|READ>  Invite a teammate.
  hivemind remove <user-id>                Remove a member.
  hivemind autoupdate [on|off]             Toggle Claude Code plugin auto-update.
  hivemind sessions prune [...]            Manage your captured sessions.

  hivemind --version        Print the hivemind version.
  hivemind --help           Show this message.

Docs:  https://github.com/activeloopai/hivemind
`.trim();

function parseOnly(args: string[]): PlatformId[] | null {
  const idx = args.findIndex(a => a === "--only" || a.startsWith("--only="));
  if (idx === -1) return null;
  const raw = args[idx].includes("=") ? args[idx].split("=", 2)[1] : args[idx + 1];
  if (!raw) return null;
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean) as PlatformId[];
  const valid = new Set(allPlatformIds());
  const bad = ids.filter(id => !valid.has(id));
  if (bad.length > 0) {
    warn(`Unknown platform(s): ${bad.join(", ")}. Valid: ${allPlatformIds().join(", ")}`);
    process.exit(1);
  }
  return ids;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function runInstallAll(args: string[]): Promise<void> {
  const only = parseOnly(args);
  const skipAuth = hasFlag(args, "--skip-auth");
  const withEmbeddings = hasFlag(args, "--with-embeddings");

  const targets: PlatformId[] = only ?? detectPlatforms().map(p => p.id);

  if (targets.length === 0) {
    log("No supported assistants detected.");
    log("Supported: Claude Code, Codex, OpenClaw, Cursor, Hermes Agent.");
    log("Install one and rerun `hivemind install`, or target a specific assistant: `hivemind cursor install`.");
    return;
  }

  log(`Installing hivemind ${getVersion()} for: ${targets.join(", ")}`);
  log("");

  if (!skipAuth && !isLoggedIn()) {
    const ok = await ensureLoggedIn();
    if (!ok) {
      warn("Skipping install because login did not complete.");
      process.exit(1);
    }
  }

  for (const id of targets) runSingleInstall(id);

  if (withEmbeddings) {
    log("");
    installEmbeddings();
  }

  await maybeShowOrgChoice();

  log("");
  log("Done. Restart each assistant to activate hooks.");
}

function runSingleInstall(id: PlatformId): void {
  try {
    if (id === "claude") installClaude();
    else if (id === "codex") installCodex();
    else if (id === "claw") installOpenclaw();
    else if (id === "cursor") installCursor();
    else if (id === "hermes") installHermes();
    else if (id === "pi") installPi();
  } catch (err) {
    warn(`  ${id.padEnd(14)} FAILED: ${(err as Error).message}`);
  }
}

function runSingleUninstall(id: PlatformId): void {
  try {
    if (id === "claude") uninstallClaude();
    else if (id === "codex") uninstallCodex();
    else if (id === "claw") uninstallOpenclaw();
    else if (id === "cursor") uninstallCursor();
    else if (id === "hermes") uninstallHermes();
    else if (id === "pi") uninstallPi();
  } catch (err) {
    warn(`  ${id.padEnd(14)} FAILED: ${(err as Error).message}`);
  }
}

function runStatus(): void {
  const detected = detectPlatforms();
  log(`hivemind ${getVersion()}`);
  log(`logged in: ${isLoggedIn() ? "yes" : "no"}`);
  log("");
  log("Detected assistants:");
  if (detected.length === 0) log("  (none)");
  for (const p of detected) log(`  ${p.id.padEnd(8)} ${p.markerDir}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    log(USAGE);
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    log(getVersion());
    return;
  }

  if (cmd === "install") { await runInstallAll(args.slice(1)); return; }
  if (cmd === "uninstall") {
    const only = parseOnly(args.slice(1));
    const targets: PlatformId[] = only ?? detectPlatforms().map(p => p.id);
    for (const id of targets) runSingleUninstall(id);
    return;
  }

  if (cmd === "login") { await ensureLoggedIn(); return; }
  if (cmd === "status") { runStatus(); return; }
  if (cmd === "update") {
    const code = await runUpdate({ dryRun: hasFlag(args.slice(1), "--dry-run") });
    process.exit(code);
  }

  if (cmd === "skillify") {
    runSkillifyCommand(args.slice(1));
    return;
  }

  if (cmd === "embeddings") {
    const sub = args[1];
    if (sub === "install") { installEmbeddings(); return; }
    if (sub === "enable") { enableEmbeddings(); return; }
    if (sub === "disable") { disableEmbeddings(); return; }
    if (sub === "uninstall") {
      uninstallEmbeddings({ prune: hasFlag(args.slice(2), "--prune") });
      return;
    }
    if (sub === "status") { statusEmbeddings(); return; }
    warn("Usage: hivemind embeddings install | enable | disable | uninstall [--prune] | status");
    process.exit(1);
  }

  // Account / org / workspace subcommands — passthrough to the auth-login dispatcher.
  if (AUTH_SUBCOMMANDS.has(cmd)) {
    await runAuthCommand(args);
    return;
  }

  const platformCmds: PlatformId[] = ["claude", "codex", "claw", "cursor", "hermes", "pi"];
  if (platformCmds.includes(cmd as PlatformId)) {
    const sub = args[1];
    if (sub === "install") {
      runSingleInstall(cmd as PlatformId);
      if (hasFlag(args.slice(2), "--with-embeddings")) {
        log("");
        installEmbeddings();
      }
    }
    else if (sub === "uninstall") runSingleUninstall(cmd as PlatformId);
    else { warn(`Usage: hivemind ${cmd} install [--with-embeddings] | uninstall`); process.exit(1); }
    return;
  }

  warn(`Unknown command: ${cmd}`);
  log(USAGE);
  process.exit(1);
}

main().catch(err => {
  warn(`hivemind: ${(err as Error).message}`);
  process.exit(1);
});
