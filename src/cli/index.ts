import { installClaude, uninstallClaude } from "./install-claude.js";
import { installCodex, uninstallCodex } from "./install-codex.js";
import { installOpenclaw, uninstallOpenclaw } from "./install-openclaw.js";
import { ensureLoggedIn, isLoggedIn, maybeShowOrgChoice } from "./auth.js";
import { detectPlatforms, allPlatformIds, log, warn } from "./util.js";
import { getVersion } from "./version.js";

type PlatformId = "claude" | "codex" | "claw";

const USAGE = `
hivemind — one brain for every agent on your team

Usage:
  hivemind install [--only <platforms>] [--skip-auth]
      Auto-detect assistants on this machine and install hivemind into each.
      --only takes a comma-separated list: claude,codex,claw

  hivemind claude install | uninstall
  hivemind codex  install | uninstall
  hivemind claw   install | uninstall
      Install or remove hivemind for a specific assistant.

  hivemind login            Run device-flow login (open browser).
  hivemind status           Show which assistants are wired up.
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

  const targets: PlatformId[] = only ?? detectPlatforms().map(p => p.id);

  if (targets.length === 0) {
    log("No supported assistants detected (~/.claude, ~/.codex, ~/.openclaw).");
    log("Install Claude Code, Codex, or OpenClaw first, then rerun `hivemind install`.");
    log("Or target a specific assistant: `hivemind claude install`.");
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

  await maybeShowOrgChoice();

  log("");
  log("Done. Restart each assistant to activate hooks.");
}

function runSingleInstall(id: PlatformId): void {
  try {
    if (id === "claude") installClaude();
    else if (id === "codex") installCodex();
    else if (id === "claw") installOpenclaw();
  } catch (err) {
    warn(`  ${id.padEnd(14)} FAILED: ${(err as Error).message}`);
  }
}

function runSingleUninstall(id: PlatformId): void {
  try {
    if (id === "claude") uninstallClaude();
    else if (id === "codex") uninstallCodex();
    else if (id === "claw") uninstallOpenclaw();
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

  if (cmd === "claude" || cmd === "codex" || cmd === "claw") {
    const sub = args[1];
    if (sub === "install") runSingleInstall(cmd);
    else if (sub === "uninstall") runSingleUninstall(cmd);
    else { warn(`Usage: hivemind ${cmd} install|uninstall`); process.exit(1); }
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
