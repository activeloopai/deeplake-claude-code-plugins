#!/usr/bin/env node

// dist/src/skillify/skillify-worker.js
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, existsSync as existsSync5, appendFileSync as appendFileSync2, rmSync } from "node:fs";
import { join as join7 } from "node:path";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var LOG = join(homedir(), ".deeplake", "hook-debug.log");
function isDebug() {
  return process.env.HIVEMIND_DEBUG === "1";
}
function utcTimestamp(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function log(tag, msg) {
  if (!isDebug())
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/utils/client-header.js
var DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
function deeplakeClientValue() {
  return "hivemind";
}
function deeplakeClientHeader() {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}

// dist/src/skillify/extractors/index.js
function extractPairs(rows) {
  const pairs = [];
  let pendingPrompt = null;
  let pendingAnswer = [];
  function flush() {
    if (pendingPrompt && pendingAnswer.length > 0) {
      pairs.push({
        sessionId: pendingPrompt.row.session_id ?? "",
        agent: pendingPrompt.row.agent ?? null,
        date: pendingPrompt.row.creation_date ?? null,
        prompt: pendingPrompt.content,
        answer: pendingAnswer.join("\n\n")
      });
    }
    pendingPrompt = null;
    pendingAnswer = [];
  }
  for (const r of rows) {
    if (r.type === "user_message" && typeof r.content === "string") {
      flush();
      pendingPrompt = { content: r.content, row: r };
    } else if (r.type === "assistant_message" && typeof r.content === "string" && pendingPrompt) {
      if (r.content.trim().length > 0)
        pendingAnswer.push(r.content);
    }
  }
  flush();
  return pairs;
}

// dist/src/skillify/skill-writer.js
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function assertValidSkillName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`invalid skill name: empty or non-string`);
  }
  if (name.length > 100) {
    throw new Error(`invalid skill name: too long (${name.length} chars)`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid skill name: contains path separator or '..': ${name}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid skill name: must be kebab-case (lowercase a-z, 0-9, hyphen): ${name}`);
  }
}
function skillDir(skillsRoot, name) {
  return join2(skillsRoot, name);
}
function skillPath(skillsRoot, name) {
  return join2(skillDir(skillsRoot, name), "SKILL.md");
}
function renderFrontmatter(fm) {
  const lines = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${JSON.stringify(fm.description)}`);
  if (fm.trigger)
    lines.push(`trigger: ${JSON.stringify(fm.trigger)}`);
  if (fm.author)
    lines.push(`author: ${fm.author}`);
  lines.push(`source_sessions:`);
  for (const s of fm.source_sessions)
    lines.push(`  - ${s}`);
  if (fm.contributors && fm.contributors.length > 0) {
    lines.push(`contributors:`);
    for (const c of fm.contributors)
      lines.push(`  - ${c}`);
  }
  lines.push(`version: ${fm.version}`);
  lines.push(`created_by_agent: ${fm.created_by_agent}`);
  lines.push(`created_at: ${fm.created_at}`);
  lines.push(`updated_at: ${fm.updated_at}`);
  lines.push("---");
  return lines.join("\n");
}
function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n"))
    return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0)
    return null;
  const head = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const fm = { source_sessions: [] };
  let arrayKey = null;
  for (const raw of head.split(/\r?\n/)) {
    if (arrayKey) {
      const m2 = raw.match(/^\s+-\s+(.+)$/);
      if (m2) {
        const arr = fm[arrayKey] ?? [];
        arr.push(m2[1].trim());
        fm[arrayKey] = arr;
        continue;
      }
      arrayKey = null;
    }
    if (raw.startsWith("source_sessions:")) {
      arrayKey = "source_sessions";
      continue;
    }
    if (raw.startsWith("contributors:")) {
      arrayKey = "contributors";
      fm.contributors = [];
      continue;
    }
    const m = raw.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m)
      continue;
    const [, k, v] = m;
    let val = v;
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        val = JSON.parse(v);
      } catch {
      }
    } else if (k === "version") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n))
        val = n;
    }
    fm[k] = val;
  }
  return { fm, body };
}
function writeNewSkill(args) {
  assertValidSkillName(args.name);
  const dir = skillDir(args.skillsRoot, args.name);
  const path = skillPath(args.skillsRoot, args.name);
  if (existsSync(path)) {
    throw new Error(`skill already exists at ${path}; use mergeSkill`);
  }
  mkdirSync(dir, { recursive: true });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const author = args.author && args.author.length > 0 ? args.author : void 0;
  const contributors = author ? [author] : [];
  const fm = {
    name: args.name,
    description: args.description,
    trigger: args.trigger,
    author,
    source_sessions: args.sourceSessions,
    contributors,
    version: 1,
    created_by_agent: args.agent,
    created_at: now,
    updated_at: now
  };
  const text = `${renderFrontmatter(fm)}

${args.body.trim()}
`;
  writeFileSync(path, text);
  return {
    path,
    action: "created",
    version: 1,
    createdAt: now,
    updatedAt: now,
    author,
    contributors
  };
}
function mergeSkill(args) {
  assertValidSkillName(args.name);
  const path = skillPath(args.skillsRoot, args.name);
  if (!existsSync(path)) {
    throw new Error(`skill ${args.name} does not exist at ${path}; use writeNewSkill`);
  }
  const existing = readFileSync(path, "utf-8");
  const parsed = parseFrontmatter(existing);
  const prevVersion = parsed?.fm.version ?? 1;
  const prevSources = parsed?.fm.source_sessions ?? [];
  const merged = Array.from(/* @__PURE__ */ new Set([...prevSources, ...args.newSourceSessions]));
  const author = parsed?.fm.author;
  const prevContribs = parsed?.fm.contributors && parsed.fm.contributors.length > 0 ? parsed.fm.contributors : author ? [author] : [];
  const contributors = [...prevContribs];
  if (args.editor && args.editor.length > 0 && !contributors.includes(args.editor)) {
    contributors.push(args.editor);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const fm = {
    name: args.name,
    description: args.description ?? parsed?.fm.description ?? "",
    trigger: parsed?.fm.trigger,
    author,
    source_sessions: merged,
    contributors,
    version: prevVersion + 1,
    created_by_agent: parsed?.fm.created_by_agent ?? args.agent,
    created_at: parsed?.fm.created_at ?? now,
    updated_at: now
  };
  const text = `${renderFrontmatter(fm)}

${args.body.trim()}
`;
  writeFileSync(path, text);
  return {
    path,
    action: "merged",
    version: fm.version,
    createdAt: fm.created_at,
    updatedAt: fm.updated_at,
    author,
    contributors
  };
}
function listSkills(skillsRoot) {
  if (!existsSync(skillsRoot))
    return [];
  const out = [];
  for (const name of readdirSync(skillsRoot)) {
    const skillFile = join2(skillsRoot, name, "SKILL.md");
    if (existsSync(skillFile) && statSync(skillFile).isFile()) {
      out.push({ name, body: readFileSync(skillFile, "utf-8") });
    }
  }
  return out;
}
function resolveSkillsRoot(install, cwd) {
  if (install === "global") {
    return join2(homedir2(), ".claude", "skills");
  }
  return join2(cwd, ".claude", "skills");
}

// dist/src/skillify/existing-skills.js
function listAllExistingSkills(cwd) {
  const projectRoot = resolveSkillsRoot("project", cwd);
  const globalRoot = resolveSkillsRoot("global", cwd);
  const tag = (source) => (s) => {
    const parsed = parseFrontmatter(s.body);
    const author = typeof parsed?.fm.author === "string" && parsed.fm.author.length > 0 ? parsed.fm.author : void 0;
    return { name: s.name, body: s.body, source, author };
  };
  const tagged = [
    ...listSkills(projectRoot).map(tag("project")),
    ...listSkills(globalRoot).map(tag("global"))
  ];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const s of tagged) {
    if (seen.has(s.name))
      continue;
    seen.add(s.name);
    out.push(s);
  }
  return out;
}
function renderExistingSkillsBlock(cwd, charCap) {
  const skills = listAllExistingSkills(cwd);
  if (skills.length === 0) {
    return {
      mergeTargetNames: [],
      block: "(no existing skills \u2014 MERGE is NOT a valid choice; pick KEEP or SKIP only)"
    };
  }
  let total = 0;
  const out = [];
  const mergeTargetNames = [];
  for (const s of skills) {
    const sourceTag = s.source === "project" ? "project" : "global, read-only";
    const authorTag = s.author ? `, author=${s.author}` : "";
    const block = `--- existing skill [${sourceTag}${authorTag}]: ${s.name} ---
${s.body}
`;
    if (total + block.length > charCap) {
      out.push(`[\u2026${skills.length - out.length} more existing skills omitted]`);
      break;
    }
    out.push(block);
    total += block.length;
    if (s.source === "project")
      mergeTargetNames.push(s.name);
  }
  return { mergeTargetNames, block: out.join("\n") };
}

