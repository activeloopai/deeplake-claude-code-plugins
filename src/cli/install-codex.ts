import { existsSync, unlinkSync } from "node:fs";
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
  writeJson(HOOKS_PATH, buildHooksJson());

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
