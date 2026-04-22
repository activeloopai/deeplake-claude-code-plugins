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
  test: {
    include: [
      "claude-code/tests/**/*.test.ts",
      "codex/tests/**/*.test.ts",
    ],
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
        // coverage via claude-code/tests/shell-bundle-*.test.ts instead.
        "src/shell/deeplake-shell.ts",
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
      },
    },
  },
});
