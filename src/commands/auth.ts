/**
 * Deeplake authentication — Device Authorization Flow (RFC 8628)
 * and org/workspace management.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const CONFIG_DIR = join(homedir(), ".deeplake");
const CREDS_PATH = join(CONFIG_DIR, "credentials.json");
const DEFAULT_API_URL = "https://api.deeplake.ai";

// Output goes to stderr by default (safe for hooks).
// auth-login.js sets this to console.log for direct CLI usage.
export let authLog = (msg: string) => process.stderr.write(msg + "\n");

// ── Types ────────────────────────────────────────────────────────────────────

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

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// ── Credentials Storage ──────────────────────────────────────────────────────

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

// ── JWT Helpers ──────────────────────────────────────────────────────────────

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// ── API Helpers ──────────────────────────────────────────────────────────────

async function apiGet(path: string, token: string, apiUrl: string, orgId?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (orgId) headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { headers });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json();
}

async function apiPost(path: string, body: unknown, token: string, apiUrl: string, orgId?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (orgId) headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json();
}

async function apiDelete(path: string, token: string, apiUrl: string, orgId?: string): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (orgId) headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { method: "DELETE", headers });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
}

// ── Device Flow ──────────────────────────────────────────────────────────────

export async function requestDeviceCode(apiUrl = DEFAULT_API_URL): Promise<DeviceCodeResponse> {
  const resp = await fetch(`${apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error(`Device flow unavailable: HTTP ${resp.status}`);
  return resp.json() as Promise<DeviceCodeResponse>;
}

export async function pollForToken(deviceCode: string, apiUrl = DEFAULT_API_URL): Promise<DeviceTokenResponse | null> {
  const resp = await fetch(`${apiUrl}/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (resp.ok) return resp.json() as Promise<DeviceTokenResponse>;
  if (resp.status === 400) {
    const err = await resp.json().catch(() => null) as { error?: string } | null;
    if (err?.error === "authorization_pending" || err?.error === "slow_down") return null;
    if (err?.error === "expired_token") throw new Error("Device code expired. Try again.");
    if (err?.error === "access_denied") throw new Error("Authorization denied.");
  }
  throw new Error(`Token polling failed: HTTP ${resp.status}`);
}

function openBrowser(url: string): boolean {
  try {
    const cmd = process.platform === "darwin" ? `open "${url}"`
      : process.platform === "win32" ? `start "${url}"`
      : `xdg-open "${url}" 2>/dev/null`;
    execSync(cmd, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function deviceFlowLogin(apiUrl = DEFAULT_API_URL): Promise<{ token: string; expiresIn: number }> {
  const code = await requestDeviceCode(apiUrl);

  const opened = openBrowser(code.verification_uri_complete);
  const msg = [
    "\nDeeplake Authentication",
    "─".repeat(40),
    `\nOpen this URL: ${code.verification_uri_complete}`,
    `Or visit ${code.verification_uri} and enter code: ${code.user_code}`,
    opened ? "\nBrowser opened. Waiting for sign in..." : "\nWaiting for sign in...",
  ].join("\n");

  // Return the message and polling function for the caller to handle
  process.stderr.write(msg + "\n");

  const interval = Math.max(code.interval || 5, 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    const result = await pollForToken(code.device_code, apiUrl);
    if (result) {
      process.stderr.write("\nAuthentication successful!\n");
      return { token: result.access_token, expiresIn: result.expires_in };
    }
  }
  throw new Error("Device code expired.");
}

// ── Organization Commands ────────────────────────────────────────────────────

export async function listOrgs(token: string, apiUrl = DEFAULT_API_URL): Promise<{ id: string; name: string }[]> {
  const data = await apiGet("/organizations", token, apiUrl) as { id: string; name: string }[];
  return Array.isArray(data) ? data : [];
}

export async function switchOrg(orgId: string, orgName?: string): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in. Run deeplake login first.");
  saveCredentials({ ...creds, orgId, orgName });
}

// ── Workspace Commands ───────────────────────────────────────────────────────

export async function listWorkspaces(token: string, apiUrl = DEFAULT_API_URL, orgId?: string): Promise<{ id: string; name: string }[]> {
  const data = await apiGet("/workspaces", token, apiUrl, orgId) as { id: string; name: string }[];
  return Array.isArray(data) ? data : [];
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in. Run deeplake login first.");
  saveCredentials({ ...creds, workspaceId });
}

// ── Member Commands ──────────────────────────────────────────────────────────

export async function inviteMember(
  username: string,
  accessMode: "ADMIN" | "WRITE" | "READ",
  token: string,
  orgId: string,
  apiUrl = DEFAULT_API_URL,
): Promise<void> {
  await apiPost(`/organizations/${orgId}/members/invite`, { username, access_mode: accessMode }, token, apiUrl, orgId);
}

export async function listMembers(
  token: string,
  orgId: string,
  apiUrl = DEFAULT_API_URL,
): Promise<{ user_id: string; name: string; email: string; role: string }[]> {
  const data = await apiGet(`/organizations/${orgId}/members`, token, apiUrl, orgId) as { members: { user_id: string; name: string; email: string; role: string }[] };
  return data.members ?? [];
}

export async function removeMember(
  userId: string,
  token: string,
  orgId: string,
  apiUrl = DEFAULT_API_URL,
): Promise<void> {
  await apiDelete(`/organizations/${orgId}/members/${userId}`, token, apiUrl, orgId);
}

// ── Full Login Flow ──────────────────────────────────────────────────────────

export async function login(apiUrl = DEFAULT_API_URL): Promise<Credentials> {
  // Step 1: Device flow → get short-lived token
  const { token: authToken } = await deviceFlowLogin(apiUrl);

  // Step 2: Get user info
  const user = await apiGet("/me", authToken, apiUrl) as { id: string; name: string; email?: string };
  const userName = user.name || (user.email ? user.email.split("@")[0] : "unknown");
  process.stderr.write(`\nLogged in as: ${userName}\n`);

  // Step 3: List orgs and select
  const orgs = await listOrgs(authToken, apiUrl);
  let orgId: string;
  let orgName: string;

  if (orgs.length === 1) {
    orgId = orgs[0].id;
    orgName = orgs[0].name;
    process.stderr.write(`Organization: ${orgName}\n`);
  } else {
    process.stderr.write("\nOrganizations:\n");
    orgs.forEach((org, i) => process.stderr.write(`  ${i + 1}. ${org.name}\n`));
    // Default to first org — Claude can switch later
    orgId = orgs[0].id;
    orgName = orgs[0].name;
    process.stderr.write(`\nUsing: ${orgName}\n`);
  }

  // Step 4: Exchange for long-lived API token
  const tokenName = `deeplake-plugin-${new Date().toISOString().slice(0, 10)}`;
  const tokenData = await apiPost("/users/me/tokens", {
    name: tokenName,
    duration: 365 * 24 * 3600,
    organization_id: orgId,
  }, authToken, apiUrl) as { token: { token: string } };

  const apiToken = tokenData.token.token;

  // Step 5: Save credentials
  const creds: Credentials = {
    token: apiToken,
    orgId,
    orgName,
    userName,
    workspaceId: "default",
    apiUrl,
    savedAt: new Date().toISOString(),
  };
  saveCredentials(creds);

  return creds;
}
