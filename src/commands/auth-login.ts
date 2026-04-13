#!/usr/bin/env node

/**
 * CLI entry point for auth and org management.
 *
 * Usage:
 *   node auth-login.js login              — device flow login
 *   node auth-login.js logout             — remove credentials
 *   node auth-login.js org list           — list orgs
 *   node auth-login.js org switch <id>    — switch org
 *   node auth-login.js workspaces         — list workspaces
 *   node auth-login.js workspace <id>     — switch workspace
 *   node auth-login.js invite <email> <mode> — invite member
 *   node auth-login.js members            — list members
 *   node auth-login.js whoami             — show current user/org
 *   node auth-login.js sessions prune     — list/delete own sessions
 *   node auth-login.js update            — update plugin to latest version
 *   node auth-login.js autoupdate [on|off] — toggle automatic updates (default: on)
 */

import {
  login, loadCredentials, saveCredentials, listOrgs, switchOrg,
  listWorkspaces, switchWorkspace,
  inviteMember, listMembers, removeMember,
} from "./auth.js";
import { sessionPrune } from "./session-prune.js";

async function main(): Promise<void> {
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
      if (!creds) { console.log("Not logged in. Run: node auth-login.js login"); break; }
      console.log(`User org: ${creds.orgName ?? creds.orgId}`);
      console.log(`Workspace: ${creds.workspaceId ?? "default"}`);
      console.log(`API: ${creds.apiUrl ?? "https://api.deeplake.ai"}`);
      break;
    }

    case "org": {
      if (!creds) { console.log("Not logged in."); process.exit(1); }
      const sub = args[1];
      if (sub === "list") {
        const orgs = await listOrgs(creds.token, apiUrl);
        orgs.forEach(o => console.log(`${o.id}  ${o.name}`));
      } else if (sub === "switch") {
        const target = args[2];
        if (!target) { console.log("Usage: org switch <org-name-or-id>"); process.exit(1); }
        const orgs = await listOrgs(creds.token, apiUrl);
        const match = orgs.find(o => o.id === target || o.name.toLowerCase() === target.toLowerCase());
        if (!match) { console.log(`Org not found: ${target}`); process.exit(1); }
        await switchOrg(match.id, match.name);
        console.log(`Switched to org: ${match.name}`);
      } else {
        console.log("Usage: org list | org switch <name-or-id>");
      }
      break;
    }

    case "workspaces": {
      if (!creds) { console.log("Not logged in."); process.exit(1); }
      const ws = await listWorkspaces(creds.token, apiUrl, creds.orgId);
      ws.forEach(w => console.log(`${w.id}  ${w.name}`));
      break;
    }

    case "workspace": {
      if (!creds) { console.log("Not logged in."); process.exit(1); }
      const wsId = args[1];
      if (!wsId) { console.log("Usage: workspace <id>"); process.exit(1); }
      await switchWorkspace(wsId);
      console.log(`Switched to workspace: ${wsId}`);
      break;
    }

    case "invite": {
      if (!creds) { console.log("Not logged in."); process.exit(1); }
      const email = args[1];
      const mode = (args[2]?.toUpperCase() ?? "WRITE") as "ADMIN" | "WRITE" | "READ";
      if (!email) { console.log("Usage: invite <email> [ADMIN|WRITE|READ]"); process.exit(1); }
      await inviteMember(email, mode, creds.token, creds.orgId, apiUrl);
      console.log(`Invited ${email} with ${mode} access`);
      break;
    }

    case "members": {
      if (!creds) { console.log("Not logged in."); process.exit(1); }
      const members = await listMembers(creds.token, creds.orgId, apiUrl);
      members.forEach(m => console.log(`${m.role.padEnd(8)} ${m.email ?? m.name}`));
      break;
    }

    case "remove": {
      if (!creds) { console.log("Not logged in."); process.exit(1); }
      const userId = args[1];
      if (!userId) { console.log("Usage: remove <user-id>"); process.exit(1); }
      await removeMember(userId, creds.token, creds.orgId, apiUrl);
      console.log(`Removed user ${userId}`);
      break;
    }

    case "sessions": {
      const sub = args[1];
      if (sub === "prune") {
        await sessionPrune(args.slice(2));
      } else {
        console.log("Usage: sessions prune [--all | --before <date> | --session-id <id>] [--yes]");
      }
      break;
    }

    case "autoupdate": {
      if (!creds) { console.log("Not logged in."); process.exit(1); }
      const val = args[1]?.toLowerCase();
      if (val === "on" || val === "true") {
        saveCredentials({ ...creds, autoupdate: true });
        console.log("Autoupdate enabled. Plugin will update automatically on session start.");
      } else if (val === "off" || val === "false") {
        saveCredentials({ ...creds, autoupdate: false });
        console.log("Autoupdate disabled. You'll see a notice when updates are available.");
      } else {
        const current = creds.autoupdate !== false ? "on" : "off";
        console.log(`Autoupdate is currently: ${current}`);
        console.log("Usage: autoupdate [on|off]");
      }
      break;
    }

    case "logout": {
      const { existsSync, unlinkSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const credFile = join(homedir(), ".deeplake", "credentials.json");
      if (existsSync(credFile)) {
        unlinkSync(credFile);
        console.log("Logged out. Credentials removed.");
      } else {
        console.log("Not logged in.");
      }
      break;
    }

    default:
      console.log("Commands: login, logout, whoami, org list, org switch, workspaces, workspace, sessions prune, invite, members, remove, autoupdate");
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
