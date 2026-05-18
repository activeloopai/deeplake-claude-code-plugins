/**
 * Per-case filesystem sandbox.
 *
 * For each (case, agent) tuple we want:
 *   1. A fresh HOME that no other case can read or write
 *   2. A `~/.deeplake/credentials.json` pointing at the e2e test workspace
 *   3. The agent's hivemind bundle deposited at the agent-specific path
 *      under that HOME (or a session-only plugin flag — see claude-code).
 *
 * We DO NOT share HOMEs across cases even within a single agent. Reasons:
 *   - The hivemind hook writes ~/.deeplake/hook-debug.log; reusing the
 *     HOME means cross-case log contamination breaks the
 *     `hook-log-contains` assertion's "occurred during MY case" guarantee.
 *   - Some agents cache plugin state by content-hash; a stale cache from
 *     case 1 has been observed to mask a case-2 install failure.
 *
 * Cleanup is rm -rf of the tmp HOME at the end of each case. The caller
 * may pass `keepSandbox: true` to leave it on disk for debugging.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { AgentId, TestCredentials } from "./types.js";

/**
 * Per-agent auth files the agent CLI reads from $HOME. When the harness
 * overrides HOME for sandbox isolation, the agent loses access to its
 * own auth (logged-in OAuth token, model API key, etc.) and exits 1 with
 * an unhelpful empty stderr.
 *
 * We copy these files into the tmp HOME at sandbox creation so the agent
 * authenticates against its real provider while hivemind's writes still
 * route to ~/.deeplake/credentials.json (which we DID isolate — the test
 * workspace creds, not the operator's real ones).
 *
 * Discovery via `find ~/<agent-home> -name "*credentials*" -o -name "*auth*" -o -name "*config.json"`
 * on a real logged-in dev box. Per-agent path lists are minimal — extra
 * files are skipped by the existsSync check at copy time.
 */
const AGENT_AUTH_FILES: Record<AgentId, string[]> = {
  "claude-code":  [".claude/.credentials.json", ".claude/config.json"],
  "codex":        [".codex/auth.json"],
  "cursor-agent": [".cursor/cli-config.json"],
  "hermes":       [".hermes/auth.json"],
  "pi":           [".pi/agent/auth.json"],
  "openclaw":     [], // openclaw driver fires plugin events directly, no agent CLI auth needed
};

export interface Sandbox {
  home: string;
  /** Delete the sandbox. Idempotent. */
  destroy: () => void;
}

/**
 * Create a fresh tmp HOME and seed it with the e2e workspace credentials.
 *
 * Returns a {home, destroy} pair. Caller is responsible for calling
 * destroy() in a finally block (or for passing `keepSandbox` and cleaning
 * up out-of-band).
 */
export function createSandbox(agent: AgentId, creds: TestCredentials): Sandbox {
  const home = mkdtempSync(join(tmpdir(), `hm-e2e-${agent}-`));
  const deeplakeDir = join(home, ".deeplake");
  mkdirSync(deeplakeDir, { recursive: true, mode: 0o700 });
  // saveCredentials() in src/commands/auth-creds.ts is lazy on HOME, but
  // we write the file directly here so we don't depend on any module's
  // current process.env.HOME at write time. credentials.json's `savedAt`
  // is a free-form ISO string per the type.
  const payload = {
    token: creds.token,
    orgId: creds.orgId,
    orgName: creds.orgName,
    workspaceId: creds.workspaceId,
    apiUrl: creds.apiUrl,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(deeplakeDir, "credentials.json"),
    JSON.stringify(payload, null, 2),
    { mode: 0o600 },
  );

  // Copy the agent's own auth files so it can reach its model provider
  // when spawned under the tmp HOME. Without these, claude-code et al
  // would lose their OAuth/SSO token and exit 1 silently. We copy only
  // the agent's OWN auth files, NOT hivemind state — credentials for
  // Deeplake remain isolated to the test workspace above.
  const realHome = homedir();
  for (const relPath of AGENT_AUTH_FILES[agent]) {
    const src = join(realHome, relPath);
    if (!existsSync(src)) continue; // agent not logged in on this machine; spawn will fail with a clear error
    const dst = join(home, relPath);
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    copyFileSync(src, dst);
  }

  return {
    home,
    destroy: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Best-effort. A leftover tmp dir is annoying but never blocks a run.
      }
    },
  };
}

/**
 * Build a deterministic session_id for this (case, agent, runId) tuple.
 *
 * Embeds the runId so that cleanup queries can sweep all rows from one
 * harness invocation in a single statement, and the agent label so a
 * single case×agent failure can be inspected without grepping every row.
 * Prefix `e2e-` makes the daily cron pattern (`WHERE agent ILIKE 'e2e-%'`)
 * tractable in case something escapes the per-run cleanup.
 */
export function buildSessionId(caseId: string, agent: AgentId, runId: string): string {
  return `e2e-${runId}-${caseId}-${agent}`;
}
