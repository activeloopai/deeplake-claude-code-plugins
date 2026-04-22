import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

export interface Config {
  token: string;
  orgId: string;
  orgName: string;
  userName: string;
  workspaceId: string;
  apiUrl: string;
  tableName: string;
  sessionsTableName: string;
  memoryPath: string;
}

interface Credentials {
  token: string;
  orgId: string;
  orgName?: string;
  userName?: string;
  workspaceId?: string;
  apiUrl?: string;
}

export function loadConfig(): Config | null {
  const home = homedir();
  const credPath = join(home, ".deeplake", "credentials.json");

  let creds: Credentials | null = null;
  if (existsSync(credPath)) {
    try {
      creds = JSON.parse(readFileSync(credPath, "utf-8"));
    } catch {
      return null;
    }
  }

  // Backwards-compat: fall back to DEEPLAKE_* env vars after HIVEMIND_*. Warn once if used.
  // Using `process.env.X` directly (not aliasing) so esbuild's `define` in openclaw build can
  // stub these to `undefined` at bundle-time — keeps openclaw scanner from flagging env+fetch.
  if (!process.env.HIVEMIND_TOKEN && process.env.DEEPLAKE_TOKEN) {
    process.stderr.write("[hivemind] DEEPLAKE_* env vars are deprecated; use HIVEMIND_* instead\n");
  }
  const token = process.env.HIVEMIND_TOKEN ?? process.env.DEEPLAKE_TOKEN ?? creds?.token;
  const orgId = process.env.HIVEMIND_ORG_ID ?? process.env.DEEPLAKE_ORG_ID ?? creds?.orgId;
  if (!token || !orgId) return null;

  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: process.env.HIVEMIND_WORKSPACE_ID ?? process.env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.HIVEMIND_API_URL ?? process.env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.HIVEMIND_TABLE ?? process.env.DEEPLAKE_TABLE ?? "memory",
    sessionsTableName: process.env.HIVEMIND_SESSIONS_TABLE ?? process.env.DEEPLAKE_SESSIONS_TABLE ?? "sessions",
    memoryPath: process.env.HIVEMIND_MEMORY_PATH ?? process.env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory"),
  };
}
