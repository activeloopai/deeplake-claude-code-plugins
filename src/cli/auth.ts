import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, log, warn } from "./util.js";
import { login, loadCredentials, listOrgs } from "../commands/auth.js";

const CREDS_PATH = join(HOME, ".deeplake", "credentials.json");

export function isLoggedIn(): boolean {
  return existsSync(CREDS_PATH) && loadCredentials() !== null;
}

export async function ensureLoggedIn(): Promise<boolean> {
  if (isLoggedIn()) return true;

  log("");
  log("No Deeplake credentials found. Starting login...");

  try {
    const apiUrl = process.env.HIVEMIND_API_URL ?? process.env.DEEPLAKE_API_URL ?? "https://api.deeplake.ai";
    await login(apiUrl);
  } catch (err) {
    warn(`Login failed: ${(err as Error).message}`);
    return false;
  }

  return isLoggedIn();
}

export async function maybeShowOrgChoice(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) return;
  try {
    const orgs = await listOrgs(creds.token, creds.apiUrl ?? "https://api.deeplake.ai");
    if (orgs.length <= 1) return;
    const activeName = creds.orgName ?? creds.orgId;
    log("");
    log(`You belong to ${orgs.length} orgs. Active: ${activeName}`);
    log(`  Change with: hivemind org switch <name-or-id>`);
  } catch {
    // Best-effort; don't fail install on a transient network issue.
  }
}