// dist/src/skillify/skills-table.js
import { randomUUID } from "node:crypto";

// dist/src/utils/sql.js
function sqlIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

// dist/src/skillify/skills-table.js
function createSkillsTableSql(tableName) {
  const safe = sqlIdent(tableName);
  return `CREATE TABLE IF NOT EXISTS "${safe}" (id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', project_key TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '', install TEXT NOT NULL DEFAULT 'project', source_sessions TEXT NOT NULL DEFAULT '[]', source_agent TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'me', author TEXT NOT NULL DEFAULT '', contributors TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', trigger_text TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', version BIGINT NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '') USING deeplake`;
}
function addContributorsColumnSql(tableName) {
  const safe = sqlIdent(tableName);
  return `ALTER TABLE "${safe}" ADD COLUMN IF NOT EXISTS contributors TEXT NOT NULL DEFAULT '[]'`;
}
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function isMissingTableError(message) {
  if (!message)
    return false;
  if (/\bcolumn\b/i.test(message))
    return false;
  return /Table does not exist|relation .* does not exist|no such table/i.test(message);
}
function isMissingContributorsColumnError(message) {
  if (!message)
    return false;
  return /contributors.*(?:does not exist|not found|unknown)/i.test(message) || /(?:does not exist|unknown column).*contributors/i.test(message);
}
async function insertSkillRow(args) {
  const id = args.id ?? randomUUID();
  const sourceSessionsJson = JSON.stringify(args.sourceSessions);
  const contributorsJson = JSON.stringify(args.contributors);
  const sql = `INSERT INTO "${sqlIdent(args.tableName)}" (id, name, project, project_key, local_path, install, source_sessions, source_agent, scope, author, contributors, description, trigger_text, body, version, created_at, updated_at) VALUES ('${esc(id)}', '${esc(args.name)}', '${esc(args.project)}', '${esc(args.projectKey)}', '${esc(args.localPath)}', '${esc(args.install)}', '${esc(sourceSessionsJson)}', '${esc(args.sourceAgent)}', '${esc(args.scope)}', '${esc(args.author)}', '${esc(contributorsJson)}', '${esc(args.description)}', '${esc(args.trigger ?? "")}', '${esc(args.body)}', ${args.version}, '${esc(args.createdAt)}', '${esc(args.updatedAt)}')`;
  try {
    await args.query(sql);
  } catch (e) {
    if (isMissingTableError(e?.message)) {
      await args.query(createSkillsTableSql(args.tableName));
      await args.query(sql);
      return;
    }
    if (isMissingContributorsColumnError(e?.message)) {
      await args.query(addContributorsColumnSql(args.tableName));
      await args.query(sql);
      return;
    }
    throw e;
  }
}

