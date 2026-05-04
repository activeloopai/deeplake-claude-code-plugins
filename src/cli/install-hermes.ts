import { existsSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { HOME, pkgRoot, ensureDir, copyDir, writeVersionStamp, log } from "./util.js";
import { getVersion } from "./version.js";
import { ensureMcpServerInstalled, MCP_SERVER_PATH } from "./install-mcp-shared.js";

// Hermes Agent (NousResearch/hermes-agent) integration.
//
// Hermes exposes three integration surfaces, all installed here:
//
//   1. Skills (agentskills.io-compatible) at ~/.hermes/skills/<name>/
//      — provides agent context. No event capture.
//
//   2. MCP servers via ~/.hermes/config.yaml `mcp_servers:` key
//      — direct hivemind_search/read/index tool calls. Read-only recall.
//
//   3. Shell hooks via ~/.hermes/config.yaml `hooks:` key (see
//      agent/shell_hooks.py in NousResearch/hermes-agent for the wire
//      protocol — Claude Code-shaped JSON on stdin) — auto-capture.
//      Lifecycle events: on_session_start, pre_llm_call, post_tool_call,
//      post_llm_call, on_session_end.
//
// Result: Hermes joins Tier 1 (full hook autocapture + MCP recall),
// matching Claude Code / Codex / Cursor.
//
// Verify against current Hermes docs before changing the format:
//   - https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
//   - https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
//   - https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks

const HERMES_HOME = join(HOME, ".hermes");
const SKILLS_ROOT = join(HERMES_HOME, "skills");
const MEMORY_SKILL_DIR = join(SKILLS_ROOT, "hivemind-memory");
const HIVEMIND_DIR = join(HERMES_HOME, "hivemind");
const BUNDLE_DIR = join(HIVEMIND_DIR, "bundle");
const CONFIG_PATH = join(HERMES_HOME, "config.yaml");
const SERVER_KEY = "hivemind";
const MANAGED_PACKAGED_SKILLS = ["gdd-workflow"];

const SKILL_BODY = `---
name: hivemind-memory
description: Global team and org memory powered by Activeloop. ALWAYS check BOTH built-in memory AND Hivemind memory when recalling information.
---

# Hivemind Memory

You have persistent memory at \`~/.deeplake/memory/\` — global memory shared across all sessions, users, and agents in the org.

## Hivemind tools (preferred)

When you need to recall org memory, prefer calling the hivemind MCP tools — one tool call returns ranked hits across all summaries and sessions in a single SQL query:

- \`hivemind_search { query, limit? }\` — keyword/regex search across summaries + sessions
- \`hivemind_read { path }\` — read full content at a Hivemind memory path (e.g. \`/summaries/alice/abc.md\`)
- \`hivemind_index { prefix?, limit? }\` — list summary entries

Different paths under \`/summaries/<username>/\` are different users — do NOT merge or alias them.

## Direct filesystem fallback

If MCP tools are unavailable for some reason, fall back to reading the virtual filesystem at \`~/.deeplake/memory/\`:

\`\`\`
~/.deeplake/memory/
├── index.md                          ← START HERE — table of all sessions
├── summaries/
│   ├── session-abc.md                ← AI-generated wiki summary
│   └── session-xyz.md
└── sessions/
    └── username/
        ├── user_org_ws_slug1.jsonl   ← raw session data
        └── user_org_ws_slug2.jsonl
\`\`\`

1. **First**: Read \`~/.deeplake/memory/index.md\`
2. **If you need details**: Read the specific summary at \`~/.deeplake/memory/summaries/<session>.md\`
3. **If you need raw data**: Read the session JSONL at \`~/.deeplake/memory/sessions/<user>/<file>.jsonl\`
4. **Keyword search**: \`grep -r "keyword" ~/.deeplake/memory/\` (use \`grep\`, NOT \`rg\`/ripgrep — \`rg\` may not be installed)

Do NOT jump straight to reading raw JSONL files. Always start with index.md and summaries.

## Important Constraints

- Use \`grep\` (NOT \`rg\`/ripgrep) for keyword search — \`rg\` may not be installed on the host system.
- Only use these bash builtins to interact with \`~/.deeplake/memory/\`: \`cat\`, \`ls\`, \`grep\`, \`echo\`, \`jq\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, \`wc\`, \`sort\`, \`find\`. The memory filesystem does NOT support \`rg\`, \`python\`, \`python3\`, \`node\`, or \`curl\`.
- If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than retrying exhaustively.
`;

interface HermesHookEntry {
  matcher?: string;
  command: string;
  timeout?: number;
}

interface HermesConfig {
  mcp_servers?: Record<string, unknown>;
  hooks?: Record<string, HermesHookEntry[]>;
  hooks_auto_accept?: boolean;
  [key: string]: unknown;
}

function isHivemindHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmd = (entry as { command?: string }).command;
  return typeof cmd === "string" && cmd.includes("/.hermes/hivemind/bundle/");
}

