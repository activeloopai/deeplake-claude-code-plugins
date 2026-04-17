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
      ],
      // Per-file thresholds. Each PR that ships new files should append
      // its paths here with 80 / 80 / 80 / 80, so we prevent regressions
      // on the new code without having to first bring the whole
      // (~500-file) codebase up to 80%.
      thresholds: {
        // PR #60 — fix/grep-dual-table-and-normalize
        "src/shell/grep-core.ts": {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        "src/shell/grep-interceptor.ts": {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        "src/hooks/grep-direct.ts": {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
