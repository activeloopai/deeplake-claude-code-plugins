import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, pkgRoot, ensureDir, copyDir, readJson, writeJson, writeVersionStamp, log } from "./util.js";
import { getVersion } from "./version.js";

const PLUGIN_DIR = join(HOME, ".claude", "plugins", "hivemind");
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");

function buildHookEntry(relPath: string, timeout = 10, asyncFlag = false): Record<string, unknown> {
  const absPath = join(PLUGIN_DIR, "bundle", relPath);
  const hook: Record<string, unknown> = {
    type: "command",
    command: `node "${absPath}"`,
    timeout,
  };
  if (asyncFlag) hook.async = true;
  return hook;
}

function hookBlock(hooks: unknown[]): Record<string, unknown> {
  return { hooks };
}

function buildHookConfig(): Record<string, unknown[]> {
  return {
    SessionStart: [hookBlock([
      buildHookEntry("session-start.js", 10),
      { ...buildHookEntry("session-start-setup.js", 120, true) },
    ])],
    UserPromptSubmit: [hookBlock([buildHookEntry("capture.js", 10, true)])],
    PreToolUse: [hookBlock([buildHookEntry("pre-tool-use.js", 10)])],
    PostToolUse: [hookBlock([buildHookEntry("capture.js", 15, true)])],
    Stop: [hookBlock([buildHookEntry("capture.js", 30, true)])],
    SubagentStop: [hookBlock([buildHookEntry("capture.js", 30, true)])],
    SessionEnd: [hookBlock([buildHookEntry("session-end.js", 60)])],
  };
}

const HIVEMIND_MARKER = "hivemind:managed";

function isHivemindHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const block = entry as { hooks?: unknown[] };
  if (!Array.isArray(block.hooks)) return false;
  return block.hooks.some(h => {
    const cmd = (h as { command?: string })?.command;
    return typeof cmd === "string" && cmd.includes("plugins/hivemind/bundle/");
  });
}

function mergeHooks(settings: Record<string, unknown>): void {
  const existing = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
  const ours = buildHookConfig();

  const merged: Record<string, unknown[]> = { ...existing };
  for (const eventName of Object.keys(ours)) {
    const existingEvent = Array.isArray(merged[eventName]) ? merged[eventName] : [];
    const stripped = existingEvent.filter(e => !isHivemindHook(e));
    merged[eventName] = [...stripped, ...ours[eventName]];
  }
  settings.hooks = merged;
  settings[HIVEMIND_MARKER] = { version: getVersion() };
}

export function installClaude(): void {
  const srcBundle = join(pkgRoot(), "claude-code", "bundle");
  const srcSkills = join(pkgRoot(), "claude-code", "skills");
  const srcCommands = join(pkgRoot(), "claude-code", "commands");

  if (!existsSync(srcBundle)) {
    throw new Error(`Hivemind bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }

  ensureDir(PLUGIN_DIR);
  copyDir(srcBundle, join(PLUGIN_DIR, "bundle"));
  if (existsSync(srcSkills)) copyDir(srcSkills, join(PLUGIN_DIR, "skills"));
  if (existsSync(srcCommands)) copyDir(srcCommands, join(PLUGIN_DIR, "commands"));

  const settings = (readJson<Record<string, unknown>>(SETTINGS_PATH) ?? {}) as Record<string, unknown>;
  mergeHooks(settings);
  writeJson(SETTINGS_PATH, settings);

  writeVersionStamp(PLUGIN_DIR, getVersion());
  log(`  Claude Code    installed -> ${PLUGIN_DIR}`);
}

export function uninstallClaude(): void {
  const settings = readJson<Record<string, unknown>>(SETTINGS_PATH);
  if (!settings) { log("  Claude Code    no settings.json to clean"); return; }
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks) {
    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = (hooks[eventName] ?? []).filter(e => !isHivemindHook(e));
      if (hooks[eventName].length === 0) delete hooks[eventName];
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }
  delete settings[HIVEMIND_MARKER];
  writeJson(SETTINGS_PATH, settings);
  log(`  Claude Code    hooks removed from ${SETTINGS_PATH} (plugin files kept at ${PLUGIN_DIR})`);
}
