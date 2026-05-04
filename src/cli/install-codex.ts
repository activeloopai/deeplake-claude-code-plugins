import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME, pkgRoot, ensureDir, copyDir, writeJson, symlinkForce, writeVersionStamp, log, warn } from "./util.js";
import { getVersion } from "./version.js";

const CODEX_HOME = join(HOME, ".codex");
const PLUGIN_DIR = join(CODEX_HOME, "hivemind");
const HOOKS_PATH = join(CODEX_HOME, "hooks.json");
const AGENTS_SKILLS_DIR = join(HOME, ".agents", "skills");
const SKILL_LINKS = [
  { source: "deeplake-memory", link: "hivemind-memory" },
  { source: "gdd-workflow", link: "gdd-workflow" },
];

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

// Hivemind's codex bundle entry-points. A `command` whose path ends in
// `bundle/<one of these>.js` is almost certainly hivemind regardless of
// where on disk it lives — no other plugin we know of ships this exact
// filename set under a `bundle/` directory.
const HIVEMIND_BUNDLE_FILES = [
  "session-start.js",
  "session-start-setup.js",
  "capture.js",
  "pre-tool-use.js",
  "stop.js",
  "wiki-worker.js",
] as const;

// True when `entry` is one of our hook blocks. Two ways to recognise it:
//   1. It points into the canonical install dir `<pluginDir>/bundle/`.
//   2. It points at a path matching `bundle/<known-hivemind-file>.js`,
//      regardless of the parent directory. This catches dual-install
//      scenarios — e.g. a user kept a local dev clone of hivemind wired in
//      under a different path (`/path/to/my-clone/codex/bundle/...`) and
//      then ran `hivemind install`, which previously left the dev clone's
//      hooks alongside ours and they raced on every codex session.
//
// Used to strip stale hivemind entries on re-install (so re-installing
// doesn't duplicate our hooks) WITHOUT touching the user's own hook
// entries that happen to share an event.
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
    if (typeof cmd !== "string") return false;
    if (cmd.includes(`${pluginDir}/bundle/`)) return true;
    return HIVEMIND_BUNDLE_FILES.some(f => cmd.includes(`/bundle/${f}`));
  });
}

// Like isHivemindHookEntry, but only matches entries that point OUTSIDE
// the canonical install dir. Used to surface a warning when re-install
// strips a sibling hivemind clone — those are usually accidental dev-loop
// leftovers, but a user who genuinely wants two installs side-by-side
// needs to see what got removed.
function isForeignHivemindHookEntry(entry: unknown, pluginDir: string = PLUGIN_DIR): boolean {
  if (!isHivemindHookEntry(entry, pluginDir)) return false;
  const e = entry as Record<string, unknown>;
  const hooks = Array.isArray(e.hooks) ? (e.hooks as unknown[]) : [];
  return hooks.every(h => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as Record<string, unknown>).command;
    if (typeof cmd !== "string") return false;
    return !cmd.includes(`${pluginDir}/bundle/`);
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
// Also surfaces a warning listing any foreign-path hivemind entries
// stripped (e.g. a dev clone wired in under a different directory).
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
  reportForeignHivemindHooks(existing);
  return mergeHooks(existing, ours);
}

function reportForeignHivemindHooks(existing: Record<string, unknown>): void {
  const existingHooks = (existing.hooks && typeof existing.hooks === "object")
    ? existing.hooks as Record<string, unknown[]>
    : {};
  const foreign = new Set<string>();
  for (const entries of Object.values(existingHooks)) {
    for (const e of entries ?? []) {
      if (!isForeignHivemindHookEntry(e)) continue;
      const hooks = Array.isArray((e as Record<string, unknown>).hooks)
        ? ((e as Record<string, unknown>).hooks as unknown[])
        : [];
      for (const h of hooks) {
        const cmd = (h as Record<string, unknown> | null)?.command;
        if (typeof cmd === "string") foreign.add(cmd);
      }
    }
  }
  if (foreign.size === 0) return;
  warn(`  Codex          stripping ${foreign.size} hivemind hook(s) from a non-canonical path:`);
  for (const cmd of foreign) warn(`                   ${cmd}`);
  warn(`                 (these were probably leftover from a local dev clone — re-add them manually if intentional)`);
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
  for (const skill of SKILL_LINKS) {
    const skillTarget = join(PLUGIN_DIR, "skills", skill.source);
    if (existsSync(skillTarget)) {
      symlinkForce(skillTarget, join(AGENTS_SKILLS_DIR, skill.link));
    } else {
      warn(`  Codex          skill source missing at ${skillTarget}; skipping symlink`);
    }
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
  for (const skill of SKILL_LINKS) {
    const skillLink = join(AGENTS_SKILLS_DIR, skill.link);
    if (existsSync(skillLink)) {
      unlinkSync(skillLink);
      log(`  Codex          removed ${skillLink}`);
    }
  }
  log(`  Codex          plugin files kept at ${PLUGIN_DIR}`);
}
