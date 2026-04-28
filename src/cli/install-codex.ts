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
// at a node command living in PLUGIN_DIR/bundle/. We use this to strip
// stale hivemind entries on re-install (so re-installing doesn't duplicate
// our hooks) WITHOUT touching the user's own hook entries.
function isHivemindHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const hooks = Array.isArray(e.hooks) ? (e.hooks as unknown[]) : [];
  return hooks.some(h => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as Record<string, unknown>).command;
    return typeof cmd === "string" && cmd.includes(`${PLUGIN_DIR}/bundle/`);
  });
}

// Merge our hooks into the existing hooks.json instead of overwriting it.
// Without this, any user-defined hooks (custom PostToolUse, etc.) get
// silently wiped on `hivemind codex install`. Behavior:
//  - Strip any prior hivemind entries (matched by PLUGIN_DIR path) from
//    each hook event so re-install doesn't duplicate our entries.
//  - Append our entries to the user's surviving entries.
//  - Preserve any non-hivemind hook events the user had configured.
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
  const existingHooks = (existing.hooks && typeof existing.hooks === "object")
    ? existing.hooks as Record<string, unknown[]>
    : {};
  const ourHooks = ours.hooks as Record<string, unknown[]>;

  const merged: Record<string, unknown[]> = {};
  // Start from every event the user has, with hivemind entries stripped.
  for (const [event, entries] of Object.entries(existingHooks)) {
    const surviving = (entries ?? []).filter(e => !isHivemindHookEntry(e));
    if (surviving.length) merged[event] = surviving;
  }
  // Append our entries to each event we declare.
  for (const [event, entries] of Object.entries(ourHooks)) {
    merged[event] = [...(merged[event] ?? []), ...(entries ?? [])];
  }
  return { ...existing, hooks: merged };
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
    unlinkSync(HOOKS_PATH);
    log(`  Codex          removed ${HOOKS_PATH}`);
  }
  if (existsSync(SKILL_LINK)) {
    unlinkSync(SKILL_LINK);
    log(`  Codex          removed ${SKILL_LINK}`);
  }
  log(`  Codex          plugin files kept at ${PLUGIN_DIR}`);
}
