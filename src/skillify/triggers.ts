/**
 * Shared trigger helpers used by every agent's capture / session-end hooks.
 *
 * Two trigger paths:
 *   - tryStopCounterTrigger: increment per-project counter on each Stop /
 *     assistant-complete event; fire the worker when counter >= threshold.
 *   - forceSessionEndTrigger: always fire the worker on session end,
 *     regardless of counter (catches tail-of-session knowledge that the
 *     mid-session counter trigger would miss).
 *
 * Both are no-ops when cwd is empty or HIVEMIND_SKILLIFY_WORKER=1 (recursion
 * guard). Both spawn the worker as a detached subprocess via
 * spawnSkillifyWorker; they never block the calling hook.
 */

import type { Config } from "../config.js";
import { spawnSkillifyWorker, skillifyLog } from "./spawn-skillify-worker.js";
import {
  bumpStopCounter,
  resetCounter,
  tryAcquireWorkerLock,
  releaseWorkerLock,
  deriveProjectKey,
  readState,
  TRIGGER_THRESHOLD,
} from "./state.js";
import { loadScopeConfig } from "./scope-config.js";

export interface TriggerOptions {
  config: Config;
  cwd: string;
  bundleDir: string;
  agent: string;          // "claude_code" | "codex" | "cursor" | "hermes"
  sessionId?: string;     // current session — excluded from mining
}

/**
 * Per-Stop trigger: increment counter, fire worker if threshold reached.
 * Caller is responsible for invoking only on assistant-complete events
 * (Stop, afterAgentResponse, post_llm_call, etc. depending on agent).
 */
export function tryStopCounterTrigger(opts: TriggerOptions): void {
  if (process.env.HIVEMIND_SKILLIFY_WORKER === "1") return;
  if (!opts.cwd) return;

  try {
    const state = bumpStopCounter(opts.cwd);
    if (state.counter < TRIGGER_THRESHOLD) return;

    if (!tryAcquireWorkerLock(state.projectKey)) {
      skillifyLog(`Stop: trigger suppressed (worker lock held) project=${state.project}`);
      return;
    }

    skillifyLog(`Stop: threshold hit (counter=${state.counter}, N=${TRIGGER_THRESHOLD}) project=${state.project} agent=${opts.agent}`);
    resetCounter(state.projectKey);

    try {
      spawnSkillifyWorker({
        config: opts.config,
        cwd: opts.cwd,
        projectKey: state.projectKey,
        project: state.project,
        bundleDir: opts.bundleDir,
        agent: opts.agent,
        scopeConfig: loadScopeConfig(),
        currentSessionId: opts.sessionId,
        reason: "Stop",
      });
    } catch (e: any) {
      skillifyLog(`Stop spawn failed: ${e?.message ?? e}`);
      try { releaseWorkerLock(state.projectKey); } catch { /* best effort */ }
    }
  } catch (e: any) {
    skillifyLog(`Stop trigger error: ${e?.message ?? e}`);
  }
}

/**
 * SessionEnd trigger: always fire the worker, regardless of counter.
 * Catches tail-of-session content and works in agents/modes where Stop
 * doesn't fire reliably (e.g. claude -p one-shot).
 */
export function forceSessionEndTrigger(opts: TriggerOptions): void {
  if (process.env.HIVEMIND_SKILLIFY_WORKER === "1") return;
  if (!opts.cwd) return;

  try {
    const { key: projectKey, project } = deriveProjectKey(opts.cwd);

    if (!tryAcquireWorkerLock(projectKey)) {
      skillifyLog(`SessionEnd: skillify worker already running for ${projectKey}, skipping`);
      return;
    }

    if (readState(projectKey)) {
      // Reset the counter so a Stop trigger doesn't double-fire on the
      // same window of activity right after this run.
      resetCounter(projectKey);
    }

    skillifyLog(`SessionEnd: spawning skillify worker for project=${project} agent=${opts.agent}`);
    try {
      spawnSkillifyWorker({
        config: opts.config,
        cwd: opts.cwd,
        projectKey,
        project,
        bundleDir: opts.bundleDir,
        agent: opts.agent,
        scopeConfig: loadScopeConfig(),
        currentSessionId: opts.sessionId,
        reason: "SessionEnd",
      });
    } catch (e: any) {
      skillifyLog(`SessionEnd spawn failed: ${e?.message ?? e}`);
      try { releaseWorkerLock(projectKey); } catch { /* best effort */ }
    }
  } catch (e: any) {
    skillifyLog(`SessionEnd trigger error: ${e?.message ?? e}`);
  }
}
