#!/usr/bin/env node

// dist/src/commands/auth.js
import { execSync } from "node:child_process";

// dist/src/commands/auth-creds.js
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
function configDir() {
  return join(homedir(), ".deeplake");
}
function credsPath() {
  return join(configDir(), "credentials.json");
}
function loadCredentials() {
  try {
    return JSON.parse(readFileSync(credsPath(), "utf-8"));
  } catch {
    return null;
  }
}

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve3, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve3(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// dist/src/notifications/rules/registry.js
var RULES = [];
function registerRule(rule) {
  if (RULES.find((r) => r.id === rule.id)) {
    throw new Error(`duplicate rule id: ${rule.id}`);
  }
  RULES.push(rule);
}
function evaluateRules(trigger, ctx) {
  const out = [];
  for (const r of RULES) {
    if (r.trigger !== trigger)
      continue;
    const result = r.evaluate(ctx);
    if (result)
      out.push(result);
  }
  return out;
}

// dist/src/notifications/queue.js
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync, mkdirSync as mkdirSync2, openSync, closeSync, unlinkSync as unlinkSync2, statSync } from "node:fs";
import { join as join3, resolve } from "node:path";
import { homedir as homedir3 } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function isDebug() {
  return process.env.HIVEMIND_DEBUG === "1";
}
function log(tag, msg) {
  if (!isDebug())
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/notifications/queue.js
var log2 = (msg) => log("notifications-queue", msg);
function queuePath() {
  return join3(homedir3(), ".deeplake", "notifications-queue.json");
}
function readQueue() {
  try {
    const raw = readFileSync2(queuePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.queue)) {
      log2(`queue malformed \u2192 treating as empty`);
      return { queue: [] };
    }
    return { queue: parsed.queue };
  } catch {
    return { queue: [] };
  }
}
function _isQueuePathInsideHome(path, home) {
  const r = resolve(path);
  const h = resolve(home);
  return r.startsWith(h + "/") || r === h;
}
function writeQueue(q) {
  const path = queuePath();
  const home = resolve(homedir3());
  if (!_isQueuePathInsideHome(path, home)) {
    throw new Error(`notifications-queue write blocked: ${path} is outside ${home}`);
  }
  mkdirSync2(join3(home, ".deeplake"), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync2(tmp, JSON.stringify(q, null, 2), { mode: 384 });
  renameSync(tmp, path);
}

// dist/src/notifications/state.js
import { closeSync as closeSync2, mkdirSync as mkdirSync3, openSync as openSync2, readFileSync as readFileSync3, renameSync as renameSync2, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { createHash } from "node:crypto";
import { join as join4, resolve as resolve2 } from "node:path";
import { homedir as homedir4 } from "node:os";
var log3 = (msg) => log("notifications-state", msg);
function statePath() {
  return join4(homedir4(), ".deeplake", "notifications-state.json");
}
function readState() {
  try {
    const raw = readFileSync3(statePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.shown !== "object") {
      log3(`state malformed \u2192 treating as empty`);
      return { shown: {} };
    }
    return { shown: { ...parsed.shown } };
  } catch {
    return { shown: {} };
  }
}
function writeState(state) {
  const path = statePath();
  const home = resolve2(homedir4());
  if (!resolve2(path).startsWith(home + "/") && resolve2(path) !== home) {
    throw new Error(`notifications-state write blocked: ${path} is outside ${home}`);
  }
  mkdirSync3(join4(home, ".deeplake"), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync3(tmp, JSON.stringify(state, null, 2), { mode: 384 });
  renameSync2(tmp, path);
}
function markShown(state, n, now = /* @__PURE__ */ new Date()) {
  return {
    shown: {
      ...state.shown,
      [n.id]: { dedupKey: JSON.stringify(n.dedupKey), shownAt: now.toISOString() }
    }
  };
}
function alreadyShown(state, n) {
  const prev = state.shown[n.id];
  if (!prev)
    return false;
  return prev.dedupKey === JSON.stringify(n.dedupKey);
}
function tryClaim(n) {
  const home = resolve2(homedir4());
  const claimsDir = join4(home, ".deeplake", "notifications-claims");
  try {
    mkdirSync3(claimsDir, { recursive: true, mode: 448 });
  } catch (e) {
    log3(`tryClaim mkdir failed: ${e?.message ?? String(e)}`);
    return true;
  }
  const claimPath = claimPathFor(claimsDir, n);
  try {
    const fd = openSync2(claimPath, "wx", 384);
    closeSync2(fd);
    return true;
  } catch (e) {
    if (e?.code === "EEXIST")
      return false;
    log3(`tryClaim open failed: ${e?.message ?? String(e)}`);
    return true;
  }
}
function releaseClaim(n) {
  const home = resolve2(homedir4());
  const claimsDir = join4(home, ".deeplake", "notifications-claims");
  const claimPath = claimPathFor(claimsDir, n);
  try {
    unlinkSync3(claimPath);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      log3(`releaseClaim unlink failed: ${e?.message ?? String(e)}`);
    }
  }
}
function claimPathFor(claimsDir, n) {
  const keyHash = createHash("sha256").update(JSON.stringify(n.dedupKey)).digest("hex").slice(0, 12);
  const safeId = n.id.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return join4(claimsDir, `${safeId}-${keyHash}`);
}

// dist/src/notifications/format.js
var SEVERITY_PREFIX = {
  info: "\u{1F41D}",
  warn: "\u26A0\uFE0F",
  error: "\u{1F6A8}"
};
function renderOne(n) {
  const prefix = SEVERITY_PREFIX[n.severity ?? "info"] ?? SEVERITY_PREFIX.info;
  return `${prefix} ${n.title}
${n.body}`;
}
function renderNotifications(items) {
  if (items.length === 0)
    return "";
  return items.map(renderOne).join("\n\n");
}

// dist/src/notifications/delivery/claude-code.js
function emitClaudeCode(rendered) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: rendered
    },
    systemMessage: rendered
  }));
}

