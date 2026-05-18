import { defineConfig } from "vitest/config";

// Root vitest config. `npm test` runs `vitest run` from the repo root, so
// this is the file that actually gets picked up. The one in claude-code/
// is a historical leftover and is not used by the root test script.
//
// Coverage thresholds are enforced per-file on the files touched by each
// PR. New files/PRs should add their paths to the `thresholds` block so
// the CI check grows over time instead of collapsing to a global average
// that hides regressions in new code.

export default defineConfig({
  // Match esbuild's `define` for __HIVEMIND_VERSION__ so source files that
  // read it directly (e.g. src/utils/client-header.ts) don't need a typeof
  // guard for tests. Bundled builds substitute the real version; tests get
  // the "dev" sentinel.
  define: {
    __HIVEMIND_VERSION__: JSON.stringify("dev"),
  },
  test: {
    include: [
      "tests/claude-code/**/*.test.ts",
      "tests/cli/**/*.test.ts",
      "tests/codex/**/*.test.ts",
      "tests/cursor/**/*.test.ts",
      "tests/hermes/**/*.test.ts",
      "tests/openclaw/**/*.test.ts",
      "tests/pi/**/*.test.ts",
    ],
    setupFiles: ["./tests/test-setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // `json` is needed by davelosert/vitest-coverage-report-action@v2 to
      // render per-file / per-line coverage in its PR comment (alongside the
      // aggregated json-summary). Without it the action emits a warning
      // about a missing coverage-final.json and falls back to the summary.
      reporter: ["text", "text-summary", "json", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/**/*.js",
        "src/**/*.js.map",
        // CLI entry points — `main()` calls process.exit(), so source-level
        // unit tests don't make sense. These files have subprocess-spawn
        // coverage via tests/claude-code/shell-bundle-*.test.ts instead.
        "src/shell/deeplake-shell.ts",
        // Skillify worker entry points: skillify-worker.ts parses cfg from
        // process.argv[2] at top level then runs main() which spawns
        // detached subprocesses; spawn-skillify-worker.ts is the spawner.
        // Both are excluded from vitest because they need a live Deeplake
        // workspace + a real agent CLI to exercise meaningfully.
        // Coverage on the SHIPPED bundle is enforced indirectly by
        // tests/claude-code/skillify-bundle-scan.test.ts (asserts the
        // skillify-worker.js bundle exists per agent and contains the
        // required entry strings + agent labels). For full e2e in
        // development, see the manual matrix script described in the
        // PR description (lives at /tmp/skillify-e2e-matrix.mjs in the
        // author's worktree, not committed).
        "src/skillify/skillify-worker.ts",
        "src/skillify/spawn-skillify-worker.ts",
      ],
      // Per-file thresholds. Each PR that ships new files should append
      // its paths here with 80 / 80 / 80 / 80, so we prevent regressions
      // on the new code without having to first bring the whole
      // (~500-file) codebase up to 80%.
      thresholds: {
        // PR #60 — fix/grep-dual-table-and-normalize.
        // Raised to 90 to surface the red path in the PR coverage comment
        // for metrics that sit between 80 and 90 (e.g. grep-core branches
        // at 83%). The actual long-term bar we want to hold is 80; revisit
        // once the PR has landed.
        "src/shell/grep-core.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/shell/grep-interceptor.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/grep-direct.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/session-queue.ts": {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // fix/index-md-include-sessions — 5-fix PR stacked on PR #61.
        // output-cap.ts is new in this PR (fix #5); virtual-table-query.ts was
        // heavily modified by fix #1 (index.md builder / fallback) and fix #4
        // (ESCAPE '\' on LIKE clauses). Held at 90 to match the rest of the
        // plugin-hot-path files already at that bar.
        "src/utils/output-cap.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/virtual-table-query.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // embedding_generation — nomic daemon + IPC client + SQL helper.
        // Lines/statements held at 90; branches + functions are allowed to
        // dip on the daemon because a few paths (SIGINT/SIGTERM handlers,
        // the non-Linux `typeof process.getuid !== "function"` fallback,
        // and the server "error" handler) can't be triggered from unit
        // tests without forking a real subprocess.
        "src/embeddings/client.ts": {
          statements: 90,
          branches: 80,
          functions: 90,
          lines: 90,
        },
        "src/embeddings/daemon.ts": {
          statements: 90,
          branches: 75,
          functions: 75,
          lines: 90,
        },
        "src/embeddings/nomic.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/embeddings/protocol.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/embeddings/sql.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/pre-tool-use.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/memory-path-utils.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // fix/plugin-autoupdate-session-safety — snapshot-restore around
        // claude-plugin update + SessionEnd GC. All four files at 90+.
        "src/utils/plugin-cache.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/plugin-cache-gc.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/session-start.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/hooks/session-start-setup.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // PR #76 — feat/openclaw-static-scan-clean. Two new files extracted
        // from auth.ts / deeplake-api.ts so the openclaw bundle could split
        // fs reads from fetch calls. Tests in tests/claude-code/{auth-creds,
        // index-marker-store}.test.ts cover both source modules above 90%.
        "src/commands/auth-creds.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/index-marker-store.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // PR #76 follow-up — coverage on the surface the bot flagged at 0%.
        // auth.ts mixes pure helpers (decodeJwt, apiGet/Post/Delete) with the
        // full device-flow login orchestration. Branches and functions sit
        // at ~88/83 because the openBrowser platform-switch and a few
        // login-flow corner cases (interactive prompts) are pragmatic to
        // skip; statements + lines both ≥96 so the safety bar holds.
        "src/commands/auth.ts": {
          statements: 90,
          branches: 80,
          functions: 80,
          lines: 90,
        },
        "src/deeplake-api.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // feat/unified-npx-installer — unified `hivemind` CLI + cursor /
        // hermes hook bundles + MCP server + utils/version-check helper.
        // Each new file held at the project-wide 80/80/80/80 bar.
        "src/cli/util.ts":              { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/version.ts":           { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/auth.ts":              { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/index.ts":             { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/update.ts":            { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-claude.ts":    { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-codex.ts":     { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-cursor.ts":    { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-hermes.ts":    { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-mcp-shared.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-openclaw.ts":  { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-pi.ts":        { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/commands/auth-login.ts":   { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/cursor/capture.ts":      { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/cursor/pre-tool-use.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/cursor/session-end.ts":  { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/cursor/session-start.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/hermes/capture.ts":      { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/hermes/pre-tool-use.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/hermes/session-end.ts":  { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/hermes/session-start.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/mcp/server.ts":            { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/utils/version-check.ts":   { statements: 80, branches: 80, functions: 80, lines: 80 },
        // feat/centralize-autoupdate — shared autoUpdate helper that every
        // session-start hook calls. Branches at 80 (not 90) because the
        // default-spawn child_process callbacks (close-with-null-code from
        // signal kill, the 'error' event-handler ack path) and the empty-
        // string success branch in findHivemindOnPath() can't be deterministically
        // triggered from unit tests without forking real subprocesses. Statements
        // + lines + functions held at 80; the gating + output-parsing logic
        // (the actually-load-bearing surface) is exhaustively tested.
        "src/hooks/shared/autoupdate.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        // feat/skillify — background skill-mining worker + CLI surface +
        // per-agent gate dispatch + Deeplake skills table for org provenance.
        // Most modules cleanly hit 90/90/90/90; the trio below sits a touch
        // lower on branches because their happy paths are well-covered but a
        // few error-recovery branches (lock-cleanup races, log-write failures
        // inside detached subprocesses) are pragmatic to leave at 75-80.
        // feat/session-start-autopull-skills — auto-pull all-author skills
        // at every SessionStart, throttled + bounded.
        "src/skillify/auto-pull.ts":         { statements: 90, branches: 70, functions: 90, lines: 90 },
        "src/skillify/extractors/index.ts":  { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/skillify/gate-parser.ts":       { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/skillify/gate-runner.ts":       { statements: 90, branches: 60, functions: 90, lines: 90 },
        // One-shot legacy state-dir migration. Branches at 80 because the
        // EXDEV/EPERM error-recovery branch is mocked via vi.doMock("node:fs")
        // and the uncaught-rethrow branch covers everything else implicitly.
        "src/skillify/legacy-migration.ts":  { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/skillify/pull.ts":              { statements: 90, branches: 75, functions: 90, lines: 90 },
        "src/skillify/scope-config.ts":      { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/skillify/skill-writer.ts":      { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/skillify/skills-table.ts":      { statements: 90, branches: 70, functions: 90, lines: 90 },
        "src/skillify/state.ts":             { statements: 80, branches: 70, functions: 90, lines: 80 },
        "src/skillify/triggers.ts":          { statements: 80, branches: 70, functions: 90, lines: 80 },
        "src/commands/skillify.ts":          { statements: 80, branches: 70, functions: 80, lines: 80 },
        // PR #96 — feat/notifications-framework. Centralized push-notification
        // framework + Claude Code dual-channel adapter (systemMessage + addCtx).
        // Most files at 100% via notifications.test.ts and notifications-coverage.test.ts.
        // session-notifications.ts is the SessionStart hook entry point — main()
        // is hard to unit-test directly because vi.spyOn(process.stdout) doesn't
        // intercept writes that happen during dynamic-import resolution. Bundle
        // smoke tests in notifications.test.ts cover the happy path through the
        // built artifact; the entry-point thresholds are calibrated to what we
        // can reliably measure without a subprocess spawn.
        "src/hooks/session-notifications.ts":     { statements: 60, branches: 50, functions: 50, lines: 90 },
        "src/notifications/types.ts":             { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/notifications/format.ts":            { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/notifications/index.ts":             { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/notifications/queue.ts":             { statements: 90, branches: 70, functions: 90, lines: 90 },
        "src/notifications/state.ts":             { statements: 90, branches: 75, functions: 90, lines: 90 },
        "src/notifications/rules/registry.ts":    { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/notifications/rules/welcome.ts":     { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/notifications/sources/backend.ts":   { statements: 90, branches: 90, functions: 80, lines: 90 },
        "src/notifications/delivery/index.ts":    { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/notifications/delivery/claude-code.ts": { statements: 90, branches: 90, functions: 90, lines: 90 },
        // feat/hivemind-savings-recap — per-session "Hivemind has saved you Nk tokens"
        // recap. Pure local arithmetic: parse session transcript for memory-grep
        // bytes, accumulate in ~/.deeplake/usage-stats.jsonl, render at SessionStart
        // using the published LoCoMo 1.7x multiplier (1,008 vs 1,700 tokens / Q).
        "src/notifications/transcript-parser.ts":   { statements: 90, branches: 75, functions: 90, lines: 90 },
        "src/notifications/usage-tracker.ts":       { statements: 90, branches: 75, functions: 90, lines: 90 },
        "src/notifications/sources/local-usage.ts": { statements: 90, branches: 80, functions: 90, lines: 90 },
        // feat/skillify-mine-local (PR #129) — `hivemind skillify mine-local`
        // seeds reusable skills from a fresh user's own local agent transcripts
        // without requiring Deeplake auth. New surface area:
        //   - src/skillify/local-source.ts          — agent/session detection + ε-greedy pick
        //   - src/skillify/local-manifest.ts        — on-disk manifest shared with hooks
        //   - src/skillify/spawn-mine-local-worker.ts — detached worker spawn helper
        //   - src/commands/mine-local.ts            — orchestrator + LLM gate dispatch
        //   - src/notifications/rules/local-mined.ts — surfaces mined count at SessionStart
        // mine-local.ts dips to 90 branches because a few short-circuit branches
        // inside runGateViaStdin (settled-flag race + the unreachable error
        // branch after spawn-already-errored) can't be deterministically
        // triggered without forking subprocesses; everything else holds at 90+.
        "src/skillify/local-source.ts":               { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/skillify/local-manifest.ts":             { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/skillify/spawn-mine-local-worker.ts":    { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/commands/mine-local.ts":                 { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/notifications/rules/local-mined.ts":     { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
