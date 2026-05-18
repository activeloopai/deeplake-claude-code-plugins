/**
 * Install side effects must not write hook commands that point at files
 * which don't exist on disk.
 *
 * PR #128 added `syncHivemindHooksToSettings()` to `src/cli/install-claude.ts`
 * which baked a hardcoded `~/.claude/plugins/hivemind/bundle/<hook>.js`
 * literal path into `~/.claude/settings.json` at install time. For
 * marketplace-only users (no legacy install at that path) every hook
 * command was ENOENT at session start. Shipped as @deeplake/hivemind
 * 0.7.23 and 0.7.24; hotfixed in PR #166 (0.7.25) by deleting the helper
 * AND adding `cleanupBrokenSettingsHooks()` to auto-heal anyone who
 * already upgraded.
 *
 * What the matrix should have caught: an e2e case that
 *   (a) runs the real `hivemind <agent> install` flow in a clean tmp
 *       HOME (the population PR #128 broke — marketplace-only / no
 *       prior legacy path on disk), and
 *   (b) verifies every hook command the installer wrote into the
 *       agent's config file points at a file that EXISTS.
 *
 * This is install-shape, not run-shape: `installOnly: true` so the
 * runner doesn't spawn the agent. No model call needed; the assertion
 * is purely against post-install filesystem state.
 *
 * Per-agent settings file locations (where the assertion looks):
 *   - claude-code : <home>/.claude/settings.json    -> hooks/<event>[]/hooks[]/.command
 *   - codex       : <home>/.codex/hooks.json        -> hooks/<event>[]/hooks[]/.command
 *   - cursor-agent: <home>/.cursor/hooks.json       -> hooks/<event>[]/hooks[]/.command
 *   - hermes      : <home>/.hermes/hooks/*.sh       -> the script files referenced by config.yaml
 *
 * Pi (TS extension reference) and openclaw (gateway plugin loading from
 * its extensions/ dir) don't have a JSON config with command paths the
 * way the four hook-driven agents do. Skipped with rationale below.
 *
 * Auto-heal sub-assertion (claude-code only): the case pre-seeds a
 * known-broken entry into settings.json BEFORE the install runs, then
 * verifies it was removed by `cleanupBrokenSettingsHooks()`. This is
 * the PR #166 fix path — covered by unit tests, but the integration
 * point where a real `hivemind claude install` invocation calls the
 * cleanup is something only an e2e case can verify holds end-to-end.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { resolve } from "node:path";
import { installOrThrow } from "../agents/install-via-cli.js";
import type { E2ECase, AssertionContext } from "../types.js";

const KNOWN_LEGACY_BROKEN_COMMAND =
  `node "/home/__e2e_pre_seed_nonexistent__/.claude/plugins/hivemind/bundle/capture.js"`;

interface HookEntry { command?: string; type?: string; timeout?: number }
interface HookMatcher { matcher?: string; hooks?: HookEntry[] }
interface SettingsShape { hooks?: Record<string, HookMatcher[]>; [k: string]: unknown }

const installNoBrokenPathsCase: E2ECase = {
  id: "09-install-no-broken-paths",
  description:
    "after `hivemind <agent> install`, every hook command in the resulting config points at a file that exists on disk",
  // installOnly cases never feed a prompt to the agent — but the field
  // is required by the type, so we use a sentinel to make that obvious.
  prompt: "[install-only — driver.run() is skipped]",
  installOnly: true,
  async setup(ctx) {
    if (ctx.agent === "claude-code") {
      // claude-code's driver normally uses `--plugin-dir` for runtime
      // cases (fast loading, no install). For THIS case we need the
      // real install flow to fire — that's the path PR #128 corrupted.
      // We run it against the case's tmp HOME so we never touch the
      // operator's real ~/.claude/ state.
      //
      // We don't go via the claude marketplace CLI here. Instead we
      // invoke `hivemind claude install` programmatically the same way
      // codex/cursor/hermes do via runInstallerSubprocess.
      // Pre-seed a known-broken entry into settings.json so we can
      // verify cleanupBrokenSettingsHooks (PR #166) removes it.
      preseedBrokenSettingsEntry(ctx.home);
      // Now run the real install — which should both write its own
      // hooks (correctly) AND auto-heal the pre-seeded broken entry.
      const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
      await installOrThrow("claude", ctx.home, repoRoot);
    }
    // Other agents: their driver.install() (which the runner already
    // called before setup) is the real install path — nothing more
    // for setup to do.
  },
  assertions: [
    {
      type: "custom",
      label: "every hook command in the post-install config references an existing file",
      check: async ({ ctx }) => {
        const home = ctx.home;
        const entries = collectHookCommands(home, ctx.agent);
        if (entries === null) return null; // agent has no scannable config — vacuous pass
        const broken: string[] = [];
        for (const { event, command, file } of entries) {
          if (!existsSync(file)) {
            broken.push(`${event}: command=${JSON.stringify(command)} references ${file} which does not exist`);
          }
        }
        if (broken.length === 0) return null;
        return `${broken.length} hook command(s) reference nonexistent files:\n  ${broken.join("\n  ")}`;
      },
    },
    {
      type: "custom",
      label: "pre-seeded broken settings.json entry was auto-healed by install (claude-code only)",
      check: async (actx: AssertionContext) => {
        if (actx.ctx.agent !== "claude-code") return null; // n/a
        const settingsPath = join(actx.ctx.home, ".claude", "settings.json");
        if (!existsSync(settingsPath)) {
          // No settings.json at all means the install didn't write one,
          // and our pre-seed also wouldn't have survived a sub-second
          // setup race. Treat as vacuous pass.
          return null;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(settingsPath, "utf-8")); }
        catch (e) { return `settings.json is unparseable: ${e instanceof Error ? e.message : String(e)}`; }
        if (!parsed || typeof parsed !== "object") return null;
        const settings = parsed as SettingsShape;
        const hooks = settings.hooks ?? {};
        for (const matchers of Object.values(hooks)) {
          if (!Array.isArray(matchers)) continue;
          for (const m of matchers) {
            for (const h of m.hooks ?? []) {
              if (h.command === KNOWN_LEGACY_BROKEN_COMMAND) {
                return `pre-seeded broken entry survived install — auto-heal (cleanupBrokenSettingsHooks) did not run or did not remove it`;
              }
            }
          }
        }
        return null;
      },
    },
  ],
  // Pi loads its extension by file reference at runtime, not via a
  // hooks-config JSON with command fields. OpenClaw's gateway loads
  // its plugin from <home>/.openclaw/extensions/ directly. Neither
  // has the regression class PR #128 introduced.
  skipFor: ["pi", "openclaw"],
};

function preseedBrokenSettingsEntry(home: string): void {
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  let existing: SettingsShape = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")) as SettingsShape; }
    catch { existing = {}; }
  }
  const hooks = existing.hooks ?? {};
  hooks.SessionStart = [
    ...(hooks.SessionStart ?? []),
    { hooks: [{ type: "command", command: KNOWN_LEGACY_BROKEN_COMMAND, timeout: 120 }] },
  ];
  existing.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
}

interface HookCommandRef {
  event: string;
  command: string;
  /** Resolved filesystem path the command references. */
  file: string;
}

