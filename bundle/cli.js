#!/usr/bin/env node

// dist/src/cli/install-claude.js
import { execFileSync } from "node:child_process";

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
  { id: "claw", markerDir: join(HOME, ".openclaw") },
  { id: "cursor", markerDir: join(HOME, ".cursor") },
  { id: "hermes", markerDir: join(HOME, ".hermes") },
  // pi (badlogic/pi-mono coding-agent) — config at ~/.pi/agent/
  { id: "pi", markerDir: join(HOME, ".pi") },
  // Cline (saoudrizwan.claude-dev VS Code extension) — settings under VS Code's globalStorage
  { id: "cline", markerDir: join(HOME, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev") },
  // Roo Code (rooveterinaryinc.roo-cline VS Code extension)
  { id: "roo", markerDir: join(HOME, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline") },
  // Kilo Code — config at ~/.kilocode/
  { id: "kilo", markerDir: join(HOME, ".kilocode") }
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

// dist/src/cli/install-claude.js
var MARKETPLACE_NAME = "hivemind";
var MARKETPLACE_SOURCE = "activeloopai/hivemind";
var PLUGIN_KEY = "hivemind@hivemind";
function runClaude(args) {
  try {
    const stdout = execFileSync("claude", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err;
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message ?? ""
    };
  }
}
function requireClaudeCli() {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("Claude Code CLI ('claude') not found on PATH. Install Claude Code first: https://claude.com/claude-code");
  }
}
function marketplaceAlreadyAdded() {
  const r = runClaude(["plugin", "marketplace", "list"]);
  if (!r.ok)
    return false;
  return new RegExp(`(^|\\s)${MARKETPLACE_NAME}(\\s|$)`, "m").test(r.stdout);
}
function pluginAlreadyInstalled() {
  const r = runClaude(["plugin", "list"]);
  if (!r.ok)
    return false;
  return r.stdout.includes(PLUGIN_KEY);
}
function installClaude() {
  requireClaudeCli();
  if (!marketplaceAlreadyAdded()) {
    const add = runClaude(["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
    if (!add.ok) {
      throw new Error(`Failed to add marketplace '${MARKETPLACE_SOURCE}': ${add.stderr.slice(0, 200)}`);
    }
  }
  if (!pluginAlreadyInstalled()) {
    const inst = runClaude(["plugin", "install", "hivemind"]);
    if (!inst.ok) {
      throw new Error(`Failed to install hivemind plugin: ${inst.stderr.slice(0, 200)}`);
    }
  }
  runClaude(["plugin", "enable", PLUGIN_KEY]);
  log(`  Claude Code    installed via marketplace ${MARKETPLACE_SOURCE}`);
}
function uninstallClaude() {
  try {
    requireClaudeCli();
  } catch {
    log("  Claude Code    skip uninstall \u2014 claude CLI not on PATH");
    return;
  }
  runClaude(["plugin", "disable", PLUGIN_KEY]);
  runClaude(["plugin", "uninstall", PLUGIN_KEY]);
  log("  Claude Code    plugin uninstalled");
}

// dist/src/cli/install-codex.js
import { existsSync as existsSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { execFileSync as execFileSync2 } from "node:child_process";
import { join as join3 } from "node:path";

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

// dist/src/cli/install-codex.js
var CODEX_HOME = join3(HOME, ".codex");
var PLUGIN_DIR = join3(CODEX_HOME, "hivemind");
var HOOKS_PATH = join3(CODEX_HOME, "hooks.json");
var AGENTS_SKILLS_DIR = join3(HOME, ".agents", "skills");
var SKILL_LINK = join3(AGENTS_SKILLS_DIR, "hivemind-memory");
function hookCmd(bundleFile, timeout, matcher) {
  const block = {
    hooks: [{
      type: "command",
      command: `node "${join3(PLUGIN_DIR, "bundle", bundleFile)}"`,
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
    execFileSync2("codex", ["features", "enable", "codex_hooks"], { stdio: "ignore" });
  } catch {
  }
}
function installCodex() {
  const srcBundle = join3(pkgRoot(), "codex", "bundle");
  const srcSkills = join3(pkgRoot(), "codex", "skills");
  if (!existsSync2(srcBundle)) {
    throw new Error(`Codex bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }
  ensureDir(PLUGIN_DIR);
  copyDir(srcBundle, join3(PLUGIN_DIR, "bundle"));
  if (existsSync2(srcSkills))
    copyDir(srcSkills, join3(PLUGIN_DIR, "skills"));
  tryEnableCodexHooks();
  writeJson(HOOKS_PATH, buildHooksJson());
  ensureDir(AGENTS_SKILLS_DIR);
  const skillTarget = join3(PLUGIN_DIR, "skills", "deeplake-memory");
  if (existsSync2(skillTarget)) {
    symlinkForce(skillTarget, SKILL_LINK);
  } else {
    warn(`  Codex          skill source missing at ${skillTarget}; skipping symlink`);
  }
  writeVersionStamp(PLUGIN_DIR, getVersion());
  log(`  Codex          installed -> ${PLUGIN_DIR}`);
}
function uninstallCodex() {
  if (existsSync2(HOOKS_PATH)) {
    unlinkSync2(HOOKS_PATH);
    log(`  Codex          removed ${HOOKS_PATH}`);
  }
  if (existsSync2(SKILL_LINK)) {
    unlinkSync2(SKILL_LINK);
    log(`  Codex          removed ${SKILL_LINK}`);
  }
  log(`  Codex          plugin files kept at ${PLUGIN_DIR}`);
}

// dist/src/cli/install-openclaw.js
import { existsSync as existsSync3, rmSync } from "node:fs";
import { join as join4 } from "node:path";
var PLUGIN_DIR2 = join4(HOME, ".openclaw", "extensions", "hivemind");
function installOpenclaw() {
  const srcDist = join4(pkgRoot(), "openclaw", "dist");
  const srcManifest = join4(pkgRoot(), "openclaw", "openclaw.plugin.json");
  const srcPkg = join4(pkgRoot(), "openclaw", "package.json");
  const srcSkills = join4(pkgRoot(), "openclaw", "skills");
  if (!existsSync3(srcDist)) {
    throw new Error(`OpenClaw bundle missing at ${srcDist}. Run 'npm run build' first.`);
  }
  ensureDir(PLUGIN_DIR2);
  copyDir(srcDist, join4(PLUGIN_DIR2, "dist"));
  if (existsSync3(srcManifest))
    copyDir(srcManifest, join4(PLUGIN_DIR2, "openclaw.plugin.json"));
  if (existsSync3(srcPkg))
    copyDir(srcPkg, join4(PLUGIN_DIR2, "package.json"));
  if (existsSync3(srcSkills))
    copyDir(srcSkills, join4(PLUGIN_DIR2, "skills"));
  writeVersionStamp(PLUGIN_DIR2, getVersion());
  log(`  OpenClaw       installed -> ${PLUGIN_DIR2}`);
}
function uninstallOpenclaw() {
  if (existsSync3(PLUGIN_DIR2)) {
    rmSync(PLUGIN_DIR2, { recursive: true, force: true });
    log(`  OpenClaw       removed ${PLUGIN_DIR2}`);
  } else {
    log(`  OpenClaw       nothing to remove`);
  }
}

// dist/src/cli/install-cursor.js
import { existsSync as existsSync4, unlinkSync as unlinkSync3 } from "node:fs";
import { join as join5 } from "node:path";
var CURSOR_HOME = join5(HOME, ".cursor");
var PLUGIN_DIR3 = join5(CURSOR_HOME, "hivemind");
var HOOKS_PATH2 = join5(CURSOR_HOME, "hooks.json");
var HIVEMIND_MARKER_KEY = "_hivemindManaged";
function buildHookCmd(bundleFile, timeout) {
  return {
    type: "command",
    command: `node "${join5(PLUGIN_DIR3, "bundle", bundleFile)}"`,
    timeout
  };
}
function buildHookConfig() {
  return {
    sessionStart: [buildHookCmd("session-start.js", 30)],
    beforeSubmitPrompt: [buildHookCmd("capture.js", 10)],
    postToolUse: [buildHookCmd("capture.js", 15)],
    afterAgentResponse: [buildHookCmd("capture.js", 15)],
    stop: [buildHookCmd("capture.js", 15)],
    sessionEnd: [buildHookCmd("session-end.js", 30)]
  };
}
function isHivemindEntry(entry) {
  if (!entry || typeof entry !== "object")
    return false;
  const cmd = entry.command;
  return typeof cmd === "string" && cmd.includes("/.cursor/hivemind/bundle/");
}
function mergeHooks(existing) {
  const root = existing ?? { version: 1, hooks: {} };
  if (!root.version)
    root.version = 1;
  if (!root.hooks)
    root.hooks = {};
  const ours = buildHookConfig();
  for (const [event, entries] of Object.entries(ours)) {
    const prior = Array.isArray(root.hooks[event]) ? root.hooks[event] : [];
    const stripped = prior.filter((e) => !isHivemindEntry(e));
    root.hooks[event] = [...stripped, ...entries];
  }
  root[HIVEMIND_MARKER_KEY] = { version: getVersion() };
  return root;
}
function stripHooksFromConfig(existing) {
  if (!existing)
    return null;
  const root = existing;
  if (root.hooks) {
    for (const event of Object.keys(root.hooks)) {
      root.hooks[event] = (root.hooks[event] ?? []).filter((e) => !isHivemindEntry(e));
      if (root.hooks[event].length === 0)
        delete root.hooks[event];
    }
    if (Object.keys(root.hooks).length === 0)
      delete root.hooks;
  }
  delete existing[HIVEMIND_MARKER_KEY];
  return existing;
}
function installCursor() {
  const srcBundle = join5(pkgRoot(), "cursor", "bundle");
  if (!existsSync4(srcBundle)) {
    throw new Error(`Cursor bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }
  ensureDir(PLUGIN_DIR3);
  copyDir(srcBundle, join5(PLUGIN_DIR3, "bundle"));
  const existing = readJson(HOOKS_PATH2);
  const merged = mergeHooks(existing);
  writeJson(HOOKS_PATH2, merged);
  writeVersionStamp(PLUGIN_DIR3, getVersion());
  log(`  Cursor         installed -> ${PLUGIN_DIR3}`);
}
function uninstallCursor() {
  const existing = readJson(HOOKS_PATH2);
  if (!existing) {
    log("  Cursor         no hooks.json to clean");
    return;
  }
  const stripped = stripHooksFromConfig(existing);
  if (!stripped || Object.keys(stripped).length === 1 && stripped.version) {
    if (existsSync4(HOOKS_PATH2))
      unlinkSync3(HOOKS_PATH2);
  } else {
    writeJson(HOOKS_PATH2, stripped);
  }
  log(`  Cursor         hooks removed from ${HOOKS_PATH2} (plugin files kept at ${PLUGIN_DIR3})`);
}

// dist/src/cli/install-hermes.js
import { existsSync as existsSync5, writeFileSync as writeFileSync2, rmSync as rmSync2 } from "node:fs";
import { join as join6 } from "node:path";
var HERMES_HOME = join6(HOME, ".hermes");
var SKILLS_DIR = join6(HERMES_HOME, "skills", "hivemind-memory");
var SKILL_BODY = `---
name: hivemind-memory
description: Global team and org memory powered by Activeloop. ALWAYS check BOTH built-in memory AND Hivemind memory when recalling information.
---

# Hivemind Memory

You have persistent memory at \`~/.deeplake/memory/\` \u2014 global memory shared across all sessions, users, and agents in the org.

## Memory Structure

\`\`\`
~/.deeplake/memory/
\u251C\u2500\u2500 index.md                          \u2190 START HERE \u2014 table of all sessions
\u251C\u2500\u2500 summaries/
\u2502   \u251C\u2500\u2500 session-abc.md                \u2190 AI-generated wiki summary
\u2502   \u2514\u2500\u2500 session-xyz.md
\u2514\u2500\u2500 sessions/
    \u2514\u2500\u2500 username/
        \u251C\u2500\u2500 user_org_ws_slug1.jsonl   \u2190 raw session data
        \u2514\u2500\u2500 user_org_ws_slug2.jsonl
\`\`\`

## How to Search

1. **First**: Read \`~/.deeplake/memory/index.md\` \u2014 quick scan of all sessions with dates, projects, descriptions
2. **If you need details**: Read the specific summary at \`~/.deeplake/memory/summaries/<session>.md\`
3. **If you need raw data**: Read the session JSONL at \`~/.deeplake/memory/sessions/<user>/<file>.jsonl\`
4. **Keyword search**: \`grep -r "keyword" ~/.deeplake/memory/\`

Do NOT jump straight to reading raw JSONL files. Always start with index.md and summaries.

## Important Constraints

- Only use bash builtins (\`cat\`, \`ls\`, \`grep\`, \`echo\`, \`jq\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, \`wc\`, \`sort\`, \`find\`) to interact with \`~/.deeplake/memory/\`. The memory filesystem does NOT support \`python\`, \`python3\`, \`node\`, or \`curl\`.
- If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than retrying exhaustively.
`;
function installHermes() {
  ensureDir(SKILLS_DIR);
  writeFileSync2(join6(SKILLS_DIR, "SKILL.md"), SKILL_BODY);
  writeVersionStamp(SKILLS_DIR, getVersion());
  log(`  Hermes         skill installed -> ${SKILLS_DIR}`);
}
function uninstallHermes() {
  if (existsSync5(SKILLS_DIR)) {
    rmSync2(SKILLS_DIR, { recursive: true, force: true });
    log(`  Hermes         removed ${SKILLS_DIR}`);
  } else {
    log("  Hermes         nothing to remove");
  }
}

// dist/src/cli/install-pi.js
import { existsSync as existsSync6, writeFileSync as writeFileSync3, rmSync as rmSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join7 } from "node:path";
var PI_AGENT_DIR = join7(HOME, ".pi", "agent");
var AGENTS_MD = join7(PI_AGENT_DIR, "AGENTS.md");
var SKILL_DIR = join7(PI_AGENT_DIR, "skills", "hivemind-memory");
var VERSION_DIR = join7(PI_AGENT_DIR, ".hivemind");
var HIVEMIND_BLOCK_START = "<!-- BEGIN hivemind-memory -->";
var HIVEMIND_BLOCK_END = "<!-- END hivemind-memory -->";
var HIVEMIND_BLOCK_BODY = `${HIVEMIND_BLOCK_START}
## Hivemind Memory

You have access to global org memory at \`~/.deeplake/memory/\`. Always check both
your local context AND Hivemind memory when the user asks you to recall, look up,
or remember anything.

- Start with \`~/.deeplake/memory/index.md\` (table of all sessions)
- Then read specific summaries at \`~/.deeplake/memory/summaries/<user>/<session>.md\`
- Only fall back to raw \`~/.deeplake/memory/sessions/<user>/*.jsonl\` if summaries don't have enough detail
- Search: \`grep -r "keyword" ~/.deeplake/memory/\`

Use only bash builtins (cat, ls, grep, jq, head, tail, sed, awk) to read this filesystem \u2014
node/python/curl are not available there.
${HIVEMIND_BLOCK_END}`;
var SKILL_BODY2 = `---
name: hivemind-memory
description: Global team and org memory powered by Activeloop. Always check both local context AND Hivemind memory when recalling information.
---

# Hivemind Memory

You have persistent memory at \`~/.deeplake/memory/\` \u2014 global memory shared across all sessions, users, and agents in the org.

## Memory Structure

\`\`\`
~/.deeplake/memory/
\u251C\u2500\u2500 index.md                          \u2190 START HERE \u2014 table of all sessions
\u251C\u2500\u2500 summaries/
\u2502   \u251C\u2500\u2500 session-abc.md                \u2190 AI-generated wiki summary
\u2502   \u2514\u2500\u2500 session-xyz.md
\u2514\u2500\u2500 sessions/
    \u2514\u2500\u2500 username/
        \u251C\u2500\u2500 user_org_ws_slug1.jsonl   \u2190 raw session data
        \u2514\u2500\u2500 user_org_ws_slug2.jsonl
\`\`\`

## How to Search

1. **First**: Read \`~/.deeplake/memory/index.md\` \u2014 quick scan of all sessions with dates, projects, descriptions
2. **If you need details**: Read the specific summary at \`~/.deeplake/memory/summaries/<session>.md\`
3. **If you need raw data**: Read the session JSONL at \`~/.deeplake/memory/sessions/<user>/<file>.jsonl\`
4. **Keyword search**: \`grep -r "keyword" ~/.deeplake/memory/\`

Do NOT jump straight to reading raw JSONL files. Always start with index.md and summaries.

## Important Constraints

- Only use bash builtins (\`cat\`, \`ls\`, \`grep\`, \`echo\`, \`jq\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, \`wc\`, \`sort\`, \`find\`) to interact with \`~/.deeplake/memory/\`. The memory filesystem does NOT support \`python\`, \`python3\`, \`node\`, or \`curl\`.
- If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than retrying exhaustively.
`;
function upsertHivemindBlock(existing) {
  const block = HIVEMIND_BLOCK_BODY;
  if (!existing)
    return `${block}
`;
  const startIdx = existing.indexOf(HIVEMIND_BLOCK_START);
  if (startIdx === -1)
    return `${existing.trimEnd()}

${block}
`;
  const endIdx = existing.indexOf(HIVEMIND_BLOCK_END, startIdx);
  if (endIdx === -1) {
    return `${existing.trimEnd()}

${block}
`;
  }
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + HIVEMIND_BLOCK_END.length).replace(/^\n+/, "");
  const rest = after ? `

${after}` : "";
  return `${before ? before + "\n\n" : ""}${block}
${rest}`;
}
function stripHivemindBlock(existing) {
  const startIdx = existing.indexOf(HIVEMIND_BLOCK_START);
  if (startIdx === -1)
    return existing;
  const endIdx = existing.indexOf(HIVEMIND_BLOCK_END, startIdx);
  if (endIdx === -1)
    return existing;
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + HIVEMIND_BLOCK_END.length).replace(/^\n+/, "");
  if (!before && !after)
    return "";
  if (!before)
    return after;
  if (!after)
    return `${before}
`;
  return `${before}

${after}`;
}
function installPi() {
  ensureDir(PI_AGENT_DIR);
  ensureDir(SKILL_DIR);
  writeFileSync3(join7(SKILL_DIR, "SKILL.md"), SKILL_BODY2);
  const prior = existsSync6(AGENTS_MD) ? readFileSync3(AGENTS_MD, "utf-8") : null;
  const next = upsertHivemindBlock(prior);
  writeFileSync3(AGENTS_MD, next);
  ensureDir(VERSION_DIR);
  writeVersionStamp(VERSION_DIR, getVersion());
  log(`  pi             skill installed -> ${SKILL_DIR}`);
  log(`  pi             AGENTS.md updated -> ${AGENTS_MD}`);
}
function uninstallPi() {
  if (existsSync6(SKILL_DIR)) {
    rmSync3(SKILL_DIR, { recursive: true, force: true });
    log(`  pi             removed ${SKILL_DIR}`);
  }
  if (existsSync6(AGENTS_MD)) {
    const prior = readFileSync3(AGENTS_MD, "utf-8");
    const stripped = stripHivemindBlock(prior);
    if (stripped.trim().length === 0) {
      rmSync3(AGENTS_MD, { force: true });
      log(`  pi             removed empty ${AGENTS_MD}`);
    } else {
      writeFileSync3(AGENTS_MD, stripped);
      log(`  pi             stripped hivemind block from ${AGENTS_MD}`);
    }
  }
  if (existsSync6(VERSION_DIR)) {
    rmSync3(VERSION_DIR, { recursive: true, force: true });
  }
}

// dist/src/cli/install-cline.js
import { existsSync as existsSync8, unlinkSync as unlinkSync4 } from "node:fs";
import { join as join9 } from "node:path";

// dist/src/cli/install-mcp-shared.js
import { existsSync as existsSync7 } from "node:fs";
import { join as join8 } from "node:path";
var HIVEMIND_DIR = join8(HOME, ".hivemind");
var MCP_DIR = join8(HIVEMIND_DIR, "mcp");
var MCP_SERVER_PATH = join8(MCP_DIR, "server.js");
var MCP_PACKAGE_JSON = join8(MCP_DIR, "package.json");
function ensureMcpServerInstalled() {
  const srcDir = join8(pkgRoot(), "mcp", "bundle");
  if (!existsSync7(srcDir)) {
    throw new Error(`MCP server bundle missing at ${srcDir}. Run 'npm run build' to produce it before installing Tier B consumers.`);
  }
  ensureDir(MCP_DIR);
  copyDir(srcDir, MCP_DIR);
  writeVersionStamp(HIVEMIND_DIR, getVersion());
  log(`  hivemind-mcp   server installed -> ${MCP_SERVER_PATH}`);
}
function buildMcpServerEntry() {
  return {
    command: "node",
    args: [MCP_SERVER_PATH]
  };
}

// dist/src/cli/install-cline.js
var CONFIG_PATH = join9(HOME, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
var SERVER_KEY = "hivemind";
function installCline() {
  ensureMcpServerInstalled();
  const cfg = readJson(CONFIG_PATH) ?? {};
  if (!cfg.mcpServers)
    cfg.mcpServers = {};
  cfg.mcpServers[SERVER_KEY] = buildMcpServerEntry();
  writeJson(CONFIG_PATH, cfg);
  log(`  Cline          MCP server registered in ${CONFIG_PATH}`);
}
function uninstallCline() {
  const cfg = readJson(CONFIG_PATH);
  if (!cfg?.mcpServers || !(SERVER_KEY in cfg.mcpServers)) {
    log("  Cline          nothing to remove");
    return;
  }
  delete cfg.mcpServers[SERVER_KEY];
  if (Object.keys(cfg.mcpServers).length === 0) {
    delete cfg.mcpServers;
  }
  if (Object.keys(cfg).length === 0) {
    if (existsSync8(CONFIG_PATH))
      unlinkSync4(CONFIG_PATH);
  } else {
    writeJson(CONFIG_PATH, cfg);
  }
  log(`  Cline          MCP entry removed from ${CONFIG_PATH}`);
}

// dist/src/cli/install-roo.js
import { existsSync as existsSync9, unlinkSync as unlinkSync5 } from "node:fs";
import { join as join10 } from "node:path";
var CONFIG_PATH2 = join10(HOME, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json");
var SERVER_KEY2 = "hivemind";
function installRoo() {
  ensureMcpServerInstalled();
  const cfg = readJson(CONFIG_PATH2) ?? {};
  if (!cfg.mcpServers)
    cfg.mcpServers = {};
  cfg.mcpServers[SERVER_KEY2] = buildMcpServerEntry();
  writeJson(CONFIG_PATH2, cfg);
  log(`  Roo Code       MCP server registered in ${CONFIG_PATH2}`);
}
function uninstallRoo() {
  const cfg = readJson(CONFIG_PATH2);
  if (!cfg?.mcpServers || !(SERVER_KEY2 in cfg.mcpServers)) {
    log("  Roo Code       nothing to remove");
    return;
  }
  delete cfg.mcpServers[SERVER_KEY2];
  if (Object.keys(cfg.mcpServers).length === 0)
    delete cfg.mcpServers;
  if (Object.keys(cfg).length === 0) {
    if (existsSync9(CONFIG_PATH2))
      unlinkSync5(CONFIG_PATH2);
  } else {
    writeJson(CONFIG_PATH2, cfg);
  }
  log(`  Roo Code       MCP entry removed from ${CONFIG_PATH2}`);
}

// dist/src/cli/install-kilo.js
import { existsSync as existsSync10, unlinkSync as unlinkSync6 } from "node:fs";
import { join as join11 } from "node:path";
var CONFIG_PATH3 = join11(HOME, ".kilocode", "mcp.json");
var SERVER_KEY3 = "hivemind";
function installKilo() {
  ensureMcpServerInstalled();
  const cfg = readJson(CONFIG_PATH3) ?? {};
  if (!cfg.mcpServers)
    cfg.mcpServers = {};
  cfg.mcpServers[SERVER_KEY3] = buildMcpServerEntry();
  writeJson(CONFIG_PATH3, cfg);
  log(`  Kilo Code      MCP server registered in ${CONFIG_PATH3}`);
}
function uninstallKilo() {
  const cfg = readJson(CONFIG_PATH3);
  if (!cfg?.mcpServers || !(SERVER_KEY3 in cfg.mcpServers)) {
    log("  Kilo Code      nothing to remove");
    return;
  }
  delete cfg.mcpServers[SERVER_KEY3];
  if (Object.keys(cfg.mcpServers).length === 0)
    delete cfg.mcpServers;
  if (Object.keys(cfg).length === 0) {
    if (existsSync10(CONFIG_PATH3))
      unlinkSync6(CONFIG_PATH3);
  } else {
    writeJson(CONFIG_PATH3, cfg);
  }
  log(`  Kilo Code      MCP entry removed from ${CONFIG_PATH3}`);
}

// dist/src/cli/auth.js
import { existsSync as existsSync12 } from "node:fs";
import { join as join13 } from "node:path";

// dist/src/commands/auth.js
import { readFileSync as readFileSync4, writeFileSync as writeFileSync4, existsSync as existsSync11, mkdirSync as mkdirSync2, unlinkSync as unlinkSync7 } from "node:fs";
import { join as join12 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { execSync } from "node:child_process";
var CONFIG_DIR = join12(homedir2(), ".deeplake");
var CREDS_PATH = join12(CONFIG_DIR, "credentials.json");
var DEFAULT_API_URL = "https://api.deeplake.ai";
function loadCredentials() {
  if (!existsSync11(CREDS_PATH))
    return null;
  try {
    return JSON.parse(readFileSync4(CREDS_PATH, "utf-8"));
  } catch {
    return null;
  }
}
function saveCredentials(creds) {
  if (!existsSync11(CONFIG_DIR))
    mkdirSync2(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync4(CREDS_PATH, JSON.stringify({ ...creds, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), { mode: 384 });
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
var CREDS_PATH2 = join13(HOME, ".deeplake", "credentials.json");
function isLoggedIn() {
  return existsSync12(CREDS_PATH2) && loadCredentials() !== null;
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
      --only takes a comma-separated list: ${allPlatformIds().join(",")}

  hivemind claude  install | uninstall
  hivemind codex   install | uninstall
  hivemind claw    install | uninstall
  hivemind cursor  install | uninstall
  hivemind hermes  install | uninstall
  hivemind pi      install | uninstall
  hivemind cline   install | uninstall
  hivemind roo     install | uninstall
  hivemind kilo    install | uninstall
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
    log("No supported assistants detected.");
    log("Supported: Claude Code, Codex, OpenClaw, Cursor, Hermes Agent.");
    log("Install one and rerun `hivemind install`, or target a specific assistant: `hivemind cursor install`.");
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
    else if (id === "cursor")
      installCursor();
    else if (id === "hermes")
      installHermes();
    else if (id === "pi")
      installPi();
    else if (id === "cline")
      installCline();
    else if (id === "roo")
      installRoo();
    else if (id === "kilo")
      installKilo();
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
    else if (id === "cursor")
      uninstallCursor();
    else if (id === "hermes")
      uninstallHermes();
    else if (id === "pi")
      uninstallPi();
    else if (id === "cline")
      uninstallCline();
    else if (id === "roo")
      uninstallRoo();
    else if (id === "kilo")
      uninstallKilo();
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
  const platformCmds = ["claude", "codex", "claw", "cursor", "hermes", "pi", "cline", "roo", "kilo"];
  if (platformCmds.includes(cmd)) {
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
