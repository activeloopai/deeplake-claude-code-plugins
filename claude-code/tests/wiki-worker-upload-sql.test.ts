import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Bundle-level anti-regression.
 *
 * The upload path is covered by upload-summary.test.ts at the source/unit
 * level. This file is a complementary guard that inspects the SHIPPED
 * bundles so the invariant survives bundler/import regressions too: the
 * compiled output must never contain a standalone UPDATE that sets only
 * the description column, because Deeplake drops one of two rapid
 * UPDATEs on the same row.
 */

const BUNDLES: Array<[string, string]> = [
  ["claude-code", resolve(__dirname, "..", "bundle", "wiki-worker.js")],
  ["codex", resolve(__dirname, "..", "..", "codex", "bundle", "wiki-worker.js")],
];

for (const [label, path] of BUNDLES) {
  describe(`${label} wiki-worker bundle`, () => {
    const src = readFileSync(path, "utf-8");

    it("bundle contains no UPDATE that sets only the description column", () => {
      const standaloneDescriptionUpdate =
        /UPDATE\s+[^;`]*?SET\s+description\s*=[^;`]*?WHERE\s+path/i;
      expect(src).not.toMatch(standaloneDescriptionUpdate);
    });

    it("bundle references both summary and description (upload writes both)", () => {
      expect(src).toMatch(/summary\s*=/);
      expect(src).toMatch(/description\s*=/);
    });
  });
}
