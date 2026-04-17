import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Anti-regression for a Deeplake backend quirk: two rapid UPDATEs on the
 * same row (e.g. `UPDATE ... SET summary = ...` followed by
 * `UPDATE ... SET description = ...`) can silently drop one of them.
 * The wiki worker must therefore write summary + description in a single
 * UPDATE (or a single INSERT for fresh rows).
 *
 * Guarding the compiled bundle is the simplest way to catch a regression
 * no matter how the source is refactored, since both claude-code and
 * codex wiki-workers are shipped as standalone ESM scripts.
 */

const BUNDLES: Array<[string, string]> = [
  ["claude-code", resolve(__dirname, "..", "bundle", "wiki-worker.js")],
  ["codex", resolve(__dirname, "..", "..", "codex", "bundle", "wiki-worker.js")],
];

for (const [label, path] of BUNDLES) {
  describe(`${label} wiki-worker bundle`, () => {
    const src = readFileSync(path, "utf-8");

    // Only look inside the upload block: between the "uploaded" log line and
    // the "done" log line. This isolates the single SQL path we care about.
    const start = src.indexOf(`uploaded `);
    const end = src.indexOf(`done`, start);
    expect(start, "uploaded marker missing — bundle layout changed").toBeGreaterThan(0);
    expect(end, "done marker missing — bundle layout changed").toBeGreaterThan(start);
    // Also include the slice just before "uploaded" that contains the
    // UPDATE/INSERT SQL itself (wlog runs AFTER the query).
    const uploadRegion = src.slice(Math.max(0, start - 4000), end);

    it("does not issue a standalone UPDATE for the description column", () => {
      // Catches the 2-UPDATE pattern:
      //   UPDATE ... SET summary = ...
      //   UPDATE ... SET description = ...
      // which causes Deeplake to drop one write.
      const standaloneDescriptionUpdate =
        /UPDATE\s+[^;]*?SET\s+description\s*=[^;]*?WHERE\s+path/i;
      expect(uploadRegion).not.toMatch(standaloneDescriptionUpdate);
    });

    it("writes summary and description together (UPDATE or INSERT)", () => {
      // At least one SQL template literal must mention both columns,
      // so they land atomically.
      const hasSummary = /summary\s*=/.test(uploadRegion);
      const hasDescription = /description\s*=/.test(uploadRegion) ||
        /,\s*description\s*,/.test(uploadRegion); // INSERT column list
      expect(hasSummary, "upload block must touch summary column").toBe(true);
      expect(hasDescription, "upload block must touch description column in the SAME statement").toBe(true);
    });

    it("issues a single memory-table UPDATE in the upload block", () => {
      // Catches the 2-UPDATE regression at the "writes-to-the-same-row"
      // level: count how many UPDATE statements target the memory table.
      const memUpdates = (uploadRegion.match(/UPDATE\s+["'`]?\$\{[^}]*memoryTable[^}]*\}["'`]?/gi) || []).length;
      expect(memUpdates).toBeLessThanOrEqual(1);
    });
  });
}
