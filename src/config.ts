import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  token: string;
  orgId: string;
  workspaceId: string;
  apiUrl: string;
  tableName: string;
  memoryPath: string;
}

interface Credentials {
  token: string;
  orgId: string;
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

  const token = process.env.DEEPLAKE_TOKEN ?? creds?.token;
  const orgId = process.env.DEEPLAKE_ORG_ID ?? creds?.orgId;
  if (!token || !orgId) return null;

  return {
    token,
    orgId,
    workspaceId: process.env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.DEEPLAKE_MEMORY_TABLE ?? "memory",
    memoryPath: process.env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory"),
  };
}
