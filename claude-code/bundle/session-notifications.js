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
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join3, resolve } from "node:path";
import { homedir as homedir3 } from "node:os";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = process.env.HIVEMIND_DEBUG === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
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
function writeQueue(q) {
  const path = queuePath();
  const home = resolve(homedir3());
  if (!resolve(path).startsWith(home + "/") && resolve(path) !== home) {
    throw new Error(`notifications-queue write blocked: ${path} is outside ${home}`);
  }
  mkdirSync2(join3(home, ".deeplake"), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync2(tmp, JSON.stringify(q, null, 2), { mode: 384 });
  renameSync(tmp, path);
}

// dist/src/notifications/state.js
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, renameSync as renameSync2, mkdirSync as mkdirSync3 } from "node:fs";
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
import { appendFileSync as appendFileSync2, existsSync, mkdirSync as mkdirSync4, readFileSync as readFileSync4, readdirSync, statSync } from "node:fs";
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
        if (typeof rec.endedAt === "string" && typeof rec.sessionId === "string" && typeof rec.inputTokens === "number" && typeof rec.outputTokens === "number" && typeof rec.cacheReadTokens === "number" && typeof rec.cacheCreationTokens === "number" && typeof rec.assistantTurns === "number") {
          out.push({
            endedAt: rec.endedAt,
            sessionId: rec.sessionId,
            inputTokens: rec.inputTokens,
            outputTokens: rec.outputTokens,
            cacheReadTokens: rec.cacheReadTokens,
            cacheCreationTokens: rec.cacheCreationTokens,
            assistantTurns: rec.assistantTurns,
            model: typeof rec.model === "string" ? rec.model : "",
            // Backward compatibility: records written before
            // feat/onboarding-notifications slice 2 don't carry these
            // fields — read them as 0 so older records still aggregate
            // cleanly alongside new ones.
            hivemindInjectedBytes: typeof rec.hivemindInjectedBytes === "number" ? rec.hivemindInjectedBytes : 0,
            memorySearchCount: typeof rec.memorySearchCount === "number" ? rec.memorySearchCount : 0,
            memorySearchBytes: typeof rec.memorySearchBytes === "number" ? rec.memorySearchBytes : 0
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
function filterRecentRecords(records, days, now = /* @__PURE__ */ new Date()) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1e3;
  return records.filter((r) => {
    const t = Date.parse(r.endedAt);
    return Number.isFinite(t) && t >= cutoff;
  });
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
function memoryStoreSizeBytes() {
  const root = join5(homedir5(), ".deeplake", "memory");
  if (!existsSync(root))
    return 0;
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join5(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
        }
      }
    }
  }
  return total;
}

// dist/src/notifications/sources/local-usage.js
var log6 = (msg) => log("notifications-local-usage", msg);
var LOOKBACK_DAYS = 7;
var MIN_SESSIONS_FOR_RECAP = 2;
var BYTES_PER_TOKEN = 4;
function isoWeekId(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const week1Thursday = new Date(Date.UTC(year, 0, 4));
  const week1DayNum = week1Thursday.getUTCDay() || 7;
  const week1ThursdayShifted = new Date(week1Thursday);
  week1ThursdayShifted.setUTCDate(week1Thursday.getUTCDate() + 4 - week1DayNum);
  const week = 1 + Math.round((d.getTime() - week1ThursdayShifted.getTime()) / (7 * 24 * 60 * 60 * 1e3));
  return `${year}-W${week.toString().padStart(2, "0")}`;
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
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0)
    return "0 B";
  if (n < 1024)
    return `${Math.round(n)} B`;
  if (n < 1024 * 1024)
    return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024)
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function fetchLocalUsageNotifications(now = /* @__PURE__ */ new Date()) {
  let all;
  try {
    all = readUsageRecords();
  } catch (e) {
    log6(`readUsageRecords threw: ${e?.message ?? String(e)}`);
    return [];
  }
  const recent = filterRecentRecords(all, LOOKBACK_DAYS, now);
  if (recent.length < MIN_SESSIONS_FOR_RECAP) {
    log6(`only ${recent.length} session(s) in last ${LOOKBACK_DAYS}d \u2014 skipping recap`);
    return [];
  }
  const sessions = recent.length;
  const memorySearches = sumMetric(recent, "memorySearchCount");
  const memorySearchBytes = sumMetric(recent, "memorySearchBytes");
  if (memorySearches === 0 || memorySearchBytes === 0) {
    log6(`no memory searches in window \u2014 skipping recap`);
    return [];
  }
  const weekId = isoWeekId(now);
  const memoryStoreBytes = memoryStoreSizeBytes();
  const X = memoryStoreBytes / BYTES_PER_TOKEN;
  const Y = memorySearchBytes / BYTES_PER_TOKEN;
  let title;
  let baselineLine;
  if (X > 0 && X > Y) {
    const Z = X - Y;
    title = `Hivemind saved you ~${formatTokens(Z)} tokens this week`;
    baselineLine = `selective retrieval from your ${formatBytes(memoryStoreBytes)} memory store`;
  } else {
    const Z = Y;
    title = `Hivemind delivered ~${formatTokens(Z)} tokens of past context this week`;
    baselineLine = `from your hivemind memory store`;
  }
  const activityLine = `${sessions} ${sessions === 1 ? "session" : "sessions"} \xB7 ${memorySearches} memory ${memorySearches === 1 ? "search" : "searches"}`;
  return [
    {
      id: "local-usage:weekly-recap",
      severity: "info",
      title,
      body: `   ${baselineLine}
   ${activityLine}`,
      dedupKey: { week: weekId }
    }
  ];
}

// dist/src/notifications/index.js
var log7 = (msg) => log("notifications", msg);
async function drainSessionStart(opts) {
  try {
    const state = readState();
    const queue = readQueue();
    const ctx = { agent: opts.agent, creds: opts.creds, state };
    const fromRules = evaluateRules("session_start", ctx);
    const fromQueue = queue.queue;
    const fromBackend = await fetchBackendNotifications(opts.creds);
    const fromLocalUsage = fetchLocalUsageNotifications();
    const all = [...fromRules, ...fromQueue, ...fromBackend, ...fromLocalUsage];
    const fresh = all.filter((n) => !alreadyShown(state, n));
    if (fresh.length === 0) {
      if (queue.queue.length > 0)
        writeQueue({ queue: [] });
      return;
    }
    const rendered = renderNotifications(fresh);
    emit(opts.agent, rendered);
    let nextState = state;
    for (const n of fresh)
      nextState = markShown(nextState, n);
    writeState(nextState);
    if (queue.queue.length > 0)
      writeQueue({ queue: [] });
    log7(`delivered ${fresh.length} notification(s) to ${opts.agent}`);
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

// dist/src/hooks/session-notifications.js
var log8 = (msg) => log("session-notifications", msg);
registerRule(welcomeRule);
async function main() {
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  await readStdin().catch(() => ({}));
  const creds = loadCredentials();
  await drainSessionStart({ agent: "claude-code", creds });
}
main().catch((e) => {
  log8(`fatal: ${e?.message ?? String(e)}`);
  process.exit(0);
});
