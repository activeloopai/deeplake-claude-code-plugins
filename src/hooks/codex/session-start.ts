#!/usr/bin/env node

/**
 * Codex SessionStart hook (fast path):
 * Only reads local credentials and injects context into Codex's developer prompt.
 * All server calls (table setup, placeholder, version check) are handled by
 * session-start-setup.js which runs as a separate async hook.
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model, source }
 * Codex output: plain text on stdout (added as developer context)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { readStdin } from "../../utils/stdin.js";
import { countLocalManifestEntries } from "../../skillify/local-manifest.js";
import { maybeAutoMineLocal } from "../../skillify/spawn-mine-local-worker.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { autoPullSkills } from "../../skillify/auto-pull.js";
const log = (msg: string) => _log("codex-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Codex DOES NOT have a model-only context channel for SessionStart hooks: any
// `additionalContext` we emit is rendered as a `hook context: <text>` history
// cell, user-visible. The big DEEPLAKE MEMORY tier doc + hivemind/skillify
// command list that Claude Code's hook injects via `additionalContext` would
// clobber the Codex UI every session, so we omit it entirely here. Codex's
// skill autoloader already exposes the hivemind/* skills as Skill tool entries,
// and the model can discover memory tiers and CLI flags on demand via bash.
// See src/notifications/AGENT_CHANNELS.md → "Codex" for the source-level reasoning.

interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexSessionStartInput>();

  const creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — run auth login to authenticate");
    const auto = maybeAutoMineLocal();
    log(`auto-mine: ${auto.triggered ? "triggered (background)" : `skipped (${auto.reason})`}`);
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }

  // Spawn async setup (table creation, placeholder, version check) as detached process.
  // Codex doesn't support async hooks, so we use the same pattern as the wiki worker.
  if (creds?.token) {
    const setupScript = join(__bundleDir, "session-start-setup.js");
    const child = spawn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env },
    });
    // Feed the same stdin input to the setup process
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    log("spawned async setup process");
  }

  // Auto-pull skills from all org users on every SessionStart (5s timeout).
  // File writes inside runPull are idempotent (skipped when local version
  // is at-or-newer than remote), so re-running every session is cheap on
  // disk; the only per-call cost is the SQL round-trip. autoPullSkills
  // never rejects — all errors are swallowed inside. Hard opt-out:
  // HIVEMIND_AUTOPULL_DISABLED=1.
  const pullResult = await autoPullSkills();
  log(`autopull: pulled=${pullResult.pulled} skipped=${pullResult.skipped}`);

  let versionNotice = "";
  const current = getInstalledVersion(__bundleDir, ".codex-plugin");
  if (current) {
    versionNotice = `\nHivemind v${current}`;
  }

  const localMined = countLocalManifestEntries();
  const skillNoun = localMined === 1 ? "skill" : "skills";

  // Codex SessionStart output schema (verified against
  // https://developers.openai.com/codex/hooks and codex-rs source @ 0.130.0):
  //   - `systemMessage` (top-level): warning shown to the user in the TUI
  //     history cell as `warning: <text>`. Use sparingly — every line lands
  //     in the user's face. Only set on real CTAs.
  //   - `hookSpecificOutput.additionalContext`: ALSO user-visible in Codex,
  //     rendered as `hook context: <text>` in the same history cell. Unlike
  //     Claude Code (where additionalContext is invisible system-prompt
  //     injection), Codex eagerly leaks the model's context to the user.
  //     `common::append_additional_context` in codex-rs pushes the string
  //     to BOTH the user-visible entries vec AND the model context vec —
  //     there is no model-only path. `suppressOutput: true` is parsed but
  //     ignored for SessionStart, so we can't hide it either.
  // Practical consequence: keep additionalContext MINIMAL on Codex. The
  // bulky DEEPLAKE MEMORY tier doc + hivemind/skillify command list that
  // claude-code's hook injects via `context` would clobber the Codex UI
  // every session. Codex's skill autoloader already exposes hivemind/skillify
  // command surfaces via per-skill SKILL.md files; the model can discover
  // memory tiers via `hivemind --help` and `ls ~/.deeplake/memory/` on demand.
  // We therefore emit only login-state + version here, and trust the model
  // to bootstrap the rest.
  const additionalContext = creds?.token
    ? `Hivemind: logged in as org ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"}).${versionNotice}`
    : `Hivemind: not logged in. Run \`hivemind login\` to enable shared memory + skill sharing.${versionNotice}`;

  const systemMessage = (!creds?.token && localMined > 0)
    ? `💡 ${localMined} ${skillNoun} mined from your local sessions live in ~/.claude/skills/. Run 'hivemind login' to share them with your team.`
    : undefined;
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
  if (systemMessage) output.systemMessage = systemMessage;
  console.log(JSON.stringify(output));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
