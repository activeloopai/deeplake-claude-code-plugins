/**
 * SessionStart auto-pull of skills from the org's `skills` Deeplake table.
 *
 * Why: teammates mine reusable skills constantly via the skillify worker. Without
 * an auto-pull, every user has to remember to run `hivemind skillify pull
 * --all-users --to global` themselves. This module wires the pull into every
 * agent's SessionStart hook so freshly-mined skills become available without
 * manual intervention.
 *
 * Cadence + safety:
 *   - Runs on every SessionStart. No throttling — file writes inside `runPull`
 *     are already idempotent (`localVersion >= remoteVersion → skipped`,
 *     symlink fan-out is `lstat`-checked, manifest writes are sameSorted-skipped),
 *     so the only per-call cost is the SQL round-trip plus `existsSync` syscalls.
 *     This trades a small amount of redundant network traffic for fresher skills:
 *     a teammate who mines a new skill at 10:01 is visible to anyone who opens
 *     a session at 10:02, not anyone who opens at 10:32 (the old 30-min window).
 *   - Bounded by a 5-second timeout (overridable in tests via `timeoutMs`). A
 *     slow Deeplake never freezes SessionStart past that.
 *   - All failures swallowed — SessionStart must succeed regardless.
 *   - Hard opt-out via `HIVEMIND_AUTOPULL_DISABLED=1`.
 *   - Not-logged-in is a silent skip (no nag).
 *
 * Scope: install=global, users=[] (all-users), force=false. The result is
 * exactly equivalent to `hivemind skillify pull --all-users --to global`.
 */

import { loadConfig, type Config } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { runPull, type QueryFn } from "./pull.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("skillify-autopull", msg);

const DEFAULT_TIMEOUT_MS = 5_000;

export interface AutoPullResult {
  pulled: number;
  skipped: boolean;
  reason?: string;
}

export interface AutoPullDeps {
  /** Inject loadConfig (defaults to the real one). Tests pass a fixture/null. */
  loadConfigFn?: () => Config | null;
  /** Inject the SQL query function. Tests skip the network entirely with this. */
  queryFn?: QueryFn;
  /** Override the pull timeout for tests. */
  timeoutMs?: number;
  /** Override the install location. Defaults to "global"; tests use "project". */
  install?: "global" | "project";
  /** Working dir when install=project (tests). Ignored otherwise. */
  cwd?: string;
}

/** Bound a promise by `ms` milliseconds. Reject with a tagged error on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`autopull timeout after ${ms}ms`)), ms);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Top-level entry. Decides whether to skip (env / not-logged-in) and otherwise
 * runs a bounded, all-failures-swallowed pull.
 *
 * Always resolves; never rejects. The return value is informational only.
 */
export async function autoPullSkills(deps: AutoPullDeps = {}): Promise<AutoPullResult> {
  // Hard opt-out: env flag short-circuits before any disk / config read.
  if (process.env.HIVEMIND_AUTOPULL_DISABLED === "1") {
    log("disabled via HIVEMIND_AUTOPULL_DISABLED=1");
    return { pulled: 0, skipped: true, reason: "disabled" };
  }

  // Not logged in → silent skip (no nag).
  const loadFn = deps.loadConfigFn ?? loadConfig;
  const config = loadFn();
  if (!config) {
    log("skipped: not logged in");
    return { pulled: 0, skipped: true, reason: "not-logged-in" };
  }

  // Build the query function. Tests inject one; real callers get the API client.
  let query: QueryFn;
  if (deps.queryFn) {
    query = deps.queryFn;
  } else {
    const api = new DeeplakeApi(
      config.token,
      config.apiUrl,
      config.orgId,
      config.workspaceId,
      config.skillsTableName,
    );
    query = (sql: string) => api.query(sql) as Promise<Record<string, unknown>[]>;
  }

  const install = deps.install ?? "global";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const summary = await withTimeout(
      runPull({
        query,
        tableName: config.skillsTableName,
        install,
        cwd: install === "project" ? (deps.cwd ?? process.cwd()) : undefined,
        users: [],
        dryRun: false,
        force: false,
      }),
      timeoutMs,
    );
    log(`pulled scanned=${summary.scanned} wrote=${summary.wrote} skipped=${summary.skipped}`);
    return { pulled: summary.wrote, skipped: false };
  } catch (e: any) {
    log(`pull failed (swallowed): ${e?.message ?? e}`);
    return { pulled: 0, skipped: true, reason: "error" };
  }
}