// dist/src/skillify/gate-parser.js
function extractJsonBlock(s) {
  const trimmed = s.trim();
  if (!trimmed)
    return null;
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced)
    return fenced[1].trim();
  const start = trimmed.indexOf("{");
  if (start < 0)
    return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "{")
      depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0)
        return trimmed.slice(start, i + 1);
    }
  }
  return null;
}
function parseVerdict(raw) {
  const block = extractJsonBlock(raw);
  if (!block)
    return null;
  try {
    const v = JSON.parse(block);
    if (v.verdict !== "KEEP" && v.verdict !== "SKIP" && v.verdict !== "MERGE")
      return null;
    return v;
  } catch {
    return null;
  }
}

// dist/src/skillify/gate-runner.js
import { existsSync as existsSync2 } from "node:fs";
import { createRequire } from "node:module";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
var requireForCp = createRequire(import.meta.url);
var { execFileSync: runChildProcess } = requireForCp("node:child_process");
var inheritedEnv = process;
function firstExistingPath(candidates) {
  for (const c of candidates) {
    if (existsSync2(c))
      return c;
  }
  return null;
}
function findAgentBin(agent) {
  const home = homedir3();
  switch (agent) {
    // /usr/bin/<name> is included in every candidate list — that's the
    // common Linux package-manager install path (apt, dnf, pacman). Old
    // code used `which` which always checked it; the static-scan fix
    // dropped `which`, so /usr/bin needs to be explicit. CodeRabbit on
    // #170 caught the gap.
    case "claude_code":
      return firstExistingPath([
        join3(home, ".claude", "local", "claude"),
        "/usr/local/bin/claude",
        "/usr/bin/claude",
        join3(home, ".npm-global", "bin", "claude"),
        join3(home, ".local", "bin", "claude"),
        "/opt/homebrew/bin/claude"
      ]) ?? join3(home, ".claude", "local", "claude");
    case "codex":
      return firstExistingPath([
        "/usr/local/bin/codex",
        "/usr/bin/codex",
        join3(home, ".npm-global", "bin", "codex"),
        join3(home, ".local", "bin", "codex"),
        "/opt/homebrew/bin/codex"
      ]) ?? "/usr/local/bin/codex";
    case "cursor":
      return firstExistingPath([
        "/usr/local/bin/cursor-agent",
        "/usr/bin/cursor-agent",
        join3(home, ".npm-global", "bin", "cursor-agent"),
        join3(home, ".local", "bin", "cursor-agent"),
        "/opt/homebrew/bin/cursor-agent"
      ]) ?? "/usr/local/bin/cursor-agent";
    case "hermes":
      return firstExistingPath([
        join3(home, ".local", "bin", "hermes"),
        "/usr/local/bin/hermes",
        "/usr/bin/hermes",
        join3(home, ".npm-global", "bin", "hermes"),
        "/opt/homebrew/bin/hermes"
      ]) ?? join3(home, ".local", "bin", "hermes");
    case "pi":
      return firstExistingPath([
        join3(home, ".local", "bin", "pi"),
        "/usr/local/bin/pi",
        "/usr/bin/pi",
        join3(home, ".npm-global", "bin", "pi"),
        "/opt/homebrew/bin/pi"
      ]) ?? join3(home, ".local", "bin", "pi");
  }
}
function buildArgs(agent, prompt, opts) {
  switch (agent) {
    case "claude_code":
      return [
        "-p",
        prompt,
        "--no-session-persistence",
        "--model",
        "haiku",
        "--permission-mode",
        "bypassPermissions"
      ];
    case "codex":
      return [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt
      ];
    case "cursor":
      return [
        "--print",
        "--model",
        opts.cursorModel ?? process.env.HIVEMIND_CURSOR_MODEL ?? "auto",
        "--force",
        "--output-format",
        "text",
        prompt
      ];
    case "hermes":
      return [
        "-z",
        prompt,
        "--provider",
        opts.hermesProvider ?? process.env.HIVEMIND_HERMES_PROVIDER ?? "openrouter",
        "-m",
        opts.hermesModel ?? process.env.HIVEMIND_HERMES_MODEL ?? "anthropic/claude-haiku-4-5",
        "--yolo",
        "--ignore-user-config"
      ];
    case "pi":
      return [
        "--print",
        "--provider",
        opts.piProvider ?? process.env.HIVEMIND_PI_PROVIDER ?? "google",
        "--model",
        opts.piModel ?? process.env.HIVEMIND_PI_MODEL ?? "gemini-2.5-flash",
        prompt
      ];
  }
}
function runGate(opts) {
  const bin = opts.bin ?? findAgentBin(opts.agent);
  if (!existsSync2(bin)) {
    return {
      stdout: "",
      stderr: "",
      errored: true,
      errorMessage: `agent binary not found at ${bin} (agent=${opts.agent})`
    };
  }
  const args = buildArgs(opts.agent, opts.prompt, opts);
  try {
    const result = runChildProcess(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? 12e4,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...inheritedEnv.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" }
    });
    return { stdout: result.toString("utf-8"), stderr: "", errored: false };
  } catch (e) {
    return {
      stdout: e.stdout?.toString("utf-8") ?? "",
      stderr: e.stderr?.toString("utf-8") ?? "",
      errored: true,
      errorMessage: `${opts.agent} CLI failed: ${e.status ?? e.code ?? e.message}`
    };
  }
}

