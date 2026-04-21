function definePluginEntry<T>(entry: T): T { return entry; }
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Shared core imports
import { loadConfig } from "../../src/config.js";
import { loadCredentials, saveCredentials, requestDeviceCode, pollForToken, listOrgs, switchOrg, listWorkspaces, switchWorkspace } from "../../src/commands/auth.js";
import { DeeplakeApi } from "../../src/deeplake-api.js";
import { sqlStr, sqlLike } from "../../src/utils/sql.js";

interface PluginConfig {
  autoCapture?: boolean;
  autoRecall?: boolean;
}

interface PluginLogger {
  info?(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface CommandContext {
  args?: string;
  channel?: string;
  senderId?: string;
}

interface PluginAPI {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void;
  registerCommand?(command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: CommandContext) => Promise<string | { text: string }>;
  }): void;
}

const DEFAULT_API_URL = "https://api.deeplake.ai";
const VERSION_URL = "https://raw.githubusercontent.com/activeloopai/hivemind/main/openclaw/openclaw.plugin.json";

function getInstalledVersion(): string | null {
  try {
    const dir = new URL(".", import.meta.url).pathname;
    const candidates = [join(dir, "..", "package.json"), join(dir, "package.json")];
    for (const c of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(c, "utf-8"));
        if (pkg.name === "hivemind" && pkg.version) return pkg.version;
      } catch {}
    }
  } catch {}
  return null;
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/-.*$/, "").split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
}

async function checkForUpdate(logger: PluginLogger): Promise<void> {
  try {
    const current = getInstalledVersion();
    if (!current) return;
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const manifest = await res.json() as { version?: string };
    const latest = manifest.version ?? null;
    if (latest && isNewer(latest, current)) {
      logger.info?.(`⬆️ Hivemind update available: ${current} → ${latest}. Run: openclaw plugins install clawhub:hivemind`);
    }
  } catch {}
}

// --- Auth state ---
let authPending = false;
let authUrl: string | null = null;
let justAuthenticated = false;

async function requestAuth(): Promise<string> {
  if (authPending) return authUrl ?? "";
  authPending = true;

  try {
    const code = await requestDeviceCode();
    authUrl = code.verification_uri_complete;

    // Poll in background
    const pollMs = Math.max(code.interval || 5, 5) * 1000;
    const deadline = Date.now() + code.expires_in * 1000;
    (async () => {
      while (Date.now() < deadline && authPending) {
        await new Promise(r => setTimeout(r, pollMs));
        try {
          const result = await pollForToken(code.device_code);
          if (result) {
            const token = result.access_token;
            const orgs = await listOrgs(token);
            const personal = orgs.find(o => o.name.endsWith("'s Organization"));
            const org = personal ?? orgs[0];
            const orgId = org?.id ?? "";
            const orgName = org?.name ?? orgId;

            // Create long-lived API token
            let savedToken = token;
            if (orgId) {
              try {
                const resp = await fetch(`${DEFAULT_API_URL}/users/me/tokens`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "X-Activeloop-Org-Id": orgId,
                  },
                  body: JSON.stringify({ name: `hivemind-${new Date().toISOString().split("T")[0]}`, duration: 365 * 24 * 60 * 60, organization_id: orgId }),
                });
                if (resp.ok) {
                  const data = await resp.json() as { token: string | { token: string } };
                  savedToken = typeof data.token === "string" ? data.token : data.token.token;
                }
              } catch {}
            }

            saveCredentials({ token: savedToken, orgId, orgName, apiUrl: DEFAULT_API_URL, savedAt: new Date().toISOString() });
            authPending = false;
            authUrl = null;
            justAuthenticated = true;
            return;
          }
        } catch {}
      }
      authPending = false;
      authUrl = null;
    })();

    return code.verification_uri_complete;
  } catch (err) {
    authPending = false;
    throw err;
  }
}

