/**
 * Bundle-level regression guard for fix #3 — the shell bundle invoked by the
 * pre-tool-use hook as `node shell-bundle -c "..."` must not leak
 * `[deeplake-sql]` trace output onto stderr. Claude Code's Bash tool merges
 * the child process's stderr into the tool_result string the model sees, so
 * any trace line shows up as noise in Claude's view of the command output
 * (observed in the original `baseline_cloud-100` transcripts, where 35+
 * lines of `[deeplake-sql]` noise polluted bash command results).
 *
 * The fix has two parts:
 *   1. `traceSql` reads the HIVEMIND_TRACE_SQL / HIVEMIND_DEBUG env vars at
 *      call time (not at module load), so callers can turn tracing off after
 *      importing the SDK.
 *   2. The shell bundle's one-shot entry point (`node ... -c "cmd"`) deletes
 *      those env vars before opening any SQL connection.
 *
 * This test spawns the shipped shell bundle with the trace vars set
 * explicitly, runs a trivial command that's guaranteed not to touch the
 * network (we point the SDK at an unreachable URL and expect the command to
 * fail fast), and asserts that the combined stderr output contains zero
 * `[deeplake-sql]` lines. If either fix is reverted, stderr fills with the
 * trace messages and the test fails.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(__dirname, "..", "bundle", "shell", "deeplake-shell.js");

describe("shell bundle one-shot: SQL trace silence (fix #3)", () => {
  it("does not write [deeplake-sql] to stderr even when trace env vars are set", () => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(`shell bundle missing at ${BUNDLE_PATH} — run 'npm run build' first`);
    }

    // Drive the bundle through a path that DEFINITELY calls DeeplakeApi.query()
    // (so traceSql fires). Fake creds are good enough — the API call will fail
    // fast against an unreachable host, and if the trace silencer regresses,
    // the first `[deeplake-sql] query start:` line hits stderr before the
    // failure. Point at 127.0.0.1:1 (closed port) with a 200ms timeout so the
    // test finishes in well under a second.
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HIVEMIND_TOKEN: "fake-token-for-trace-test",
      HIVEMIND_ORG_ID: "fake-org",
      HIVEMIND_WORKSPACE_ID: "fake-ws",
      HIVEMIND_API_URL: "http://127.0.0.1:1",
      HIVEMIND_QUERY_TIMEOUT_MS: "200",
      // Pre-silenced env: our fix must keep these from leaking stderr.
      HIVEMIND_TRACE_SQL: "1",
      DEEPLAKE_TRACE_SQL: "1",
      HIVEMIND_DEBUG: "1",
      DEEPLAKE_DEBUG: "1",
    };

    const result = spawnSync(process.execPath, [BUNDLE_PATH, "-c", "echo hello"], {
      env: cleanEnv,
      encoding: "utf-8",
      timeout: 15_000,
    });

    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // With the one-shot silencer in place there must be zero SQL trace lines,
    // even though the bundle issued SQL queries (that then failed against the
    // unreachable host). If the fix regresses, expect lines like:
    //   "[deeplake-sql] query start: SELECT path, size_bytes ..."
    expect(combined).not.toContain("[deeplake-sql]");
  }, 20_000);

  it("keeps interactive mode tracing available (env vars not deleted outside one-shot)", () => {
    // Sanity check that the one-shot silencing is scoped: traceSql source
    // still honours the env vars, so interactive usage (no -c) with
    // HIVEMIND_TRACE_SQL=1 would still emit trace lines. We can't easily
    // spawn the REPL here, so we just verify the condition in source — this
    // guards against an over-eager fix that silences tracing globally.
    const { readFileSync } = require("node:fs");
    const apiSource = readFileSync(join(__dirname, "..", "..", "src", "deeplake-api.ts"), "utf-8");
    expect(apiSource).toMatch(/function traceSql\([^)]*\): void \{[\s\S]*process\.env\.HIVEMIND_TRACE_SQL/);
    // Ensure the env read is inside the function (runtime), not a top-level const.
    expect(apiSource).not.toMatch(/^const TRACE_SQL =/m);
  });
});
