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

// ── Cleanup pass for a 0.7.23/0.7.24 regression ──────────────────────────────
//
// PR #128 shipped a `syncHivemindHooksToSettings()` helper that wrote
// hardcoded literal paths (`~/.claude/plugins/hivemind/bundle/...`) into
// `~/.claude/settings.json` at install/update time, replacing the
// `${CLAUDE_PLUGIN_ROOT}` placeholder Claude Code resolves at runtime.
// For users without a legacy install at that exact path, the resulting
// entries pointed at non-existent files → every hivemind hook crashed
// at session start.
//
// The helper has been removed (the marketplace plugin's hooks.json
// auto-registers hooks via Claude Code's plugin loader — the helper
// was redundant for marketplace users and actively harmful when the
// hardcoded path didn't exist).
//
// This cleanup function removes those broken entries from settings.json
// on every `hivemind update` so anyone who ran 0.7.23 or 0.7.24 gets
// auto-healed. Narrowly scoped: only removes entries whose command
// points at the literal legacy path AND that path doesn't exist on
// disk. Entries on functioning legacy installs are preserved.

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

interface SettingsShape {
  hooks?: Record<string, HookMatcher[]>;
  [k: string]: unknown;
}

function settingsJsonPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

const LEGACY_PATH_FRAGMENT = ".claude/plugins/hivemind/bundle/";

/**
 * Return true if this hook entry was written by the buggy
 * `syncHivemindHooksToSettings()` helper AND the file it points at
 * doesn't exist. Both conditions must hold:
 *   - command references the literal legacy path fragment
 *   - the referenced file is missing from disk
 *
 * Why both? Legitimate legacy installs ALSO have entries pointing at
 * that path, but the file exists for them. We only want to clean up
 * entries that are actively broken.
 */
function isBrokenHivemindHookEntry(h: HookEntry): boolean {
  if (typeof h.command !== "string") return false;
  // Normalize backslashes for Windows compatibility (same reason the
  // original helper had this — the bug shipped Windows-style paths too).
  const normalized = h.command.replace(/\\/g, "/");
  if (!normalized.includes(LEGACY_PATH_FRAGMENT)) return false;
  // Extract the path between the first `"` after `node` and the closing `"`.
  // Falls back to checking word-tokens if no quoted path is found.
  const match = normalized.match(/"([^"]+\.claude\/plugins\/hivemind\/bundle\/[^"]+)"/);
  const filePath = match ? match[1] : null;
  if (!filePath) return false;
  return !existsSync(filePath);
}

/**
 * Walk settings.json, remove every hivemind hook entry that points at a
 * non-existent legacy path. Entries that ARE legacy-but-functional stay.
 * Entries written by Claude Code's marketplace plugin loader (which uses
 * `${CLAUDE_PLUGIN_ROOT}/...` and resolves at runtime) are unaffected
 * since they don't contain the literal legacy path fragment.
 *
 * Returns the count of entries removed; useful for the install log.
 *
 * Fail-safe: corrupt settings.json or unreadable file → return 0, no-op.
 * NEVER deletes the entire matcher block; if a matcher's last hook gets
 * removed, the matcher block is also dropped (no empty matchers).
 */
export function cleanupBrokenSettingsHooks(): { removed: number; events: string[] } {
  const settingsPath = settingsJsonPath();
  if (!existsSync(settingsPath)) return { removed: 0, events: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return { removed: 0, events: [] };
  }
  // `JSON.parse` succeeds (returns null) for literal "null" — dereferencing
  // `.hooks` would throw. Caught by CodeRabbit on PR #166.
  if (!parsed || typeof parsed !== "object") return { removed: 0, events: [] };
  const settings = parsed as SettingsShape;
  if (!settings.hooks || typeof settings.hooks !== "object") return { removed: 0, events: [] };

  let removed = 0;
  const touchedEvents: string[] = [];

  for (const [event, matchers] of Object.entries(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    const cleanedMatchers: HookMatcher[] = [];
    let eventTouched = false;
    for (const m of matchers) {
      if (!m || !Array.isArray(m.hooks)) {
        cleanedMatchers.push(m);
        continue;
      }
      const keptHooks = m.hooks.filter(h => {
        const broken = isBrokenHivemindHookEntry(h);
        if (broken) {
          removed += 1;
          eventTouched = true;
        }
        return !broken;
      });
      // Drop the entire matcher block if all its hooks were removed.
      if (keptHooks.length > 0) {
        cleanedMatchers.push({ ...m, hooks: keptHooks });
      } else if (m.hooks.length > 0) {
        // Block was entirely hivemind-broken — dropping it. Counted via removed above.
        eventTouched = true;
      } else {
        // Empty hooks array already; preserve verbatim.
        cleanedMatchers.push(m);
      }
    }
    if (eventTouched) {
      settings.hooks[event] = cleanedMatchers;
      touchedEvents.push(event);
    }
  }

  if (removed > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
  return { removed, events: touchedEvents };
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

  // Auto-heal settings.json on every install/update for users hit by the
  // 0.7.23/0.7.24 sync-helper regression. See `cleanupBrokenSettingsHooks`
  // for the failure mode this addresses. No-op on clean installs.
  try {
    const cleanup = cleanupBrokenSettingsHooks();
    if (cleanup.removed > 0) {
      log(`  Claude Code    settings.json cleaned: removed ${cleanup.removed} stale hook entr${cleanup.removed === 1 ? "y" : "ies"} (events: ${cleanup.events.join(", ")})`);
    }
  } catch (e: any) {
    log(`  Claude Code    settings.json cleanup skipped: ${e?.message ?? String(e)}`);
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