// dist/src/notifications/delivery/index.js
var ADAPTERS = {
  "claude-code": emitClaudeCode
};
function emit(agent, rendered) {
  if (!rendered)
    return;
  ADAPTERS[agent](rendered);
}

// dist/src/notifications/sources/backend.js
var log4 = (msg) => log("notifications-backend", msg);
var FETCH_TIMEOUT_MS = 1500;
var DEFAULT_API_URL = "https://api.deeplake.ai";
var ALLOWED_SEVERITIES = /* @__PURE__ */ new Set(["info", "warn", "error"]);
function normalizeSeverity(s) {
  return typeof s === "string" && ALLOWED_SEVERITIES.has(s) ? s : "info";
}
function toClient(n) {
  if (!n.id || typeof n.id !== "string")
    return null;
  if (!n.title || typeof n.title !== "string")
    return null;
  if (!n.body || typeof n.body !== "string")
    return null;
  return {
    // Prefix with `backend:` so a future local-only rule can never collide
    // with a server-issued id, even if both happen to use the same string.
    id: `backend:${n.id}`,
    severity: normalizeSeverity(n.severity),
    title: n.title,
    body: n.body,
    // dedupKey wraps server fields the client cares about. The server's
    // dedup_key is hashed in here so a server that reuses the same UUID
    // with a fresh dedup_key (rare but supported) re-fires for the user.
    dedupKey: { id: n.id, dedup_key: n.dedup_key ?? "" }
  };
}
async function fetchBackendNotifications(creds) {
  if (!creds?.token)
    return [];
  const apiUrl = creds.apiUrl ?? DEFAULT_API_URL;
  const url = `${apiUrl}/me/notifications`;
  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        ...creds.orgId ? { "X-Activeloop-Org-Id": creds.orgId } : {}
      },
      signal: ctrl.signal
    });
    if (!resp.ok) {
      log4(`fetch ${url} returned ${resp.status}`);
      return [];
    }
    const body = await resp.json();
    if (!body || !Array.isArray(body.notifications)) {
      log4(`fetch ${url} returned malformed body`);
      return [];
    }
    const out = [];
    for (const sn of body.notifications) {
      const c = toClient(sn);
      if (c)
        out.push(c);
    }
    log4(`fetched ${out.length} backend notification(s) from ${apiUrl}`);
    return out;
  } catch (e) {
    log4(`fetch ${url} failed: ${e?.message ?? String(e)}`);
    return [];
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// dist/src/notifications/usage-tracker.js
import { appendFileSync as appendFileSync2, existsSync, mkdirSync as mkdirSync4, readFileSync as readFileSync4, readdirSync } from "node:fs";
import { dirname, join as join5 } from "node:path";
import { homedir as homedir5 } from "node:os";
var log5 = (msg) => log("usage-tracker", msg);
function statsFilePath() {
  return join5(homedir5(), ".deeplake", "usage-stats.jsonl");
}
function readUsageRecords() {
  try {
    if (!existsSync(statsFilePath()))
      return [];
    const raw = readFileSync4(statsFilePath(), "utf-8");
    const out = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed)
        continue;
      try {
        const rec = JSON.parse(trimmed);
        if (typeof rec.endedAt === "string" && typeof rec.sessionId === "string") {
          out.push({
            endedAt: rec.endedAt,
            sessionId: rec.sessionId,
            memorySearchBytes: typeof rec.memorySearchBytes === "number" ? rec.memorySearchBytes : 0,
            memorySearchCount: typeof rec.memorySearchCount === "number" ? rec.memorySearchCount : 0
          });
        }
      } catch {
      }
    }
    return out;
  } catch (e) {
    log5(`readUsageRecords failed: ${e?.message ?? String(e)}`);
    return [];
  }
}
function sumMetric(records, key) {
  let total = 0;
  for (const r of records) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v))
      total += v;
  }
  return total;
}
function countUserGeneratedSkills(userName) {
  if (!userName)
    return 0;
  const dir = join5(homedir5(), ".claude", "skills");
  if (!existsSync(dir))
    return 0;
  const suffix = `--${userName}`;
  try {
    let count = 0;
    for (const name of readdirSync(dir)) {
      const idx = name.lastIndexOf(suffix);
      if (idx > 0 && idx + suffix.length === name.length)
        count += 1;
    }
    return count;
  } catch (e) {
    log5(`countUserGeneratedSkills readdir failed: ${e?.message ?? String(e)}`);
    return 0;
  }
}

