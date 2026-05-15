/**
 * Spawn a detached skillify worker. Mirror of spawn-wiki-worker.ts.
 *
 * The hook calls this when the per-project Stop counter crosses the
 * threshold. It writes a config JSON to tmpdir, spawns the worker,
 * and returns immediately. All heavy work (Deeplake fetch, model gate,
 * skill write) happens in the detached child.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, appendFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { Config } from "../config.js";
import { utcTimestamp } from "../utils/debug.js";
import { findAgentBin, type Agent } from "./gate-runner.js";

const HOME = homedir();
export const SKILLIFY_LOG = join(HOME, ".claude", "hooks", "skillify.log");

export function skillifyLog(msg: string): void {
  try {
    mkdirSync(dirname(SKILLIFY_LOG), { recursive: true });
    appendFileSync(SKILLIFY_LOG, `[${utcTimestamp()}] ${msg}\n`);
  } catch { /* ignore */ }
}

// Re-export from scope-config.ts so callers don't need a second import path.
export type { Scope, InstallLocation, ScopeConfig } from "./scope-config.js";
import type { ScopeConfig } from "./scope-config.js";

export interface SkillifySpawnOptions {
  config: Config;
  cwd: string;
  projectKey: string;
  project: string;
  bundleDir: string;
  agent: string;
  scopeConfig: ScopeConfig;
  /** session_id of the live session that triggered the spawn — excluded from mining */
  currentSessionId?: string;
  reason: string;
}

export function spawnSkillifyWorker(opts: SkillifySpawnOptions): void {
  const { config, cwd, projectKey, project, bundleDir, agent, scopeConfig, currentSessionId, reason } = opts;

  const tmpDir = join(tmpdir(), `deeplake-skillify-${projectKey}-${Date.now()}`);
  // mode 0o700: tmpDir holds config.json with the user's full-org Deeplake API token.
  // The file itself is written 0o600 below, but a world-readable directory still
  // leaks the file's existence + name to other users on the host. Mirror of the
  // Pi extension's spawnPiSkillifyWorker which already uses 0o700.
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  // Resolve the gate CLI for this agent up front (faster cold-start in the
  // worker, fail-fast if the binary doesn't exist on this machine).
  const gateBin = findAgentBin(agent as Agent);

  const configFile = join(tmpDir, "config.json");
  // The config file embeds the user's Deeplake API token (full org scope).
  // Write with mode 0o600 so other users on the same host can't read it
  // during the worker's lifetime (typically 30-60s before cleanup).
  writeFileSync(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    sessionsTable: config.sessionsTableName,
    skillsTable: config.skillsTableName,
    userName: config.userName,
    cwd,
    projectKey,
    project,
    agent,
    scope: scopeConfig.scope,
    team: scopeConfig.team,
    install: scopeConfig.install,
    tmpDir,
    gateBin,
    cursorModel: process.env.HIVEMIND_CURSOR_MODEL,
    hermesProvider: process.env.HIVEMIND_HERMES_PROVIDER,
    hermesModel: process.env.HIVEMIND_HERMES_MODEL,
    piProvider: process.env.HIVEMIND_PI_PROVIDER,
    piModel: process.env.HIVEMIND_PI_MODEL,
    skillifyLog: SKILLIFY_LOG,
    currentSessionId,
  }), { mode: 0o600 });
  // chmod again as a belt-and-suspenders against umask weirdness — some
  // file systems / overlay setups strip mode bits on the initial create.
  try { chmodSync(configFile, 0o600); } catch { /* best effort */ }

  skillifyLog(`${reason}: spawning skillify worker for project=${project} key=${projectKey}`);

  const workerPath = join(bundleDir, "skillify-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  skillifyLog(`${reason}: spawned skillify worker for ${projectKey}`);
}

export function bundleDirFromImportMeta(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