// --- OpenClaw-specific: ensure plugin is in load.paths for hook wiring ---
function addToLoadPaths(): void {
  const ocConfigPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(ocConfigPath)) return;
  try {
    const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
    const installPath = ocConfig?.plugins?.installs?.["hivemind"]?.installPath;
    if (!installPath) return;
    const loadPaths: string[] = ocConfig?.plugins?.load?.paths ?? [];
    if (loadPaths.includes(installPath)) return;
    if (!ocConfig.plugins.load) ocConfig.plugins.load = {};
    ocConfig.plugins.load.paths = [...loadPaths, installPath];
    writeFileSync(ocConfigPath, JSON.stringify(ocConfig, null, 2));
  } catch {}
}

// --- API instance ---
let api: DeeplakeApi | null = null;
let sessionsTable = "sessions";
let captureEnabled = true;
const capturedCounts = new Map<string, number>();
const fallbackSessionId = crypto.randomUUID();

/** Build session path matching CC convention: /sessions/<user>/<user>_<org>_<workspace>_<sessionId>.jsonl */
function buildSessionPath(config: { userName: string; orgName: string; workspaceId: string }, sessionId: string): string {
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${config.workspaceId}_${sessionId}.jsonl`;
}

async function getApi(): Promise<DeeplakeApi | null> {
  if (api) return api;

  const config = loadConfig();
  if (!config) {
    if (!authPending) await requestAuth();
    return null;
  }

  sessionsTable = config.sessionsTableName;
  api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
  await api.ensureSessionsTable(sessionsTable);
  return api;
}

export default definePluginEntry({
  id: "hivemind",
  name: "Hivemind",
  description: "Cloud-backed shared memory powered by Deeplake",
  kind: "memory",

  register(pluginApi: PluginAPI) {
    try {
    addToLoadPaths();

    // Login command — works immediately after install, no hook dependency
    if (pluginApi.registerCommand) {
      pluginApi.registerCommand({
        name: "hivemind_login",
        description: "Log in to Hivemind and activate shared memory",
        handler: async () => {
          const creds = loadCredentials();
          if (creds?.token) {
            return { text: `✅ Already logged in. Org: ${creds.orgName ?? creds.orgId}` };
          }
          const url = await requestAuth();
          return { text: `🔐 Sign in to activate Hivemind memory:\n\n${url}\n\nAfter signing in, send another message.` };
        },
      });

      pluginApi.registerCommand({
        name: "hivemind_capture",
        description: "Toggle conversation capture on/off",
        handler: async () => {
          captureEnabled = !captureEnabled;
          return { text: captureEnabled ? "✅ Capture enabled — conversations will be stored to Hivemind." : "⏸️ Capture paused — conversations will NOT be stored until you run /hivemind_capture again." };
        },
      });

      pluginApi.registerCommand({
        name: "hivemind_whoami",
        description: "Show current Hivemind org and workspace",
        handler: async () => {
          const creds = loadCredentials();
          if (!creds?.token) return { text: "Not logged in. Run /hivemind_login" };
          return { text: `Org: ${creds.orgName ?? creds.orgId}\nWorkspace: ${creds.workspaceId ?? "default"}` };
        },
      });

      pluginApi.registerCommand({
        name: "hivemind_orgs",
        description: "List available organizations",
        handler: async () => {
          const creds = loadCredentials();
          if (!creds?.token) return { text: "Not logged in. Run /hivemind_login" };
          const orgs = await listOrgs(creds.token, creds.apiUrl);
          if (!orgs.length) return { text: "No organizations found." };
          const lines = orgs.map(o => `${o.id === creds.orgId ? "→ " : "  "}${o.name}`);
          return { text: lines.join("\n") };
        },
      });

      pluginApi.registerCommand({
        name: "hivemind_switch_org",
        description: "Switch to a different organization",
        acceptsArgs: true,
        handler: async (ctx: CommandContext) => {
          const creds = loadCredentials();
          if (!creds?.token) return { text: "Not logged in. Run /hivemind_login" };
          const target = ctx.args?.trim();
          if (!target) return { text: "Usage: /hivemind_switch_org <name-or-id>" };
          const orgs = await listOrgs(creds.token, creds.apiUrl);
          const match = orgs.find(o => o.id === target || o.name.toLowerCase() === target.toLowerCase());
          if (!match) return { text: `Org not found: ${target}` };
          await switchOrg(match.id, match.name);
          api = null;
          return { text: `Switched to org: ${match.name}` };
        },
      });

      pluginApi.registerCommand({
        name: "hivemind_workspaces",
        description: "List available workspaces",
        handler: async () => {
          const creds = loadCredentials();
          if (!creds?.token) return { text: "Not logged in. Run /hivemind_login" };
          const ws = await listWorkspaces(creds.token, creds.apiUrl, creds.orgId);
          if (!ws.length) return { text: "No workspaces found." };
          const lines = ws.map(w => `${w.id === (creds.workspaceId ?? "default") ? "→ " : "  "}${w.name}`);
          return { text: lines.join("\n") };
        },
      });

      pluginApi.registerCommand({
        name: "hivemind_switch_workspace",
        description: "Switch to a different workspace",
        acceptsArgs: true,
        handler: async (ctx: CommandContext) => {
          const creds = loadCredentials();
          if (!creds?.token) return { text: "Not logged in. Run /hivemind_login" };
          const target = ctx.args?.trim();
          if (!target) return { text: "Usage: /hivemind_switch_workspace <name-or-id>" };
          const ws = await listWorkspaces(creds.token, creds.apiUrl, creds.orgId);
          const match = ws.find(w => w.id === target || w.name.toLowerCase() === target.toLowerCase());
          if (!match) return { text: `Workspace not found: ${target}` };
          await switchWorkspace(match.id);
          api = null;
          return { text: `Switched to workspace: ${match.name}` };
        },
      });

      pluginApi.registerCommand({
        name: "hivemind_update",
        description: "Check for Hivemind updates and show how to upgrade",
        handler: async () => {
          const current = getInstalledVersion();
          if (!current) return { text: "Could not determine installed version." };
          try {
            const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(3000) });
            if (!res.ok) return { text: `Current version: ${current}. Could not check for updates.` };
            const pkg = await res.json();
            const latest = typeof pkg.version === "string" ? pkg.version : null;
            if (!latest) return { text: `Current version: ${current}. Could not parse latest version.` };
            if (isNewer(latest, current)) {
              return { text: `⬆️ Update available: ${current} → ${latest}\n\nRun in your terminal:\n\`openclaw plugins update hivemind\`` };
            }
            return { text: `✅ Hivemind v${current} is up to date.` };
          } catch {
            return { text: `Current version: ${current}. Could not check for updates.` };
          }
        },
      });
    }

    const config = (pluginApi.pluginConfig ?? {}) as PluginConfig;
    const logger = pluginApi.logger;

    const hook = (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      if (pluginApi.on) pluginApi.on(event, handler);
    };

    // Auto-recall: search memory before each turn
    if (config.autoRecall !== false) {
      hook("before_agent_start", async (event: { prompt?: string }) => {
        if (!event.prompt || event.prompt.length < 5) return;
        try {
          const dl = await getApi();

          if (!dl && authUrl) {
            return {
              prependContext: `\n\nIMPORTANT: The user needs to authenticate with Hivemind. Include this link in your reply: ${authUrl}\nTell them to click it and sign in, then send another message.\n`,
            };
          }
          if (!dl) return;

          if (justAuthenticated) {
            justAuthenticated = false;
            const creds = loadCredentials();
            const orgName = creds?.orgName ?? creds?.orgId ?? "unknown";
            return { prependContext: `\n\n🐝 Welcome to Hivemind!\n\nCurrent org: ${orgName}\n\nYour agents now share memory across sessions, teammates, and machines.\n\nGet started:\n1. Verify sync: spin up multiple sessions and confirm agents share context\n2. Invite a teammate: ask the agent to add them over email\n3. Switch orgs: ask the agent to list or switch your organizations\n\nOne brain for every agent on your team.\n` };
          }

          const stopWords = new Set(["the","and","for","are","but","not","you","all","can","had","her","was","one","our","out","has","have","what","does","like","with","this","that","from","they","been","will","more","when","who","how","its","into","some","than","them","these","then","your","just","about","would","could","should","where","which","there","their","being","each","other"]);
          const words = event.prompt.toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.has(w));

          if (!words.length) return;

          // Search sessions table — cast JSONB message to text for keyword search
          const results = await dl.query(
            `SELECT path, message FROM "${sessionsTable}" WHERE message::text ILIKE '%${sqlLike(words[0])}%' ORDER BY creation_date DESC LIMIT 5`
          );

          if (!results.length) return;

          const recalled = results
            .map(r => {
              const msg = typeof r.message === "string" ? r.message : JSON.stringify(r.message);
              return `[${r.path}] ${msg.slice(0, 300)}`;
            })
            .join("\n\n");

          logger.info?.(`Auto-recalled ${results.length} memories`);
          return {
            prependContext: "\n\n<recalled-memories>\n" + recalled + "\n</recalled-memories>\n",
          };
        } catch (err) {
          logger.error(`Auto-recall failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Auto-capture: store new messages in sessions table (same format as CC capture.ts)
    if (config.autoCapture !== false) {
      hook("agent_end", async (event) => {
        const ev = event as { success?: boolean; session_id?: string; channel?: string; messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
        if (!captureEnabled || !ev.success || !ev.messages?.length) return;
        try {
          const dl = await getApi();
          if (!dl) return;

          const cfg = loadConfig();
          if (!cfg) return;

          const sid = ev.session_id || fallbackSessionId;
          const lastCount = capturedCounts.get(sid) ?? 0;
          const newMessages = ev.messages.slice(lastCount);
          capturedCounts.set(sid, ev.messages.length);
          if (!newMessages.length) return;

          const sessionPath = buildSessionPath(cfg, sid);
          const filename = sessionPath.split("/").pop() ?? "";
          const projectName = ev.channel || "openclaw";

          for (const msg of newMessages) {
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            let text = "";
            if (typeof msg.content === "string") {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              text = msg.content
                .filter(b => b.type === "text" && b.text)
                .map(b => b.text!)
                .join("\n");
            }
            if (!text.trim()) continue;

            const ts = new Date().toISOString();
            const entry = {
              id: crypto.randomUUID(),
              type: msg.role === "user" ? "user_message" : "assistant_message",
              session_id: sid,
              content: text,
              timestamp: ts,
            };
            const line = JSON.stringify(entry);
            // For JSONB: only escape single quotes, keep JSON structure intact
            const jsonForSql = line.replace(/'/g, "''");

            const insertSql =
              `INSERT INTO "${sessionsTable}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
              `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, '${sqlStr(cfg.userName)}', ` +
              `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(msg.role)}', 'openclaw', '${ts}', '${ts}')`;

            try {
              await dl.query(insertSql);
            } catch (e: any) {
              if (e.message?.includes("permission denied") || e.message?.includes("does not exist")) {
                await dl.ensureSessionsTable(sessionsTable);
                await dl.query(insertSql);
              } else {
                throw e;
              }
            }
          }

          logger.info?.(`Auto-captured ${newMessages.length} messages`);
        } catch (err) {
          logger.error(`Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Prompt login if not authenticated
    const creds = loadCredentials();
    if (!creds?.token) {
      logger.info?.("Hivemind installed. Run /hivemind_login to authenticate and activate shared memory.");
      if (!authPending) {
        requestAuth().catch(err => {
          logger.error(`Pre-auth failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    // Non-blocking version check
    checkForUpdate(logger).catch(() => {});

    logger.info?.("Hivemind plugin registered");
    } catch (err) {
      pluginApi.logger?.error?.(`Hivemind register failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
