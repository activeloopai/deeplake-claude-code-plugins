import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME, pkgRoot, ensureDir, copyDir, writeJson, symlinkForce, writeVersionStamp, log, warn } from "./util.js";
import { getVersion } from "./version.js";

const CODEX_HOME = join(HOME, ".codex");
const PLUGIN_DIR = join(CODEX_HOME, "hivemind");
const HOOKS_PATH = join(CODEX_HOME, "hooks.json");
const AGENTS_SKILLS_DIR = join(HOME, ".agents", "skills");
const SKILL_LINK = join(AGENTS_SKILLS_DIR, "hivemind-memory");

function hookCmd(bundleFile: string, timeout: number, matcher?: string): Record<string, unknown> {
  const block: Record<string, unknown> = {
    hooks: [{
      type: "command",
      command: `node "${join(PLUGIN_DIR, "bundle", bundleFile)}"`,
      timeout,
    }],
  };
  if (matcher) block.matcher = matcher;
  return block;
}

function buildHooksJson(): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [hookCmd("session-start.js", 120)],
      UserPromptSubmit: [hookCmd("capture.js", 10)],
      PreToolUse: [hookCmd("pre-tool-use.js", 15, "Bash")],
      PostToolUse: [hookCmd("capture.js", 15)],
      Stop: [hookCmd("stop.js", 30)],
    },
  };
}

// True when `entry` is one of our hook blocks — i.e. a hook that points
// at a node command living in `<pluginDir>/bundle/`. Used to strip stale
// hivemind entries on re-install (so re-installing doesn't duplicate our
// hooks) WITHOUT touching the user's own hook entries.
//
// Exported with an injectable `pluginDir` so unit tests can drive it
// without depending on the real ~/.codex layout.
export function isHivemindHookEntry(entry: unknown, pluginDir: string = PLUGIN_DIR): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const hooks = Array.isArray(e.hooks) ? (e.hooks as unknown[]) : [];
  return hooks.some(h => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as Record<string, unknown>).command;
    return typeof cmd === "string" && cmd.includes(`${pluginDir}/bundle/`);
  });
}

// Pure merge of two hooks-config shapes. Behavior:
//   - Strip prior hivemind entries (matched via isHivemindHookEntry) from
//     each event the user already had configured, so a re-install doesn't
//     duplicate our hooks.
//   - Drop events whose surviving (non-hivemind) entry list is empty.
//   - Append our entries to each event we declare; preserve any other
//     events the user had configured.
//   - Preserve any non-hooks top-level fields from `existing`.
//
// Pure function — no filesystem reads. The wrapper `mergeHooksJson`
// adds the disk read.
export function mergeHooks(
  existing: Record<string, unknown>,
  ours: Record<string, unknown>,
  pluginDir: string = PLUGIN_DIR,
): Record<string, unknown> {
  const existingHooks = (existing.hooks && typeof existing.hooks === "object")
    ? existing.hooks as Record<string, unknown[]>
    : {};
  const ourHooks = ours.hooks as Record<string, unknown[]>;

  const merged: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    const surviving = (entries ?? []).filter(e => !isHivemindHookEntry(e, pluginDir));
    if (surviving.length) merged[event] = surviving;
  }
  for (const [event, entries] of Object.entries(ourHooks)) {
    merged[event] = [...(merged[event] ?? []), ...(entries ?? [])];
  }
  return { ...existing, hooks: merged };
}

// Filesystem-bound wrapper: reads HOOKS_PATH (if present) and feeds the
// parsed result to the pure mergeHooks. Catches malformed JSON and warns.
function mergeHooksJson(ours: Record<string, unknown>): Record<string, unknown> {
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(HOOKS_PATH)) {
      const parsed = JSON.parse(readFileSync(HOOKS_PATH, "utf-8"));
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    }
  } catch {
    warn(`  Codex          ${HOOKS_PATH} unparseable — ignoring prior content`);
  }
  return mergeHooks(existing, ours);
}

function tryEnableCodexHooks(): void {
  try {
    execFileSync("codex", ["features", "enable", "codex_hooks"], { stdio: "ignore" });
  } catch {
    // codex CLI may not be on PATH (e.g., running under a separate user); not fatal.
  }
}

export function installCodex(): void {
  const srcBundle = join(pkgRoot(), "codex", "bundle");
  const srcSkills = join(pkgRoot(), "codex", "skills");

  if (!existsSync(srcBundle)) {
    throw new Error(`Codex bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }

  ensureDir(PLUGIN_DIR);
  copyDir(srcBundle, join(PLUGIN_DIR, "bundle"));
  if (existsSync(srcSkills)) copyDir(srcSkills, join(PLUGIN_DIR, "skills"));

  tryEnableCodexHooks();
  writeJson(HOOKS_PATH, mergeHooksJson(buildHooksJson()));

  ensureDir(AGENTS_SKILLS_DIR);
  const skillTarget = join(PLUGIN_DIR, "skills", "deeplake-memory");
  if (existsSync(skillTarget)) {
    symlinkForce(skillTarget, SKILL_LINK);
  } else {
    warn(`  Codex          skill source missing at ${skillTarget}; skipping symlink`);
  }

  writeVersionStamp(PLUGIN_DIR, getVersion());
  log(`  Codex          installed -> ${PLUGIN_DIR}`);
}

export function uninstallCodex(): void {
  if (existsSync(HOOKS_PATH)) {
    // Symmetric with install: strip ONLY our hivemind entries via mergeHooks.
    // The pre-fix unconditional unlinkSync(HOOKS_PATH) destroyed any user-
    // defined hooks (e.g. a custom Notification handler) that lived alongside
    // ours. mergeHooks(existing, { hooks: {} }) preserves the user's events
    // and removes only the ones whose command points into PLUGIN_DIR/bundle/.
    let existing: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(readFileSync(HOOKS_PATH, "utf-8"));
      if (raw && typeof raw === "object") existing = raw as Record<string, unknown>;
    } catch {
      // Malformed JSON: fall back to deleting the file rather than guess at
      // intent. Same behavior as pre-fix; user can recreate cleanly.
      unlinkSync(HOOKS_PATH);
      log(`  Codex          removed unparseable ${HOOKS_PATH}`);
      existing = {};
    }
    if (Object.keys(existing).length > 0) {
      const stripped = mergeHooks(existing, { hooks: {} });
      const survivingHooks = (stripped.hooks ?? {}) as Record<string, unknown[]>;
      const otherTopLevelKeys = Object.keys(stripped).filter(k => k !== "hooks");
      if (Object.keys(survivingHooks).length === 0 && otherTopLevelKeys.length === 0) {
        unlinkSync(HOOKS_PATH);
        log(`  Codex          removed ${HOOKS_PATH}`);
      } else {
        writeJson(HOOKS_PATH, stripped);
        log(`  Codex          stripped hivemind hooks from ${HOOKS_PATH}`);
      }
    }
  }
  if (existsSync(SKILL_LINK)) {
    unlinkSync(SKILL_LINK);
    log(`  Codex          removed ${SKILL_LINK}`);
  }
  log(`  Codex          plugin files kept at ${PLUGIN_DIR}`);
}
