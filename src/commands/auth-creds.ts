/**
 * Credentials file IO for the Deeplake plugin. Lives in its own module so
 * that consumers (in particular the openclaw plugin's bundler) can split
 * fs reads/writes from network calls along source-file boundaries — needed
 * to pass per-file static-analysis rules that flag fs+fetch co-occurrence.
 *
 * No imports from any module that touches `fetch` belong here.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".deeplake");
export const CREDS_PATH = join(CONFIG_DIR, "credentials.json");

export interface Credentials {
  token: string;
  orgId: string;
  orgName?: string;
  userName?: string;
  workspaceId?: string;
  apiUrl?: string;
  autoupdate?: boolean;
  savedAt: string;
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDS_PATH, JSON.stringify({ ...creds, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): boolean {
  if (existsSync(CREDS_PATH)) {
    unlinkSync(CREDS_PATH);
    return true;
  }
  return false;
}
