import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./util.js";

// Claude Code's plugin loader is a managed surface: it owns the cache layout,
// the plugin registry, hook wiring, command discovery, and version updates.
// Rather than reimplement that, this installer delegates to the `claude`
// CLI and lets Claude Code drive the install through its supported flow:
//   claude plugin marketplace add activeloopai/hivemind
//   claude plugin install hivemind
//   claude plugin enable hivemind@hivemind
//
// Side effect: requires `claude` on PATH at install time and network access
// to fetch the marketplace from GitHub. Both are reasonable assumptions for
// anyone running `npx @deeplake/hivemind claude install` — they already
// have Claude Code installed and the marketplace flow is the canonical way
// to ship plugins to Claude Code users.

const MARKETPLACE_NAME = "hivemind";
const MARKETPLACE_SOURCE = "activeloopai/hivemind";
const PLUGIN_KEY = "hivemind@hivemind";

interface ClaudeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runClaude(args: string[]): ClaudeResult {
  try {
    const stdout = execFileSync("claude", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message ?? "",
    };
  }
}

function requireClaudeCli(): void {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "Claude Code CLI ('claude') not found on PATH. " +
      "Install Claude Code first: https://claude.com/claude-code",
    );
  }
}

function marketplaceAlreadyAdded(): boolean {
  const r = runClaude(["plugin", "marketplace", "list"]);
  if (!r.ok) return false;
  return new RegExp(`(^|\\s)${MARKETPLACE_NAME}(\\s|$)`, "m").test(r.stdout);
}

function pluginAlreadyInstalled(): boolean {
  const r = runClaude(["plugin", "list"]);
  if (!r.ok) return false;
  return r.stdout.includes(PLUGIN_KEY);
}

// Claude Code's plugin model is multi-scope: a plugin can be enabled at
// any of `user` / `project` / `local` / `managed` scope, and each scope
// has its own activation. `claude plugin update` is per-scope, so an
// upgrade has to fan out across all four; the scopes the user hasn't
// activated will simply error out, which is fine.
const PLUGIN_SCOPES = ["user", "project", "local", "managed"] as const;

/**
 * Sync hivemind's canonical hook list (`hooks.json` in the marketplace
 * plugin) into the user's `~/.claude/settings.json`.
 *
 * Why this exists: Claude Code reads SessionStart/PostToolUse/etc. hooks
 * from settings.json at session start. The plugin install/update flow
 * (`claude plugin install`, `claude plugin update`) writes settings.json
 * the FIRST time a plugin is installed but does not re-merge new hook
 * declarations from the plugin's own hooks.json on subsequent updates.
 *
 * Concretely: a user who installed hivemind at v0.6.x (when hooks.json
 * had only `session-start.js` + `session-start-setup.js` for
 * SessionStart) and later ran `claude plugin update` to bump to v0.7.x
 * (which added `session-notifications.js`) ends up with settings.json
 * still listing only the 2 original hooks. The new hook never fires.
 *
 * This sync makes `hivemind update` idempotent w.r.t. settings.json:
 * for every event in the plugin's canonical hooks.json, replace the
 * hivemind-owned matcher block with the current canonical list. Other
 * user-customized matchers in the same events are preserved.
 *
 * Identifies "hivemind-owned" matchers by checking whether any command
 * in the matcher references `plugins/hivemind/bundle/` (the canonical
 * install path, after `${CLAUDE_PLUGIN_ROOT}` resolution).
 */

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

interface HooksJsonShape {
  hooks?: Record<string, HookMatcher[]>;
}

interface SettingsShape {
  hooks?: Record<string, HookMatcher[]>;
  [k: string]: unknown;
}

function resolvePluginRoot(): string {
  return join(homedir(), ".claude", "plugins", "hivemind");
}

function marketplaceHooksJsonPath(): string {
  return join(homedir(), ".claude", "plugins", "marketplaces", "hivemind", "claude-code", "hooks", "hooks.json");
}

function settingsJsonPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function resolveCommand(command: string, pluginRoot: string): string {
  return command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
}

function isHivemindMatcher(matcher: HookMatcher): boolean {
  return matcher.hooks?.some(h => typeof h.command === "string" && h.command.includes("plugins/hivemind/bundle/")) ?? false;
}

