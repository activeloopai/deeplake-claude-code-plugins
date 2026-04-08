#!/usr/bin/env node

// dist/src/commands/auth.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
var CONFIG_DIR = join(homedir(), ".deeplake");
var CREDS_PATH = join(CONFIG_DIR, "credentials.json");
var DEFAULT_API_URL = "https://api.deeplake.ai";
function loadCredentials() {
  if (!existsSync(CREDS_PATH))
    return null;
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
  } catch {
    return null;
  }
}
function saveCredentials(creds) {
  if (!existsSync(CONFIG_DIR))
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync(CREDS_PATH, JSON.stringify({ ...creds, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), { mode: 384 });
}
async function apiGet(path, token, apiUrl, orgId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (orgId)
    headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { headers });
  if (!resp.ok)
    throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json();
}
async function apiPost(path, body, token, apiUrl, orgId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (orgId)
    headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok)
    throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json();
}
async function apiDelete(path, token, apiUrl, orgId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (orgId)
    headers["X-Activeloop-Org-Id"] = orgId;
  const resp = await fetch(`${apiUrl}${path}`, { method: "DELETE", headers });
  if (!resp.ok)
    throw new Error(`API ${resp.status}: ${await resp.text().catch(() => "")}`);
}
async function requestDeviceCode(apiUrl = DEFAULT_API_URL) {
  const resp = await fetch(`${apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!resp.ok)
    throw new Error(`Device flow unavailable: HTTP ${resp.status}`);
  return resp.json();
}
async function pollForToken(deviceCode, apiUrl = DEFAULT_API_URL) {
  const resp = await fetch(`${apiUrl}/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode })
  });
  if (resp.ok)
    return resp.json();
  if (resp.status === 400) {
    const err = await resp.json().catch(() => null);
    if (err?.error === "authorization_pending" || err?.error === "slow_down")
      return null;
    if (err?.error === "expired_token")
      throw new Error("Device code expired. Try again.");
    if (err?.error === "access_denied")
      throw new Error("Authorization denied.");
  }
  throw new Error(`Token polling failed: HTTP ${resp.status}`);
}
function openBrowser(url) {
  try {
    const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "${url}"` : `xdg-open "${url}" 2>/dev/null`;
    execSync(cmd, { stdio: "ignore", timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}
async function deviceFlowLogin(apiUrl = DEFAULT_API_URL) {
  const code = await requestDeviceCode(apiUrl);
  const opened = openBrowser(code.verification_uri_complete);
  const msg = [
    "\nDeeplake Authentication",
    "\u2500".repeat(40),
    `
Open this URL: ${code.verification_uri_complete}`,
    `Or visit ${code.verification_uri} and enter code: ${code.user_code}`,
    opened ? "\nBrowser opened. Waiting for sign in..." : "\nWaiting for sign in..."
  ].join("\n");
  process.stderr.write(msg + "\n");
  const interval = Math.max(code.interval || 5, 5) * 1e3;
  const deadline = Date.now() + code.expires_in * 1e3;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const result = await pollForToken(code.device_code, apiUrl);
    if (result) {
      process.stderr.write("\nAuthentication successful!\n");
      return { token: result.access_token, expiresIn: result.expires_in };
    }
  }
  throw new Error("Device code expired.");
}
async function listOrgs(token, apiUrl = DEFAULT_API_URL) {
  const data = await apiGet("/organizations", token, apiUrl);
  return Array.isArray(data) ? data : [];
}
async function switchOrg(orgId, orgName) {
  const creds = loadCredentials();
  if (!creds)
    throw new Error("Not logged in. Run deeplake login first.");
  saveCredentials({ ...creds, orgId, orgName });
}
async function listWorkspaces(token, apiUrl = DEFAULT_API_URL, orgId) {
  const data = await apiGet("/workspaces", token, apiUrl, orgId);
  return Array.isArray(data) ? data : [];
}
async function switchWorkspace(workspaceId) {
  const creds = loadCredentials();
  if (!creds)
    throw new Error("Not logged in. Run deeplake login first.");
  saveCredentials({ ...creds, workspaceId });
}
async function inviteMember(username, accessMode, token, orgId, apiUrl = DEFAULT_API_URL) {
  await apiPost(`/organizations/${orgId}/members/invite`, { username, access_mode: accessMode }, token, apiUrl, orgId);
}
async function listMembers(token, orgId, apiUrl = DEFAULT_API_URL) {
  const data = await apiGet(`/organizations/${orgId}/members`, token, apiUrl, orgId);
  return data.members ?? [];
}
async function removeMember(userId, token, orgId, apiUrl = DEFAULT_API_URL) {
  await apiDelete(`/organizations/${orgId}/members/${userId}`, token, apiUrl, orgId);
}
async function login(apiUrl = DEFAULT_API_URL) {
  const { token: authToken } = await deviceFlowLogin(apiUrl);
  const user = await apiGet("/me", authToken, apiUrl);
  const userName = user.name || (user.email ? user.email.split("@")[0] : "unknown");
  process.stderr.write(`
Logged in as: ${userName}
`);
  const orgs = await listOrgs(authToken, apiUrl);
  let orgId;
  let orgName;
  if (orgs.length === 1) {
    orgId = orgs[0].id;
    orgName = orgs[0].name;
    process.stderr.write(`Organization: ${orgName}
`);
  } else {
    process.stderr.write("\nOrganizations:\n");
    orgs.forEach((org, i) => process.stderr.write(`  ${i + 1}. ${org.name}
`));
    orgId = orgs[0].id;
    orgName = orgs[0].name;
    process.stderr.write(`
Using: ${orgName}
`);
  }
  const tokenName = `deeplake-plugin-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
  const tokenData = await apiPost("/users/me/tokens", {
    name: tokenName,
    duration: 365 * 24 * 3600,
    organization_id: orgId
  }, authToken, apiUrl);
  const apiToken = tokenData.token.token;
  const creds = {
    token: apiToken,
    orgId,
    orgName,
    userName,
    workspaceId: "default",
    apiUrl,
    savedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  saveCredentials(creds);
  return creds;
}

// dist/src/commands/auth-login.js
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "whoami";
  const creds = loadCredentials();
  const apiUrl = creds?.apiUrl ?? "https://api.deeplake.ai";
  switch (cmd) {
    case "login": {
      await login(apiUrl);
      break;
    }
    case "whoami": {
      if (!creds) {
        console.log("Not logged in. Run: node auth-login.js login");
        break;
      }
      console.log(`User org: ${creds.orgName ?? creds.orgId}`);
      console.log(`Workspace: ${creds.workspaceId ?? "default"}`);
      console.log(`API: ${creds.apiUrl ?? "https://api.deeplake.ai"}`);
      break;
    }
    case "org": {
      if (!creds) {
        console.log("Not logged in.");
        process.exit(1);
      }
      const sub = args[1];
      if (sub === "list") {
        const orgs = await listOrgs(creds.token, apiUrl);
        orgs.forEach((o) => console.log(`${o.id}  ${o.name}`));
      } else if (sub === "switch") {
        const target = args[2];
        if (!target) {
          console.log("Usage: org switch <org-name-or-id>");
          process.exit(1);
        }
        const orgs = await listOrgs(creds.token, apiUrl);
        const match = orgs.find((o) => o.id === target || o.name.toLowerCase() === target.toLowerCase());
        if (!match) {
          console.log(`Org not found: ${target}`);
          process.exit(1);
        }
        await switchOrg(match.id, match.name);
        console.log(`Switched to org: ${match.name}`);
      } else {
        console.log("Usage: org list | org switch <name-or-id>");
      }
      break;
    }
    case "workspaces": {
      if (!creds) {
        console.log("Not logged in.");
        process.exit(1);
      }
      const ws = await listWorkspaces(creds.token, apiUrl, creds.orgId);
      ws.forEach((w) => console.log(`${w.id}  ${w.name}`));
      break;
    }
    case "workspace": {
      if (!creds) {
        console.log("Not logged in.");
        process.exit(1);
      }
      const wsId = args[1];
      if (!wsId) {
        console.log("Usage: workspace <id>");
        process.exit(1);
      }
      await switchWorkspace(wsId);
      console.log(`Switched to workspace: ${wsId}`);
      break;
    }
    case "invite": {
      if (!creds) {
        console.log("Not logged in.");
        process.exit(1);
      }
      const email = args[1];
      const mode = args[2]?.toUpperCase() ?? "WRITE";
      if (!email) {
        console.log("Usage: invite <email> [ADMIN|WRITE|READ]");
        process.exit(1);
      }
      await inviteMember(email, mode, creds.token, creds.orgId, apiUrl);
      console.log(`Invited ${email} with ${mode} access`);
      break;
    }
    case "members": {
      if (!creds) {
        console.log("Not logged in.");
        process.exit(1);
      }
      const members = await listMembers(creds.token, creds.orgId, apiUrl);
      members.forEach((m) => console.log(`${m.role.padEnd(8)} ${m.email ?? m.name}`));
      break;
    }
    case "remove": {
      if (!creds) {
        console.log("Not logged in.");
        process.exit(1);
      }
      const userId = args[1];
      if (!userId) {
        console.log("Usage: remove <user-id>");
        process.exit(1);
      }
      await removeMember(userId, creds.token, creds.orgId, apiUrl);
      console.log(`Removed user ${userId}`);
      break;
    }
    default:
      console.log("Commands: login, whoami, org list, org switch, workspaces, workspace, invite, members, remove");
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