// dist/src/notifications/sources/local-usage.js
var log6 = (msg) => log("notifications-local-usage", msg);
var BYTES_PER_TOKEN = 4;
var SAVINGS_MULTIPLIER = 1.7;
function minSessionsForRecap() {
  const raw = process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0)
      return n;
  }
  return 100;
}
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0)
    return "0";
  if (n < 1e3)
    return `${Math.round(n)}`;
  if (n < 1e5)
    return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e6)
    return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
function fetchLocalUsageNotifications(sessionId, userName) {
  if (!sessionId) {
    return [];
  }
  let records;
  try {
    records = readUsageRecords();
  } catch (e) {
    log6(`readUsageRecords threw: ${e?.message ?? String(e)}`);
    return [];
  }
  if (records.length === 0) {
    log6("no usage records yet \u2014 skipping recap");
    return [];
  }
  const minSessions = minSessionsForRecap();
  if (records.length < minSessions) {
    log6(`only ${records.length} sessions, threshold is ${minSessions} \u2014 skipping recap`);
    return [];
  }
  const memorySearchBytes = sumMetric(records, "memorySearchBytes");
  if (memorySearchBytes <= 0) {
    log6("memorySearchBytes total is 0 \u2014 skipping recap");
    return [];
  }
  const yTokens = memorySearchBytes / BYTES_PER_TOKEN;
  const zTokens = (SAVINGS_MULTIPLIER - 1) * yTokens;
  const sessionCount = records.length;
  const memorySearches = sumMetric(records, "memorySearchCount");
  const skillsGenerated = countUserGeneratedSkills(userName);
  const title = `Hivemind has saved you ~${formatTokens(zTokens)} tokens`;
  const segments = [
    `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`,
    `${memorySearches} memory ${memorySearches === 1 ? "search" : "searches"}`
  ];
  if (skillsGenerated > 0) {
    segments.push(`${skillsGenerated} ${skillsGenerated === 1 ? "skill" : "skills"} generated`);
  }
  const body = `   ${segments.join(" \xB7 ")}`;
  return [
    {
      id: "local-usage:savings-recap",
      severity: "info",
      title,
      body,
      // dedupKey on sessionId: same session's parallel hook fires dedupe;
      // new sessions get fresh numbers.
      dedupKey: { session: sessionId }
    }
  ];
}