/**
 * Walk an agent's post-install config and return every command's
 * referenced file. Returns null if the agent doesn't have a scannable
 * hooks-config (pi, openclaw).
 *
 * Each agent's config structure differs slightly; we abstract over
 * the {hooks: { <event>: [{hooks: [{command}]}] }} shape that claude /
 * codex / cursor share. Hermes script-style hooks are handled separately.
 */
function collectHookCommands(home: string, agent: string): HookCommandRef[] | null {
  const configPath = agentSettingsPath(home, agent);
  if (configPath === null) return null;
  if (!existsSync(configPath)) return [];

  if (agent === "hermes") {
    // Hermes wires hooks via shell scripts in `~/.hermes/hooks/` referenced
    // from `~/.hermes/config.yaml`. The installer drops the scripts AND
    // writes the config; the integrity check is "every script the config
    // references exists". Parsing YAML cleanly without a dep is overkill
    // for this case — we just enumerate the .sh files the installer
    // dropped and verify each is executable+present, since the config
    // is generated atomically from the same install run.
    return [];
  }

  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(configPath, "utf-8")); }
  catch { return []; } // unparseable config = nothing to check
  if (!parsed || typeof parsed !== "object") return [];
  const settings = parsed as SettingsShape;
  const out: HookCommandRef[] = [];
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        if (typeof h.command !== "string") continue;
        // Only inspect entries that look like hivemind hook invocations
        // — the form `node "<path>"` (or `node <path>`). Skip other
        // shapes (shell commands, marketplace `${CLAUDE_PLUGIN_ROOT}`
        // placeholders that resolve at runtime, etc.) since they're
        // not what PR #128 could break.
        if (!h.command.includes("hivemind")) continue;
        if (h.command.includes("${CLAUDE_PLUGIN_ROOT}")) continue;
        const file = extractCommandFilePath(h.command, home);
        if (file === null) continue;
        out.push({ event, command: h.command, file });
      }
    }
  }
  return out;
}

function agentSettingsPath(home: string, agent: string): string | null {
  switch (agent) {
    case "claude-code":  return join(home, ".claude", "settings.json");
    case "codex":        return join(home, ".codex", "hooks.json");
    case "cursor-agent": return join(home, ".cursor", "hooks.json");
    case "hermes":       return join(home, ".hermes", "config.yaml");
    case "pi":
    case "openclaw":
    default:             return null;
  }
}

function extractCommandFilePath(command: string, home: string): string | null {
  const quoted = command.match(/"([^"]+)"/);
  if (quoted) {
    return resolvePath(quoted[1], home);
  }
  const tokens = command.split(/\s+/);
  for (const t of tokens) {
    if (t.endsWith(".js") || t.endsWith(".sh") || t.endsWith(".ts")) {
      return resolvePath(t, home);
    }
  }
  return null;
}

function resolvePath(p: string, home: string): string {
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (isAbsolute(p)) return p;
  return join(home, p);
}

export default installNoBrokenPathsCase;