function buildHookEntry(bundleFile: string, timeout: number, matcher?: string): HermesHookEntry {
  const entry: HermesHookEntry = {
    command: `node ${join(BUNDLE_DIR, bundleFile)}`,
    timeout,
  };
  if (matcher) entry.matcher = matcher;
  return entry;
}

function buildHooksBlock(): Record<string, HermesHookEntry[]> {
  return {
    on_session_start: [buildHookEntry("session-start.js", 30)],
    // pre_tool_call (matcher: terminal) intercepts grep/rg against
    // ~/.deeplake/memory/ and replies with a single SQL fast-path result.
    // Belt-and-suspenders alongside the hivemind_search MCP tool — if the
    // agent ignores the skill guidance and runs a terminal grep, accuracy
    // still matches Tier 1 (Claude / Codex / Cursor).
    pre_tool_call: [buildHookEntry("pre-tool-use.js", 30, "terminal")],
    pre_llm_call: [buildHookEntry("capture.js", 10)],
    post_tool_call: [buildHookEntry("capture.js", 15)],
    post_llm_call: [buildHookEntry("capture.js", 15)],
    on_session_end: [buildHookEntry("session-end.js", 30)],
  };
}

function mergeHooks(existing: Record<string, HermesHookEntry[]> | undefined): Record<string, HermesHookEntry[]> {
  const merged: Record<string, HermesHookEntry[]> = { ...(existing ?? {}) };
  const ours = buildHooksBlock();
  for (const [event, entries] of Object.entries(ours)) {
    const prior = Array.isArray(merged[event]) ? merged[event] : [];
    const stripped = prior.filter((e) => !isHivemindHook(e));
    merged[event] = [...stripped, ...entries];
  }
  return merged;
}

function stripHivemindHooks(existing: Record<string, HermesHookEntry[]> | undefined): Record<string, HermesHookEntry[]> | undefined {
  if (!existing) return undefined;
  const out: Record<string, HermesHookEntry[]> = {};
  for (const [event, entries] of Object.entries(existing)) {
    const kept = (entries ?? []).filter((e) => !isHivemindHook(e));
    if (kept.length > 0) out[event] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readConfig(): HermesConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HermesConfig;
    }
    return {};
  } catch {
    // Malformed YAML — back off to empty so we don't clobber, but the user
    // will see our entry get appended fresh.
    return {};
  }
}

function writeConfig(cfg: HermesConfig): void {
  ensureDir(HERMES_HOME);
  const dumped = yaml.dump(cfg, { lineWidth: 100, noRefs: true });
  writeFileSync(CONFIG_PATH, dumped);
}