export function syncHivemindHooksToSettings(): { changed: boolean; events: string[] } {
  const hooksPath = marketplaceHooksJsonPath();
  const settingsPath = settingsJsonPath();
  if (!existsSync(hooksPath)) return { changed: false, events: [] };

  let canonical: HooksJsonShape;
  try {
    canonical = JSON.parse(readFileSync(hooksPath, "utf-8")) as HooksJsonShape;
  } catch {
    return { changed: false, events: [] };
  }
  if (!canonical.hooks) return { changed: false, events: [] };

  let settings: SettingsShape = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as SettingsShape;
    } catch {
      // Corrupt settings.json — better to abort than overwrite.
      return { changed: false, events: [] };
    }
  }
  settings.hooks = settings.hooks ?? {};

  const pluginRoot = resolvePluginRoot();
  const changedEvents: string[] = [];
  let changed = false;

  for (const [event, matchers] of Object.entries(canonical.hooks)) {
    // Resolve ${CLAUDE_PLUGIN_ROOT} in every command of the canonical list.
    const resolvedMatchers: HookMatcher[] = matchers.map(m => ({
      ...(m.matcher !== undefined ? { matcher: m.matcher } : {}),
      hooks: m.hooks.map(h => ({
        ...(h.type !== undefined ? { type: h.type } : {}),
        ...(h.command !== undefined ? { command: resolveCommand(h.command, pluginRoot) } : {}),
        ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
        ...(h.async !== undefined ? { async: h.async } : {}),
      })),
    }));

    const existing = settings.hooks[event] ?? [];
    // Drop matchers that are hivemind-owned (so we can replace them with
    // the canonical list). Preserve everything else verbatim.
    const preserved = existing.filter(m => !isHivemindMatcher(m));
    const next = [...preserved, ...resolvedMatchers];

    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      settings.hooks[event] = next;
      changedEvents.push(event);
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
  return { changed, events: changedEvents };
}

export function installClaude(): void {
  requireClaudeCli();

  if (!marketplaceAlreadyAdded()) {
    const add = runClaude(["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
    if (!add.ok) {
      throw new Error(
        `Failed to add marketplace '${MARKETPLACE_SOURCE}': ${add.stderr.slice(0, 200)}`,
      );
    }
  }

  if (!pluginAlreadyInstalled()) {
    // First-time install path: just install. The marketplace fetch is
    // implicit in `claude plugin install`.
    const inst = runClaude(["plugin", "install", "hivemind"]);
    if (!inst.ok) {
      throw new Error(
        `Failed to install hivemind plugin: ${inst.stderr.slice(0, 200)}`,
      );
    }
    log(`  Claude Code    installed via marketplace ${MARKETPLACE_SOURCE}`);
  } else {
    // Already-installed path: refresh the marketplace cache so
    // `plugin update` sees the newest version, then update across every
    // scope. Without the explicit `marketplace update` first, ClawHub
    // would serve a stale catalog and `plugin update` would no-op even
    // when a newer version is published. Mirrors the legacy
    // session-start logic in src/hooks/session-start.ts but routes it
    // through the centralized `hivemind update` command — this is what
    // makes `hivemind update` actually upgrade Claude (the install-only
    // path was idempotent and silently skipped the upgrade).
    runClaude(["plugin", "marketplace", "update", MARKETPLACE_NAME]);
    for (const scope of PLUGIN_SCOPES) {
      runClaude(["plugin", "update", PLUGIN_KEY, "--scope", scope]);
    }
    log(`  Claude Code    refreshed via marketplace ${MARKETPLACE_SOURCE}`);
  }

  // enable is idempotent in claude CLI — safe to run unconditionally
  runClaude(["plugin", "enable", PLUGIN_KEY]);

  // Sync the plugin's canonical hooks.json into the user's settings.json.
  // `claude plugin install` writes settings.json the first time, but
  // `claude plugin update` does NOT re-sync hooks on version bumps, so
  // users who installed before a hook was added end up never firing it.
  // This makes the install/update path idempotent w.r.t. hook registration.
  try {
    const sync = syncHivemindHooksToSettings();
    if (sync.changed) {
      log(`  Claude Code    settings.json hooks synced (${sync.events.join(", ")})`);
    }
  } catch (e: any) {
    log(`  Claude Code    settings.json sync skipped: ${e?.message ?? String(e)}`);
  }
}

export function uninstallClaude(): void {
  try {
    requireClaudeCli();
  } catch {
    log("  Claude Code    skip uninstall — claude CLI not on PATH");
    return;
  }
  runClaude(["plugin", "disable", PLUGIN_KEY]);
  runClaude(["plugin", "uninstall", PLUGIN_KEY]);
  log("  Claude Code    plugin uninstalled");
}