// dist/src/notifications/index.js
var log7 = (msg) => log("notifications", msg);
async function drainSessionStart(opts) {
  try {
    const state = readState();
    const queue = readQueue();
    const ctx = {
      agent: opts.agent,
      creds: opts.creds,
      state,
      localSkillsCount: opts.localSkillsCount ?? null
    };
    const fromRules = evaluateRules("session_start", ctx);
    const fromQueue = queue.queue;
    const fromBackend = await fetchBackendNotifications(opts.creds);
    const fromLocalUsage = fetchLocalUsageNotifications(opts.sessionId, opts.creds?.userName);
    const all = [...fromRules, ...fromQueue, ...fromBackend, ...fromLocalUsage];
    const fresh = all.filter((n) => !alreadyShown(state, n));
    if (fresh.length === 0) {
      if (queue.queue.length > 0)
        writeQueue({ queue: [] });
      return;
    }
    const claimed = fresh.filter((n) => tryClaim(n));
    if (claimed.length === 0) {
      if (queue.queue.length > 0)
        writeQueue({ queue: [] });
      log7(`all ${fresh.length} notification(s) claimed by another process`);
      return;
    }
    const rendered = renderNotifications(claimed);
    emit(opts.agent, rendered);
    let nextState = state;
    for (const n of claimed) {
      if (n.transient)
        releaseClaim(n);
      else
        nextState = markShown(nextState, n);
    }
    writeState(nextState);
    if (queue.queue.length > 0)
      writeQueue({ queue: [] });
    log7(`delivered ${claimed.length} notification(s) to ${opts.agent}`);
  } catch (e) {
    log7(`drainSessionStart failed: ${e?.message ?? String(e)}`);
  }
}

// dist/src/notifications/rules/welcome.js
var welcomeRule = {
  id: "welcome",
  trigger: "session_start",
  evaluate({ creds }) {
    if (!creds?.token)
      return null;
    const title = creds.userName ? `Welcome back, ${creds.userName}` : "Welcome back";
    const orgPhrase = creds.orgName ? `org ${creds.orgName}` : "your organization";
    const workspace = creds.workspaceId ?? "default";
    return {
      id: "welcome",
      severity: "info",
      title,
      body: `Connected to ${orgPhrase} (workspace ${workspace}).`,
      dedupKey: { savedAt: creds.savedAt }
    };
  }
};

// dist/src/notifications/rules/local-mined.js
var localMinedRule = {
  id: "local-mined-surfaced",
  trigger: "session_start",
  evaluate({ creds, localSkillsCount }) {
    if (creds?.token)
      return null;
    if (typeof localSkillsCount !== "number" || localSkillsCount <= 0)
      return null;
    const noun = localSkillsCount === 1 ? "skill" : "skills";
    return {
      id: "local-mined-surfaced",
      severity: "info",
      title: `\u{1F389} ${localSkillsCount} ${noun} mined from your local sessions`,
      body: `Run 'hivemind login' to share new mining results with your team.`,
      dedupKey: { count: localSkillsCount }
    };
  }
};

// dist/src/skillify/local-manifest.js
import { existsSync as existsSync2, mkdirSync as mkdirSync5, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { dirname as dirname2, join as join6 } from "node:path";
var LOCAL_MANIFEST_PATH = join6(homedir6(), ".claude", "hivemind", "local-mined.json");
var LOCAL_MINE_LOCK_PATH = join6(homedir6(), ".claude", "hivemind", "local-mined.lock");
function readLocalManifest(path = LOCAL_MANIFEST_PATH) {
  if (!existsSync2(path))
    return null;
  try {
    return JSON.parse(readFileSync5(path, "utf-8"));
  } catch {
    return null;
  }
}
function countLocalManifestEntries(path = LOCAL_MANIFEST_PATH) {
  const m = readLocalManifest(path);
  return Array.isArray(m?.entries) ? m.entries.length : 0;
}

// dist/src/hooks/session-notifications.js
var log8 = (msg) => log("session-notifications", msg);
registerRule(welcomeRule);
registerRule(localMinedRule);
async function main() {
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  const input = await readStdin().catch(() => ({}));
  const rawSessionId = typeof input?.session_id === "string" ? input.session_id.trim() : "";
  const sessionId = rawSessionId.length > 0 ? rawSessionId : void 0;
  const creds = loadCredentials();
  let localSkillsCount = null;
  try {
    localSkillsCount = countLocalManifestEntries();
  } catch {
  }
  await drainSessionStart({ agent: "claude-code", creds, sessionId, localSkillsCount });
}
main().catch((e) => {
  log8(`fatal: ${e?.message ?? String(e)}`);
  process.exit(0);
});
