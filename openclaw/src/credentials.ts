import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  token: string;
  orgId: string;
  apiUrl: string;
  savedAt: string;
}

export function loadCredentials(): Credentials | null {
  const credsPath = join(homedir(), ".deeplake", "credentials.json");
  if (!existsSync(credsPath)) return null;
  try {
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    if (!creds.token || !creds.orgId) return null;
    return creds;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  const deeplakeDir = join(homedir(), ".deeplake");
  mkdirSync(deeplakeDir, { recursive: true });
  writeFileSync(join(deeplakeDir, "credentials.json"), JSON.stringify(creds), { mode: 0o600 });
}

export function hasCredentials(): boolean {
  return existsSync(join(homedir(), ".deeplake", "credentials.json"));
}

export function addToLoadPaths(): void {
  const ocConfigPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(ocConfigPath)) return;
  try {
    const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
    const installPath = ocConfig?.plugins?.installs?.["deeplake-plugin"]?.installPath;
    if (!installPath) return;
    const loadPaths: string[] = ocConfig?.plugins?.load?.paths ?? [];
    if (loadPaths.includes(installPath)) return;
    if (!ocConfig.plugins.load) ocConfig.plugins.load = {};
    ocConfig.plugins.load.paths = [...loadPaths, installPath];
    writeFileSync(ocConfigPath, JSON.stringify(ocConfig, null, 2));
  } catch {}
}