// dist/src/skillify/scope-promotion.js
function isCrossAuthorMergeVerdict(args) {
  return args.verdict === "MERGE" && args.resultAuthor !== void 0 && args.resultAuthor !== args.userName;
}
function resolveRecordScope(args) {
  return args.isCrossAuthorMerge && args.configScope === "me" ? "team" : args.configScope;
}

// dist/src/skillify/state.js
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, writeSync, mkdirSync as mkdirSync2, renameSync as renameSync2, rmdirSync, existsSync as existsSync4, lstatSync, unlinkSync, openSync, closeSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join as join6, basename } from "node:path";

// dist/src/skillify/legacy-migration.js
import { existsSync as existsSync3, renameSync } from "node:fs";
import { dirname, join as join5 } from "node:path";

// dist/src/skillify/state-dir.js
import { homedir as homedir4 } from "node:os";
import { join as join4 } from "node:path";
function getStateDir() {
  const override = process.env.HIVEMIND_STATE_DIR?.trim();
  return override && override.length > 0 ? override : join4(homedir4(), ".deeplake", "state", "skillify");
}

// dist/src/skillify/legacy-migration.js
var dlog = (msg) => log("skillify-migrate", msg);
var attemptedFor = /* @__PURE__ */ new Set();
function migrateLegacyStateDir() {
  if (process.env.HIVEMIND_STATE_DIR?.trim())
    return;
  const current = getStateDir();
  if (attemptedFor.has(current))
    return;
  attemptedFor.add(current);
  const legacy = join5(dirname(current), "skilify");
  if (!existsSync3(legacy))
    return;
  if (existsSync3(current))
    return;
  try {
    renameSync(legacy, current);
    dlog(`migrated ${legacy} -> ${current}`);
  } catch (err) {
    const code = err.code;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      dlog(`migration skipped (${code}); legacy dir left as-is or another process handled it`);
      return;
    }
    throw err;
  }
}

