/**
 * Assertion execution + the SQL/log helpers cases use to write their
 * expectations.
 *
 * Each assertion type from types.ts has a runner here. They all return
 * `null` on pass, or a `string` describing the failure on fail. The
 * runner collects every failure (we don't short-circuit) so a flaky-
 * looking case gets a full failure report, not just the first thing
 * that broke.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DeeplakeApi } from "../../src/deeplake-api.js";
import type {
  Assertion,
  AssertionContext,
  CaseContext,
  RunResult,
} from "./types.js";

export interface AssertionRunner {
  /** Returns null on pass, or a failure-reason string on fail. */
  run: (assertion: Assertion, ctx: AssertionContext) => Promise<string | null>;
}

/**
 * Build an assertion runner bound to the test workspace. `api` is reused
 * across all assertions of one case to avoid re-paying DeeplakeApi
 * construction cost on every assertion.
 */
export function makeAssertionRunner(ctx: CaseContext): AssertionRunner {
  const api = new DeeplakeApi(
    ctx.creds.token,
    ctx.creds.apiUrl,
    ctx.creds.orgId,
    ctx.creds.workspaceId,
    ctx.creds.sessionsTable,
  );
  return {
    async run(assertion, actx) {
      try {
        switch (assertion.type) {
          case "stdout-contains":
            return checkStdoutContains(assertion, actx.run);
          case "stdout-matches":
            return checkStdoutMatches(assertion, actx.run);
          case "select-from-db": {
            const rows = await api.query(assertion.sql(actx));
            try {
              assertion.expect(rows);
              return null;
            } catch (e: unknown) {
              return labelled(
                assertion.label ?? "select-from-db",
                e instanceof Error ? e.message : String(e),
              );
            }
          }
          case "hook-log-contains":
            return checkHookLogContains(assertion, ctx.home);
          case "custom":
            try {
              return await assertion.check(actx);
            } catch (e: unknown) {
              return labelled(assertion.label, e instanceof Error ? e.message : String(e));
            }
        }
      } catch (e: unknown) {
        return labelled(
          (assertion as { label?: string }).label ?? assertion.type,
          `runner threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

function checkStdoutContains(
  a: Extract<Assertion, { type: "stdout-contains" }>,
  run: RunResult,
): string | null {
  if (run.stdout.includes(a.substring)) return null;
  return labelled(
    a.label ?? "stdout-contains",
    `expected stdout to contain ${JSON.stringify(a.substring)}; got ${truncate(run.stdout, 400)}`,
  );
}

function checkStdoutMatches(
  a: Extract<Assertion, { type: "stdout-matches" }>,
  run: RunResult,
): string | null {
  if (a.regex.test(run.stdout)) return null;
  return labelled(
    a.label ?? "stdout-matches",
    `expected stdout to match ${a.regex}; got ${truncate(run.stdout, 400)}`,
  );
}

function checkHookLogContains(
  a: Extract<Assertion, { type: "hook-log-contains" }>,
  home: string,
): string | null {
  const logPath = join(home, ".deeplake", "hook-debug.log");
  if (!existsSync(logPath)) {
    return labelled(
      a.label ?? "hook-log-contains",
      `${logPath} does not exist — hook never ran, or HIVEMIND_DEBUG=1 was not set`,
    );
  }
  const text = readFileSync(logPath, "utf-8");
  if (text.includes(a.substring)) return null;
  return labelled(
    a.label ?? "hook-log-contains",
    `expected hook log to contain ${JSON.stringify(a.substring)}; got ${truncate(text, 400)}`,
  );
}

function labelled(label: string, msg: string): string {
  return `[${label}] ${msg}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}... (${s.length - max} more chars)`;
}

/**
 * After a case completes (pass or fail), the runner calls this to delete
 * the rows it created. Keeps the e2e workspace from accumulating debris.
 * Best-effort: a failed cleanup is logged but does NOT fail the case.
 *
 * `sessionId` is the value discovered after the run (i.e. `run.sessionId`).
 * The seed in `ctx.sessionId` is only used when the driver couldn't
 * recover the agent's actual session_id, in which case the seed value
 * was also what got written to the DB so it still matches.
 */
export async function cleanupSessionRows(
  ctx: CaseContext,
  sessionId: string,
): Promise<{ deletedSessions: number; deletedMemory: number; error: string | null }> {
  const sessionsApi = new DeeplakeApi(
    ctx.creds.token,
    ctx.creds.apiUrl,
    ctx.creds.orgId,
    ctx.creds.workspaceId,
    ctx.creds.sessionsTable,
  );
  const memoryApi = new DeeplakeApi(
    ctx.creds.token,
    ctx.creds.apiUrl,
    ctx.creds.orgId,
    ctx.creds.workspaceId,
    ctx.creds.memoryTable,
  );
  // Deeplake SQL supports DELETE ... WHERE. Match the session id the
  // agent actually used; bounded scope by construction. Both tables use
  // the same `path` convention — the path embeds the session_id. Use
  // ILIKE '%<sid>%' to catch both /sessions/<sid>/... and /<sid>/...
  // shapes.
  const sidLike = `%${sessionId}%`;
  let deletedSessions = 0;
  let deletedMemory = 0;
  let error: string | null = null;
  try {
    const sessionsResult = await sessionsApi.query(
      `DELETE FROM "${ctx.creds.sessionsTable}" WHERE path ILIKE '${sidLike.replace(/'/g, "''")}'`,
    );
    deletedSessions = sessionsResult.length;
  } catch (e: unknown) {
    error = `sessions cleanup failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    const memoryResult = await memoryApi.query(
      `DELETE FROM "${ctx.creds.memoryTable}" WHERE path ILIKE '${sidLike.replace(/'/g, "''")}'`,
    );
    deletedMemory = memoryResult.length;
  } catch (e: unknown) {
    const msg = `memory cleanup failed: ${e instanceof Error ? e.message : String(e)}`;
    error = error ? `${error}; ${msg}` : msg;
  }
  return { deletedSessions, deletedMemory, error };
}
