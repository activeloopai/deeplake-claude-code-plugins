function definePluginEntry<T>(entry: T): T { return entry; }
import { homedir } from "node:os";
import { join } from "node:path";
import { DeepLakeAPI, type SearchResult } from "./memory.js";
import { loadCredentials, saveCredentials, hasCredentials, addToLoadPaths } from "./credentials.js";

interface PluginConfig {
  mountPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
}

interface PluginLogger {
  info?(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface PluginAPI {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void;
}

const API_URL = "https://api.deeplake.ai";

// --- Auth state ---
let authPending = false;
let authUrl: string | null = null;

async function requestAuth(): Promise<string> {
  if (authPending) return authUrl ?? "";
  authPending = true;
  const resp = await fetch(`${API_URL}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    authPending = false;
    throw new Error("DeepLake auth service unavailable");
  }
  const data = await resp.json() as {
    verification_uri_complete: string;
    device_code: string;
    interval: number;
    expires_in: number;
  };

  authUrl = data.verification_uri_complete;

  // Poll in background
  const pollMs = Math.max(data.interval || 5, 5) * 1000;
  const deadline = Date.now() + data.expires_in * 1000;
  (async () => {
    while (Date.now() < deadline && authPending) {
      await new Promise(r => setTimeout(r, pollMs));
      try {
        const tokenResp = await fetch(`${API_URL}/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: data.device_code }),
        });
        if (tokenResp.ok) {
          const tokenData = await tokenResp.json() as { access_token: string };
          const token = tokenData.access_token;

          const orgsResp = await fetch(`${API_URL}/organizations`, {
            headers: { Authorization: `Bearer ${token}`, "X-Deeplake-Client": "cli" },
          });
          let orgId = "";
          if (orgsResp.ok) {
            const orgs = await orgsResp.json() as Array<{ id: string; name: string }>;
            const personal = orgs.find(o => o.name.endsWith("'s Organization"));
            orgId = personal?.id ?? orgs[0]?.id ?? "";
          }

          let savedToken = token;
          if (orgId) {
            try {
              const apiTokenResp = await fetch(`${API_URL}/users/me/tokens`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  "X-Activeloop-Org-Id": orgId,
                },
                body: JSON.stringify({ name: `deeplake-plugin-${new Date().toISOString().split("T")[0]}`, duration: 365 * 24 * 60 * 60, organization_id: orgId }),
              });
              if (apiTokenResp.ok) {
                const respData = await apiTokenResp.json() as { token: string | { token: string } };
                savedToken = typeof respData.token === "string" ? respData.token : respData.token.token;
              }
            } catch {}
          }

          saveCredentials({ token: savedToken, orgId, apiUrl: API_URL, savedAt: new Date().toISOString() });

          authPending = false;
          authUrl = null;
          return;
        }
      } catch {}
    }
    authPending = false;
    authUrl = null;
  })();

  return data.verification_uri_complete;
}

// --- API instance ---
let api: DeepLakeAPI | null = null;
const capturedCounts = new Map<string, number>();
const fallbackSessionId = crypto.randomUUID();

async function getApi(): Promise<DeepLakeAPI | null> {
  if (api) return api;

  const creds = loadCredentials();
  if (!creds) {
    if (!authPending) await requestAuth();
    return null;
  }

  api = new DeepLakeAPI(creds.token, creds.orgId, creds.apiUrl || API_URL);
  await api.ensureTable();
  return api;
}

export default definePluginEntry({
  id: "deeplake-plugin",
  name: "DeepLake Memory",
  description: "Cloud-backed shared memory powered by DeepLake",
  kind: "memory",

  register(pluginApi: PluginAPI) {
    try {
    // Workaround: OpenClaw extensions/ plugins don't wire hooks to the global runner.
    // Adding ourselves to plugins.load.paths ensures hooks fire after next restart.
    addToLoadPaths();

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
              prependContext: `\n\nIMPORTANT: The user needs to authenticate with DeepLake to activate shared memory. Include this clickable link in your reply: ${authUrl}\nTell them to click it and sign in, then send another message.\n`,
            };
          }
          if (!dl) return;

          const stopWords = new Set(["the","and","for","are","but","not","you","all","can","had","her","was","one","our","out","has","have","what","does","like","with","this","that","from","they","been","will","more","when","who","how","its","into","some","than","them","these","then","your","just","about","would","could","should","where","which","there","their","being","each","other"]);
          const words = event.prompt.toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.has(w));

          if (!words.length) return;

          const allResults: SearchResult[] = [];
          const seen = new Set<string>();
          for (const word of words.slice(0, 3)) {
            for (const r of await dl.search(word, 3)) {
              if (!seen.has(r.snippet)) {
                seen.add(r.snippet);
                allResults.push(r);
              }
            }
          }
          const results = allResults.slice(0, 5);
          if (!results.length) return;

          const recalled = results
            .map(r => `[${r.path}] ${r.snippet.slice(0, 300)}`)
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

    // Auto-capture: store new messages via API
    if (config.autoCapture !== false) {
      hook("agent_end", async (event) => {
        const ev = event as { success?: boolean; session_id?: string; messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
        if (!ev.success || !ev.messages?.length) return;
        try {
          const dl = await getApi();
          if (!dl) return;

          const sid = ev.session_id || fallbackSessionId;
          const lastCount = capturedCounts.get(sid) ?? 0;
          const newMessages = ev.messages.slice(lastCount);
          capturedCounts.set(sid, ev.messages.length);
          if (!newMessages.length) return;

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
            await dl.write(sid, msg.role, text);
          }

          logger.info?.(`Auto-captured ${newMessages.length} messages`);
        } catch (err) {
          logger.error(`Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Pre-fetch auth URL during registration
    if (!hasCredentials() && !authPending) {
      requestAuth().catch(err => {
        logger.error(`Pre-auth failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    logger.info?.("DeepLake Memory plugin registered");
    } catch (err) {
      pluginApi.logger?.error?.(`DeepLake Memory register failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