// dist/src/skillify/state.js
var dlog2 = (msg) => log("skillify-state", msg);
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
var TRIGGER_THRESHOLD = (() => {
  const n = Number(process.env.HIVEMIND_SKILLIFY_EVERY_N_TURNS ?? "");
  return Number.isInteger(n) && n > 0 ? n : 20;
})();
function statePath(projectKey) {
  return join6(getStateDir(), `${projectKey}.json`);
}
function lockPath(projectKey) {
  return join6(getStateDir(), `${projectKey}.lock`);
}
function readState(projectKey) {
  migrateLegacyStateDir();
  const p = statePath(projectKey);
  if (!existsSync4(p))
    return null;
  try {
    return JSON.parse(readFileSync2(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(projectKey, state) {
  migrateLegacyStateDir();
  mkdirSync2(getStateDir(), { recursive: true });
  const p = statePath(projectKey);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync2(tmp, JSON.stringify(state, null, 2));
  renameSync2(tmp, p);
}
function withRmwLock(projectKey, fn) {
  migrateLegacyStateDir();
  mkdirSync2(getStateDir(), { recursive: true });
  const rmw = lockPath(projectKey) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(rmw, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        dlog2(`rmw lock deadline exceeded for ${projectKey}, reclaiming stale lock`);
        try {
          unlinkSync(rmw);
        } catch (unlinkErr) {
          dlog2(`stale rmw lock unlink failed for ${projectKey}: ${unlinkErr.message}`);
        }
        continue;
      }
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(rmw);
    } catch (unlinkErr) {
      dlog2(`rmw lock cleanup failed for ${projectKey}: ${unlinkErr.message}`);
    }
  }
}
function recordSkill(projectKey, skillName, newestSessionUuid, newestSessionDate) {
  withRmwLock(projectKey, () => {
    const s = readState(projectKey);
    if (!s)
      return;
    const skills = s.skillsGenerated.includes(skillName) ? s.skillsGenerated : [...s.skillsGenerated, skillName];
    writeState(projectKey, {
      ...s,
      skillsGenerated: skills,
      lastUuid: newestSessionUuid,
      lastDate: newestSessionDate,
      updatedAt: Date.now()
    });
  });
}
function advanceWatermark(projectKey, newestSessionUuid, newestSessionDate) {
  withRmwLock(projectKey, () => {
    const s = readState(projectKey);
    if (!s)
      return;
    writeState(projectKey, {
      ...s,
      lastUuid: newestSessionUuid,
      lastDate: newestSessionDate,
      updatedAt: Date.now()
    });
  });
}
function releaseWorkerLock(projectKey) {
  const p = lockPath(projectKey);
  try {
    unlinkSync(p);
  } catch {
  }
}

// dist/src/skillify/skillify-worker.js
var cfg = JSON.parse(readFileSync3(process.argv[2], "utf-8"));
globalThis.__hivemind_tuning__ = cfg.tuning ?? {};
var tmpDir = cfg.tmpDir;
var verdictPath = join7(tmpDir, "verdict.json");
var promptPath = join7(tmpDir, "prompt.txt");
var SESSIONS_TO_MINE = 10;
var PAIR_CHAR_CAP = 2e3;
var TOTAL_PAIRS_CHAR_CAP = 4e4;
var EXISTING_SKILLS_CHAR_CAP = 3e4;
function wlog(msg) {
  try {
    appendFileSync2(cfg.skillifyLog, `[${utcTimestamp()}] skillify-worker(${cfg.projectKey}): ${msg}
`);
  } catch {
  }
}
function esc2(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
var QUERY_TIMEOUT_MS = 3e4;
async function query(sql, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetch(`${cfg.apiUrl}/workspaces/${cfg.workspaceId}/tables/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
          "X-Activeloop-Org-Id": cfg.orgId,
          ...deeplakeClientHeader()
        },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        body: JSON.stringify({ query: sql })
      });
    } catch (e) {
      if (attempt < retries) {
        const base = Math.min(3e4, 2e3 * Math.pow(2, attempt));
        const delay = base + Math.floor(Math.random() * 1e3);
        wlog(`fetch failed (${e?.name ?? e?.code ?? e?.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw e;
    }
    if (r.ok) {
      const j = await r.json();
      if (!j.columns || !j.rows)
        return [];
      return j.rows.map((row) => Object.fromEntries(j.columns.map((col, i) => [col, row[i]])));
    }
    const retryable = r.status === 401 || r.status === 403 || r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503;
    if (attempt < retries && retryable) {
      const base = Math.min(3e4, 2e3 * Math.pow(2, attempt));
      const delay = base + Math.floor(Math.random() * 1e3);
      wlog(`API ${r.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return [];
}
function authorClause() {
  if (cfg.scope === "team" && cfg.team.length > 0) {
    const list = cfg.team.map((n) => `'${esc2(n)}'`).join(", ");
    return ` AND author IN (${list})`;
  }
  return ` AND author = '${esc2(cfg.userName)}'`;
}
async function listCandidateSessions(lastDate) {
  const dateClause = lastDate ? ` AND creation_date > '${esc2(lastDate)}'` : "";
  const sql = `SELECT path, MAX(creation_date) AS last_msg FROM "${cfg.sessionsTable}" WHERE project = '${esc2(cfg.project)}'${authorClause()}${dateClause} GROUP BY path ORDER BY last_msg DESC LIMIT ${SESSIONS_TO_MINE * 2}`;
  const rows = await query(sql);
  return rows.map((r) => ({ path: String(r.path ?? ""), lastMsg: String(r.last_msg ?? "") })).filter((r) => r.path.length > 0);
}
function isCurrentSession(path) {
  return cfg.currentSessionId ? path.includes(cfg.currentSessionId) : false;
}
async function fetchSessionRows(path) {
  const rows = await query(`SELECT message, creation_date, agent FROM "${cfg.sessionsTable}" WHERE path = '${esc2(path)}' ORDER BY creation_date ASC`);
  const sessionId = (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
  return rows.map((r) => {
    const m = r.message;
    const parsed = typeof m === "string" ? safeJsonParse(m) : m ?? {};
    return {
      type: typeof parsed.type === "string" ? parsed.type : void 0,
      content: typeof parsed.content === "string" ? parsed.content : void 0,
      creation_date: r.creation_date,
      session_id: sessionId,
      agent: r.agent
    };
  });
}
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
function truncate(s, max) {
  if (s.length <= max)
    return s;
  return s.slice(0, max) + `
[\u2026truncated ${s.length - max} chars]`;
}
function renderPairsBlock(pairs) {
  let total = 0;
  const out = [];
  for (const [i, p] of pairs.entries()) {
    const prompt = truncate(p.prompt, PAIR_CHAR_CAP);
    const answer = truncate(p.answer, PAIR_CHAR_CAP);
    const block = `--- exchange ${i + 1} (session ${p.sessionId.slice(0, 8)}, agent ${p.agent ?? "?"}) ---
USER:
${prompt}

ASSISTANT:
${answer}
`;
    if (total + block.length > TOTAL_PAIRS_CHAR_CAP) {
      out.push(`[\u2026${pairs.length - i} more exchanges omitted to stay under prompt budget]`);
      break;
    }
    out.push(block);
    total += block.length;
  }
  return out.join("\n");
}
function buildPrompt(pairs) {
  const existing = renderExistingSkillsBlock(cfg.cwd, EXISTING_SKILLS_CHAR_CAP);
  const mergeTargetsClause = existing.mergeTargetNames.length > 0 ? `MERGE is allowed only if your "name" is EXACTLY one of: [${existing.mergeTargetNames.join(", ")}]. Any other name MUST use KEEP, not MERGE.` : `MERGE is FORBIDDEN \u2014 there are no existing skills to merge into. Use KEEP or SKIP only.`;
  return [
    `You are a skill curator for the "${cfg.project}" project. You decide whether the recent`,
    `agent activity below contains a recurring, non-trivial pattern worth crystallizing as a`,
    `reusable skill, and whether to create a new skill or merge into an existing one.`,
    ``,
    `RULES:`,
    `- KEEP only if the pattern recurs across at least 3 of the exchanges, is non-obvious to a`,
    `  competent engineer, and is not already covered by an existing skill below.`,
    `- SKIP if the activity is one-off, generic engineering work, or already covered.`,
    `- MERGE if the pattern is a meaningful extension of an existing skill \u2014 produce a`,
    `  merged body that incorporates the new evidence without exceeding ~3000 characters or`,
    `  covering unrelated domains.`,
    `- ${mergeTargetsClause}`,
    `- Cross-author MERGE has a real cost: editing a skill authored by someone else is`,
    `  recorded as a team-level edit (scope=team, contributors+="${cfg.userName}"). Use it only`,
    `  when the new evidence genuinely extends the existing skill; otherwise pick KEEP or SKIP.`,
    `  Tags like [project, author=alice] / [global, author=bob] tell you whose skill it is.`,
    `- Skill bodies should follow the existing style: short sections (When to use, Workflow,`,
    `  Anti-patterns), concrete commands and file paths drawn from the exchanges, no marketing.`,
    ``,
    `=== EXISTING SKILLS (all MERGE-eligible; [global, author=X] entries from teammate X mean`,
    `cross-author MERGE auto-promotes scope to team) ===`,
    existing.block,
    ``,
    `=== RECENT EXCHANGES (prompt + answer pairs, tool calls already stripped) ===`,
    renderPairsBlock(pairs),
    ``,
    `=== YOUR TASK ===`,
    `Output your decision as a single JSON object. The worker will parse it.`,
    `You may either:`,
    `  (a) Write the JSON to this exact path using the Write tool: ${verdictPath}`,
    `  (b) Print the JSON object to stdout (your final message), nothing else.`,
    `Either path works; pick whichever you prefer. Do not do both.`,
    ``,
    `The JSON MUST have this shape:`,
    `{`,
    `  "verdict": "KEEP" | "SKIP" | "MERGE",`,
    `  "name": "<kebab-case skill name; for MERGE, the existing skill name>",`,
    `  "description": "<one-line>",`,
    `  "trigger": "<short trigger description, optional>",`,
    `  "body": "<full SKILL.md body WITHOUT frontmatter; KEEP and MERGE only>",`,
    `  "reason": "<one-line justification>"`,
    `}`,
    ``,
    `For SKIP, only "verdict" and "reason" are required.`,
    `If you print to stdout, do not include any prose before or after the JSON.`,
    `Do not write any other files.`
  ].join("\n");
}
function readVerdict(stdout) {
  if (existsSync5(verdictPath)) {
    try {
      const text = readFileSync3(verdictPath, "utf-8");
      const v2 = parseVerdict(text);
      if (v2)
        return { verdict: v2, source: "file" };
      return { verdict: null, source: `file-unparseable (${text.length} chars)` };
    } catch (e) {
      return { verdict: null, source: `file-read-error: ${e.message}` };
    }
  }
  const v = parseVerdict(stdout);
  if (v)
    return { verdict: v, source: "stdout" };
  return { verdict: null, source: `no-file-no-stdout-json (stdout=${stdout.length} chars)` };
}
function cleanup(keep) {
  if (keep) {
    wlog(`keeping tmpDir for inspection: ${tmpDir}`);
    return;
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    wlog(`cleanup failed: ${e.message}`);
  }
}
var keepTmpForInspection = false;
async function main() {
  try {
    const state = readState(cfg.projectKey);
    const lastDate = state?.lastDate ?? null;
    wlog(`fetching candidate sessions (scope=${cfg.scope}, lastDate=${lastDate ?? "none"})`);
    const candidates = await listCandidateSessions(lastDate);
    const usable = candidates.filter((c) => !isCurrentSession(c.path)).slice(0, SESSIONS_TO_MINE);
    if (usable.length === 0) {
      wlog("no new sessions to mine \u2014 done");
      return;
    }
    wlog(`mining ${usable.length} sessions`);
    const allPairs = [];
    for (const c of usable) {
      const rows = await fetchSessionRows(c.path);
      const pairs = extractPairs(rows);
      allPairs.push(...pairs);
    }
    if (allPairs.length === 0) {
      wlog("no prompt/answer pairs after extraction \u2014 advancing watermark and exiting");
      const oldest2 = usable[usable.length - 1];
      advanceWatermark(cfg.projectKey, oldest2.path, oldest2.lastMsg);
      return;
    }
    wlog(`extracted ${allPairs.length} pairs across ${usable.length} sessions`);
    const prompt = buildPrompt(allPairs);
    writeFileSync3(promptPath, prompt);
    const gateAgent = cfg.gateAgent ?? cfg.agent;
    wlog(`running gate (agent=${cfg.agent}, gateAgent=${gateAgent}, bin=${cfg.gateBin}, prompt=${prompt.length} chars)`);
    const gate = runGate({
      agent: gateAgent,
      prompt,
      bin: cfg.gateBin,
      cursorModel: cfg.cursorModel,
      hermesProvider: cfg.hermesProvider,
      hermesModel: cfg.hermesModel,
      piProvider: cfg.piProvider,
      piModel: cfg.piModel,
      timeoutMs: 12e4
    });
    try {
      writeFileSync3(join7(tmpDir, "gate-stdout.txt"), gate.stdout);
      if (gate.stderr)
        writeFileSync3(join7(tmpDir, "gate-stderr.txt"), gate.stderr);
    } catch {
    }
    if (gate.errored) {
      wlog(`gate failed: ${gate.errorMessage} (stdout=${gate.stdout.length}, stderr=${gate.stderr.length})`);
      return;
    }
    wlog(`gate exited (code 0, stdout=${gate.stdout.length} chars)`);
    const { verdict, source } = readVerdict(gate.stdout);
    if (!verdict) {
      wlog(`no parseable verdict (${source}) \u2014 treating as SKIP, advancing watermark`);
      keepTmpForInspection = true;
      const oldest2 = usable[usable.length - 1];
      advanceWatermark(cfg.projectKey, oldest2.path, oldest2.lastMsg);
      return;
    }
    wlog(`verdict source: ${source}`);
    wlog(`verdict=${verdict.verdict} name=${verdict.name ?? "-"} reason=${verdict.reason ?? "-"}`);
    const oldest = usable[usable.length - 1];
    const watermarkUuid = (oldest.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    const watermarkDate = oldest.lastMsg;
    const sourceSessions = usable.map((c) => (c.path.split("/").pop() ?? "").replace(/\.[^.]+$/, ""));
    async function recordToDeeplake(result, verdict2) {
      const author = result.author ?? cfg.userName;
      const isCrossAuthorMerge = isCrossAuthorMergeVerdict({
        verdict: verdict2.verdict,
        resultAuthor: result.author,
        userName: cfg.userName
      });
      const scope = resolveRecordScope({
        configScope: cfg.scope,
        isCrossAuthorMerge
      });
      const contributors = result.contributors;
      try {
        await insertSkillRow({
          query,
          tableName: cfg.skillsTable,
          name: verdict2.name,
          project: cfg.project,
          projectKey: cfg.projectKey,
          localPath: result.path,
          install: cfg.install,
          sourceSessions,
          sourceAgent: cfg.agent,
          scope,
          author,
          contributors,
          description: verdict2.description ?? "",
          trigger: verdict2.trigger,
          body: verdict2.body,
          version: result.version,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt
        });
        wlog(`recorded to skills table: name=${verdict2.name} v${result.version} author=${author} scope=${scope} contributors=${contributors.length}` + (isCrossAuthorMerge ? " [auto-promoted me->team]" : ""));
      } catch (e) {
        wlog(`skills table insert failed (non-fatal): ${e.message}`);
      }
    }
    if (verdict.verdict === "KEEP" && verdict.name && verdict.body) {
      try {
        const result = writeNewSkill({
          skillsRoot: resolveSkillsRoot(cfg.install, cfg.cwd),
          name: verdict.name,
          description: verdict.description ?? "",
          trigger: verdict.trigger,
          body: verdict.body,
          sourceSessions,
          agent: cfg.agent,
          author: cfg.userName
        });
        wlog(`wrote new skill: ${result.path}`);
        recordSkill(cfg.projectKey, verdict.name, watermarkUuid, watermarkDate);
        await recordToDeeplake(result, verdict);
      } catch (e) {
        wlog(`writeNewSkill failed: ${e.message}`);
        advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
      }
    } else if (verdict.verdict === "MERGE" && verdict.name && verdict.body) {
      try {
        const result = mergeSkill({
          skillsRoot: resolveSkillsRoot(cfg.install, cfg.cwd),
          name: verdict.name,
          description: verdict.description,
          body: verdict.body,
          newSourceSessions: sourceSessions,
          agent: cfg.agent,
          editor: cfg.userName
        });
        wlog(`merged into skill: ${result.path} (v${result.version})`);
        recordSkill(cfg.projectKey, verdict.name, watermarkUuid, watermarkDate);
        await recordToDeeplake(result, verdict);
      } catch (e) {
        if (/does not exist/i.test(e.message ?? "")) {
          wlog(`mergeSkill target missing \u2014 falling back to writeNewSkill: ${verdict.name}`);
          try {
            const result = writeNewSkill({
              skillsRoot: resolveSkillsRoot(cfg.install, cfg.cwd),
              name: verdict.name,
              description: verdict.description ?? "",
              trigger: verdict.trigger,
              body: verdict.body,
              sourceSessions,
              agent: cfg.agent,
              author: cfg.userName
            });
            wlog(`wrote new skill (merge fallback): ${result.path}`);
            recordSkill(cfg.projectKey, verdict.name, watermarkUuid, watermarkDate);
            await recordToDeeplake(result, verdict);
          } catch (e2) {
            wlog(`writeNewSkill fallback also failed: ${e2.message}`);
            advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
          }
        } else {
          wlog(`mergeSkill failed: ${e.message}`);
          advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
        }
      }
    } else {
      advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
    }
  } catch (e) {
    wlog(`fatal: ${e.message}`);
  } finally {
    cleanup(keepTmpForInspection);
    try {
      releaseWorkerLock(cfg.projectKey);
    } catch (e) {
      wlog(`releaseWorkerLock failed: ${e.message}`);
    }
  }
}
main();
