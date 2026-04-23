#!/usr/bin/env node

// dist/src/cli/install-claude.js
import { existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";

// dist/src/cli/util.js
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
var HOME = homedir();
function pkgRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}
function ensureDir(path, mode = 493) {
  if (!existsSync(path))
    mkdirSync(path, { recursive: true, mode });
}
function copyDir(src, dst) {
  cpSync(src, dst, { recursive: true, force: true, dereference: false });
}
function symlinkForce(target, link) {
  ensureDir(dirname(link));
  if (existsSync(link) || isLink(link))
    unlinkSync(link);
  symlinkSync(target, link);
}
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function readJson(path) {
  if (!existsSync(path))
    return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
function writeJson(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}
function writeVersionStamp(dir, version) {
  ensureDir(dir);
  writeFileSync(join(dir, ".hivemind_version"), version);
}
var PLATFORM_MARKERS = [
  { id: "claude", markerDir: join(HOME, ".claude") },
  { id: "codex", markerDir: join(HOME, ".codex") },
  { id: "claw", markerDir: join(HOME, ".openclaw") }
];
function detectPlatforms() {
  return PLATFORM_MARKERS.filter((p) => existsSync(p.markerDir));
}
function allPlatformIds() {
  return PLATFORM_MARKERS.map((p) => p.id);
}
function log(msg) {
  process.stdout.write(msg + "\n");
}
function warn(msg) {
  process.stderr.write(msg + "\n");
}

// dist/src/cli/version.js
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync2(join2(pkgRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// dist/src/cli/install-claude.js
var PLUGIN_DIR = join3(HOME, ".claude", "plugins", "hivemind");
var SETTINGS_PATH = join3(HOME, ".claude", "settings.json");
function buildHookEntry(relPath, timeout = 10, asyncFlag = false) {
  const absPath = join3(PLUGIN_DIR, "bundle", relPath);
  const hook = {
    type: "command",
    command: `node "${absPath}"`,
    timeout
  };
  if (asyncFlag)
    hook.async = true;
  return hook;
}
function hookBlock(hooks) {
  return { hooks };
}
function buildHookConfig() {
  return {
    SessionStart: [hookBlock([
      buildHookEntry("session-start.js", 10),
      { ...buildHookEntry("session-start-setup.js", 120, true) }
    ])],
    UserPromptSubmit: [hookBlock([buildHookEntry("capture.js", 10, true)])],
    PreToolUse: [hookBlock([buildHookEntry("pre-tool-use.js", 10)])],
    PostToolUse: [hookBlock([buildHookEntry("capture.js", 15, true)])],
    Stop: [hookBlock([buildHookEntry("capture.js", 30, true)])],
    SubagentStop: [hookBlock([buildHookEntry("capture.js", 30, true)])],
    SessionEnd: [hookBlock([buildHookEntry("session-end.js", 60)])]
  };
}
var HIVEMIND_MARKER = "hivemind:managed";
function isHivemindHook(entry) {
  if (!entry || typeof entry !== "object")
    return false;
  const block = entry;
  if (!Array.isArray(block.hooks))
    return false;
  return block.hooks.some((h) => {
    const cmd = h?.command;
    return typeof cmd === "string" && cmd.includes("plugins/hivemind/bundle/");
  });
}
function mergeHooks(settings) {
  const existing = settings.hooks ?? {};
  const ours = buildHookConfig();
  const merged = { ...existing };
  for (const eventName of Object.keys(ours)) {
    const existingEvent = Array.isArray(merged[eventName]) ? merged[eventName] : [];
    const stripped = existingEvent.filter((e) => !isHivemindHook(e));
    merged[eventName] = [...stripped, ...ours[eventName]];
  }
  settings.hooks = merged;
  settings[HIVEMIND_MARKER] = { version: getVersion() };
}
function installClaude() {
  const srcBundle = join3(pkgRoot(), "claude-code", "bundle");
  const srcSkills = join3(pkgRoot(), "claude-code", "skills");
  const srcCommands = join3(pkgRoot(), "claude-code", "commands");
  if (!existsSync2(srcBundle)) {
    throw new Error(`Hivemind bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }
  ensureDir(PLUGIN_DIR);
  copyDir(srcBundle, join3(PLUGIN_DIR, "bundle"));
  if (existsSync2(srcSkills))
    copyDir(srcSkills, join3(PLUGIN_DIR, "skills"));
  if (existsSync2(srcCommands))
    copyDir(srcCommands, join3(PLUGIN_DIR, "commands"));
  const settings = readJson(SETTINGS_PATH) ?? {};
  mergeHooks(settings);
  writeJson(SETTINGS_PATH, settings);
  writeVersionStamp(PLUGIN_DIR, getVersion());
  log(`  Claude Code    installed -> ${PLUGIN_DIR}`);
}
function uninstallClaude() {
  const settings = readJson(SETTINGS_PATH);
  if (!settings) {
    log("  Claude Code    no settings.json to clean");
    return;
  }
  const hooks = settings.hooks;
  if (hooks) {
    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = (hooks[eventName] ?? []).filter((e) => !isHivemindHook(e));
      if (hooks[eventName].length === 0)
        delete hooks[eventName];
    }
    if (Object.keys(hooks).length === 0)
      delete settings.hooks;
  }
  delete settings[HIVEMIND_MARKER];
  writeJson(SETTINGS_PATH, settings);
  log(`  Claude Code    hooks removed from ${SETTINGS_PATH} (plugin files kept at ${PLUGIN_DIR})`);
}

// dist/src/cli/install-codex.js
import { existsSync as existsSync3, unlinkSync as unlinkSync2 } from "node:fs";
import { execFileSync } from "node:child_process";
import { join as join4 } from "node:path";
var CODEX_HOME = join4(HOME, ".codex");
var PLUGIN_DIR2 = join4(CODEX_HOME, "hivemind");
var HOOKS_PATH = join4(CODEX_HOME, "hooks.json");
var AGENTS_SKILLS_DIR = join4(HOME, ".agents", "skills");
var SKILL_LINK = join4(AGENTS_SKILLS_DIR, "hivemind-memory");
function hookCmd(bundleFile, timeout, matcher) {
  const block = {
    hooks: [{
      type: "command",
      command: `node "${join4(PLUGIN_DIR2, "bundle", bundleFile)}"`,
      timeout
    }]
  };
  if (matcher)
    block.matcher = matcher;
  return block;
}
function buildHooksJson() {
  return {
    hooks: {
      SessionStart: [hookCmd("session-start.js", 120)],
      UserPromptSubmit: [hookCmd("capture.js", 10)],
      PreToolUse: [hookCmd("pre-tool-use.js", 15, "Bash")],
      PostToolUse: [hookCmd("capture.js", 15)],
      Stop: [hookCmd("stop.js", 30)]
    }
  };
}
function tryEnableCodexHooks() {
  try {
    execFileSync("codex", ["features", "enable", "codex_hooks"], { stdio: "ignore" });
  } catch {
  }
}
function installCodex() {
  const srcBundle = join4(pkgRoot(), "codex", "bundle");
  const srcSkills = join4(pkgRoot(), "codex", "skills");
  if (!existsSync3(srcBundle)) {
    throw new Error(`Codex bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }
  ensureDir(PLUGIN_DIR2);
  copyDir(srcBundle, join4(PLUGIN_DIR2, "bundle"));
  if (existsSync3(srcSkills))
    copyDir(srcSkills, join4(PLUGIN_DIR2, "skills"));
  tryEnableCodexHooks();
  writeJson(HOOKS_PATH, buildHooksJson());
  ensureDir(AGENTS_SKILLS_DIR);
  const skillTarget = join4(PLUGIN_DIR2, "skills", "deeplake-memory");
  if (existsSync3(skillTarget)) {
    symlinkForce(skillTarget, SKILL_LINK);
  } else {
    warn(`  Codex          skill source missing at ${skillTarget}; skipping symlink`);
  }
  writeVersionStamp(PLUGIN_DIR2, getVersion());
  log(`  Codex          installed -> ${PLUGIN_DIR2}`);
}
function uninstallCodex() {
  if (existsSync3(HOOKS_PATH)) {
    unlinkSync2(HOOKS_PATH);
    log(`  Codex          removed ${HOOKS_PATH}`);
  }
  if (existsSync3(SKILL_LINK)) {
    unlinkSync2(SKILL_LINK);
    log(`  Codex          removed ${SKILL_LINK}`);
  }
  log(`  Codex          plugin files kept at ${PLUGIN_DIR2}`);
}

// dist/src/cli/install-openclaw.js
import { existsSync as existsSync4, rmSync } from "node:fs";
import { join as join5 } from "node:path";
var PLUGIN_DIR3 = join5(HOME, ".openclaw", "plugins", "hivemind");
function installOpenclaw() {
  const srcDist = join5(pkgRoot(), "openclaw", "dist");
  const srcManifest = join5(pkgRoot(), "openclaw", "openclaw.plugin.json");
  const srcPkg = join5(pkgRoot(), "openclaw", "package.json");
  const srcSkills = join5(pkgRoot(), "openclaw", "skills");
  if (!existsSync4(srcDist)) {
    throw new Error(`OpenClaw bundle missing at ${srcDist}. Run 'npm run build' first.`);
  }
  ensureDir(PLUGIN_DIR3);
  copyDir(srcDist, join5(PLUGIN_DIR3, "dist"));
  if (existsSync4(srcManifest))
    copyDir(srcManifest, join5(PLUGIN_DIR3, "openclaw.plugin.json"));
  if (existsSync4(srcPkg))
    copyDir(srcPkg, join5(PLUGIN_DIR3, "package.json"));
  if (existsSync4(srcSkills))
    copyDir(srcSkills, join5(PLUGIN_DIR3, "skills"));
  writeVersionStamp(PLUGIN_DIR3, getVersion());
  log(`  OpenClaw       installed -> ${PLUGIN_DIR3}`);
}
function uninstallOpenclaw() {
  if (existsSync4(PLUGIN_DIR3)) {
    rmSync(PLUGIN_DIR3, { recursive: true, force: true });
    log(`  OpenClaw       removed ${PLUGIN_DIR3}`);
  } else {
    log(`  OpenClaw       nothing to remove`);
  }
}

// dist/src/cli/auth.js
import { existsSync as existsSync6 } from "node:fs";
import { join as join7 } from "node:path";

// dist/src/commands/auth.js
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, existsSync as existsSync5, mkdirSync as mkdirSync2, unlinkSync as unlinkSync3 } from "node:fs";
import { join as join6 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { execSync } from "node:child_process";
var CONFIG_DIR = join6(homedir2(), ".deeplake");
var CREDS_PATH = join6(CONFIG_DIR, "credentials.json");
var DEFAULT_API_URL = "https://api.deeplake.ai";
function loadCredentials() {
  if (!existsSync5(CREDS_PATH))
    return null;
  try {
    return JSON.parse(readFileSync3(CREDS_PATH, "utf-8"));
  } catch {
    return null;
  }
}
function saveCredentials(creds) {
  if (!existsSync5(CONFIG_DIR))
    mkdirSync2(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync2(CREDS_PATH, JSON.stringify({ ...creds, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), { mode: 384 });
}
async function apiGet(path, token, apiUrl, orgId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (orgId)
    headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { headers });
  if (!resp.ok)
    throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json();
}
async function apiPost(path, body, token, apiUrl, orgId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (orgId)
    headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok)
    throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json();
}
async function requestDeviceCode(apiUrl = DEFAULT_API_URL) {
  const resp = await fetch(`${apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!resp.ok)
    throw new Error(`Device flow unavailable: HTTP ${resp.status}`);
  return resp.json();
}
async function pollForToken(deviceCode, apiUrl = DEFAULT_API_URL) {
  const resp = await fetch(`${apiUrl}/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode })
  });
  if (resp.ok)
    return resp.json();
  if (resp.status === 400) {
    const err = await resp.json().catch(() => null);
    if (err?.error === "authorization_pending" || err?.error === "slow_down")
      return null;
    if (err?.error === "expired_token")
      throw new Error("Device code expired. Try again.");
    if (err?.error === "access_denied")
      throw new Error("Authorization denied.");
  }
  throw new Error(`Token polling failed: HTTP ${resp.status}`);
}
function openBrowser(url) {
  try {
    const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "${url}"` : `xdg-open "${url}" 2>/dev/null`;
    execSync(cmd, { stdio: "ignore", timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}
async function deviceFlowLogin(apiUrl = DEFAULT_API_URL) {
  const code = await requestDeviceCode(apiUrl);
  const opened = openBrowser(code.verification_uri_complete);
  const msg = [
    "\nDeeplake Authentication",
    "\u2500".repeat(40),
    `
Open this URL: ${code.verification_uri_complete}`,
    `Or visit ${code.verification_uri} and enter code: ${code.user_code}`,
    opened ? "\nBrowser opened. Waiting for sign in..." : "\nWaiting for sign in..."
  ].join("\n");
  process.stderr.write(msg + "\n");
  const interval = Math.max(code.interval || 5, 5) * 1e3;
  const deadline = Date.now() + code.expires_in * 1e3;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const result = await pollForToken(code.device_code, apiUrl);
    if (result) {
      process.stderr.write("\nAuthentication successful!\n");
      return { token: result.access_token, expiresIn: result.expires_in };
    }
  }
  throw new Error("Device code expired.");
}
async function listOrgs(token, apiUrl = DEFAULT_API_URL) {
  const data = await apiGet("/organizations", token, apiUrl);
  return Array.isArray(data) ? data : [];
}
async function login(apiUrl = DEFAULT_API_URL) {
  const { token: authToken } = await deviceFlowLogin(apiUrl);
  const user = await apiGet("/me", authToken, apiUrl);
  const userName = user.name || (user.email ? user.email.split("@")[0] : "unknown");
  process.stderr.write(`
Logged in as: ${userName}
`);
  const orgs = await listOrgs(authToken, apiUrl);
  let orgId;
  let orgName;
  if (orgs.length === 1) {
    orgId = orgs[0].id;
    orgName = orgs[0].name;
    process.stderr.write(`Organization: ${orgName}
`);
  } else {
    process.stderr.write("\nOrganizations:\n");
    orgs.forEach((org, i) => process.stderr.write(`  ${i + 1}. ${org.name}
`));
    orgId = orgs[0].id;
    orgName = orgs[0].name;
    process.stderr.write(`
Using: ${orgName}
`);
  }
  const tokenName = `deeplake-plugin-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
  const tokenData = await apiPost("/users/me/tokens", {
    name: tokenName,
    duration: 365 * 24 * 3600,
    organization_id: orgId
  }, authToken, apiUrl);
  const apiToken = tokenData.token.token;
  const creds = {
    token: apiToken,
    orgId,
    orgName,
    userName,
    workspaceId: "default",
    apiUrl,
    savedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  saveCredentials(creds);
  return creds;
}

// dist/src/cli/auth.js
var CREDS_PATH2 = join7(HOME, ".deeplake", "credentials.json");
function isLoggedIn() {
  return existsSync6(CREDS_PATH2) && loadCredentials() !== null;
}
async function ensureLoggedIn() {
  if (isLoggedIn())
    return true;
  log("");
  log("No Deeplake credentials found. Starting login...");
  try {
    const apiUrl = process.env.HIVEMIND_API_URL ?? process.env.DEEPLAKE_API_URL ?? "https://api.deeplake.ai";
    await login(apiUrl);
  } catch (err) {
    warn(`Login failed: ${err.message}`);
    return false;
  }
  return isLoggedIn();
}
async function maybeShowOrgChoice() {
  const creds = loadCredentials();
  if (!creds)
    return;
  try {
    const orgs = await listOrgs(creds.token, creds.apiUrl ?? "https://api.deeplake.ai");
    if (orgs.length <= 1)
      return;
    const activeName = creds.orgName ?? creds.orgId;
    log("");
    log(`You belong to ${orgs.length} orgs. Active: ${activeName}`);
    log(`  Change with: hivemind org switch <name-or-id>`);
  } catch {
  }
}

// dist/src/cli/index.js
var USAGE = `
hivemind \u2014 one brain for every agent on your team

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
function parseOnly(args) {
  const idx = args.findIndex((a) => a === "--only" || a.startsWith("--only="));
  if (idx === -1)
    return null;
  const raw = args[idx].includes("=") ? args[idx].split("=", 2)[1] : args[idx + 1];
  if (!raw)
    return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = new Set(allPlatformIds());
  const bad = ids.filter((id) => !valid.has(id));
  if (bad.length > 0) {
    warn(`Unknown platform(s): ${bad.join(", ")}. Valid: ${allPlatformIds().join(", ")}`);
    process.exit(1);
  }
  return ids;
}
function hasFlag(args, flag) {
  return args.includes(flag);
}
async function runInstallAll(args) {
  const only = parseOnly(args);
  const skipAuth = hasFlag(args, "--skip-auth");
  const targets = only ?? detectPlatforms().map((p) => p.id);
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
  for (const id of targets)
    runSingleInstall(id);
  await maybeShowOrgChoice();
  log("");
  log("Done. Restart each assistant to activate hooks.");
}
function runSingleInstall(id) {
  try {
    if (id === "claude")
      installClaude();
    else if (id === "codex")
      installCodex();
    else if (id === "claw")
      installOpenclaw();
  } catch (err) {
    warn(`  ${id.padEnd(14)} FAILED: ${err.message}`);
  }
}
function runSingleUninstall(id) {
  try {
    if (id === "claude")
      uninstallClaude();
    else if (id === "codex")
      uninstallCodex();
    else if (id === "claw")
      uninstallOpenclaw();
  } catch (err) {
    warn(`  ${id.padEnd(14)} FAILED: ${err.message}`);
  }
}
function runStatus() {
  const detected = detectPlatforms();
  log(`hivemind ${getVersion()}`);
  log(`logged in: ${isLoggedIn() ? "yes" : "no"}`);
  log("");
  log("Detected assistants:");
  if (detected.length === 0)
    log("  (none)");
  for (const p of detected)
    log(`  ${p.id.padEnd(8)} ${p.markerDir}`);
}
async function main() {
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
  if (cmd === "install") {
    await runInstallAll(args.slice(1));
    return;
  }
  if (cmd === "uninstall") {
    const only = parseOnly(args.slice(1));
    const targets = only ?? detectPlatforms().map((p) => p.id);
    for (const id of targets)
      runSingleUninstall(id);
    return;
  }
  if (cmd === "login") {
    await ensureLoggedIn();
    return;
  }
  if (cmd === "status") {
    runStatus();
    return;
  }
  if (cmd === "claude" || cmd === "codex" || cmd === "claw") {
    const sub = args[1];
    if (sub === "install")
      runSingleInstall(cmd);
    else if (sub === "uninstall")
      runSingleUninstall(cmd);
    else {
      warn(`Usage: hivemind ${cmd} install|uninstall`);
      process.exit(1);
    }
    return;
  }
  warn(`Unknown command: ${cmd}`);
  log(USAGE);
  process.exit(1);
}
main().catch((err) => {
  warn(`hivemind: ${err.message}`);
  process.exit(1);
});