export function installHermes(): void {
  // 1. Skill — agent context.
  ensureDir(MEMORY_SKILL_DIR);
  writeFileSync(join(MEMORY_SKILL_DIR, "SKILL.md"), SKILL_BODY);
  writeVersionStamp(MEMORY_SKILL_DIR, getVersion());
  log(`  Hermes         skill installed -> ${MEMORY_SKILL_DIR}`);

  const srcSkills = join(pkgRoot(), "hermes", "skills");
  if (existsSync(srcSkills)) {
    copyDir(srcSkills, SKILLS_ROOT);
    log(`  Hermes         packaged skills installed -> ${SKILLS_ROOT}`);
  }

  // 2. Hook bundle — auto-capture via Hermes shell-hooks.
  const srcBundle = join(pkgRoot(), "hermes", "bundle");
  if (!existsSync(srcBundle)) {
    throw new Error(`Hermes bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }
  ensureDir(HIVEMIND_DIR);
  copyDir(srcBundle, BUNDLE_DIR);
  writeVersionStamp(HIVEMIND_DIR, getVersion());
  log(`  Hermes         bundle installed -> ${BUNDLE_DIR}`);

  // 3. MCP server — direct hivemind_search/read/index tool calls.
  ensureMcpServerInstalled();

  // Update config.yaml with mcp_servers + hooks + hooks_auto_accept.
  // Preserves any pre-existing user configuration.
  const cfg = readConfig();
  if (!cfg.mcp_servers || typeof cfg.mcp_servers !== "object") cfg.mcp_servers = {};
  cfg.mcp_servers[SERVER_KEY] = {
    command: "node",
    args: [MCP_SERVER_PATH],
  };
  cfg.hooks = mergeHooks(cfg.hooks);
  // Required so Hermes doesn't prompt the user for hook consent on every
  // first-use. Without it, hooks silently skip in non-TTY launches.
  cfg.hooks_auto_accept = true;
  writeConfig(cfg);
  log(`  Hermes         config updated -> ${CONFIG_PATH} (mcp_servers + hooks + hooks_auto_accept)`);
}

export function uninstallHermes(): void {
  if (existsSync(MEMORY_SKILL_DIR)) {
    rmSync(MEMORY_SKILL_DIR, { recursive: true, force: true });
    log(`  Hermes         removed ${MEMORY_SKILL_DIR}`);
  }
  for (const skill of MANAGED_PACKAGED_SKILLS) {
    const skillDir = join(SKILLS_ROOT, skill);
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
      log(`  Hermes         removed ${skillDir}`);
    }
  }

  if (existsSync(HIVEMIND_DIR)) {
    rmSync(HIVEMIND_DIR, { recursive: true, force: true });
    log(`  Hermes         removed ${HIVEMIND_DIR}`);
  }

  if (existsSync(CONFIG_PATH)) {
    const cfg = readConfig();
    let touched = false;
    if (cfg.mcp_servers && typeof cfg.mcp_servers === "object" && SERVER_KEY in cfg.mcp_servers) {
      delete cfg.mcp_servers[SERVER_KEY];
      if (Object.keys(cfg.mcp_servers).length === 0) delete cfg.mcp_servers;
      touched = true;
    }
    const stripped = stripHivemindHooks(cfg.hooks);
    if (cfg.hooks && (!stripped || Object.keys(stripped).length !== Object.keys(cfg.hooks).length)) {
      if (stripped) cfg.hooks = stripped; else delete cfg.hooks;
      touched = true;
    }
    // installHermes unconditionally writes hooks_auto_accept: true so the
    // hivemind hooks fire without a consent prompt. Leaving that flag set
    // after uninstall would silently auto-accept any unrelated hook the
    // user adds later. Always remove it on uninstall — if a user wanted
    // hooks_auto_accept independently, they can re-add it.
    if ("hooks_auto_accept" in cfg) {
      delete cfg.hooks_auto_accept;
      touched = true;
    }
    if (touched) {
      if (Object.keys(cfg).length === 0) {
        unlinkSync(CONFIG_PATH);
      } else {
        writeConfig(cfg);
      }
      log(`  Hermes         hivemind entries removed from ${CONFIG_PATH}`);
    }
  }
}
