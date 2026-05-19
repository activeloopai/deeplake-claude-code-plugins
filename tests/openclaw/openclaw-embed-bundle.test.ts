import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Bundle-level guard for issue #178.
 *
 * The shipped openclaw bundle MUST produce real embeddings (not silent
 * NULL) when the canonical shared daemon is available. The source-level
 * wiring is verified at openclaw/src/index.ts, but the actually-shipped
 * surface is openclaw/dist/index.js — a slip in the esbuild config
 * (e.g. an over-aggressive stub-unused-child-process matcher, a
 * tree-shake of the spawn-impl injection, or a re-introduced INSERT
 * that omits the embedding column) would silently regress capture
 * embeddings for every openclaw user. This file scans the artifact for
 * the load-bearing strings so the regression is caught at build time.
 */

const BUNDLE_PATH = resolve(process.cwd(), "openclaw", "dist", "index.js");
const SRC = readFileSync(BUNDLE_PATH, "utf-8");

describe("openclaw dist bundle — embeddings wiring", () => {
  it("imports the standalone embed client and the SQL literal helper", () => {
    expect(SRC).toContain("tryEmbedStandalone");
    expect(SRC).toContain("embeddingSqlLiteral");
  });

  it("calls tryEmbedStandalone exactly once on the auto-capture path", () => {
    // Count keeps us honest: more than one call site means refactor drift
    // (e.g. a partial duplicate INSERT block re-introduced by hand).
    const matches = SRC.match(/await tryEmbedStandalone\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("session INSERT column list includes message_embedding", () => {
    // The whole INSERT lives on one line in the minified bundle. Match
    // the column list between INSERT INTO "...sessions..." and VALUES.
    // Locking in the column NAME, not its position, so a future reorder
    // doesn't false-fail.
    const insertMatches = SRC.match(/INSERT INTO "\$\{sessionsTable[^"]*\}"\s*\([^)]+\)/g) ?? [];
    expect(insertMatches.length).toBeGreaterThanOrEqual(1);
    for (const m of insertMatches) {
      expect(m).toContain("message_embedding");
    }
  });

  it("injects the real spawn into the embed client at module load", () => {
    // Without this, the helper resolves spawn to the stub-unused-child-process
    // no-op (esbuild.config.mjs replaces node:child_process for the openclaw
    // bundle) — and the daemon auto-spawn fallback silently does nothing,
    // sending us back to "NULL embeddings forever" before any other agent
    // races us.
    expect(SRC).toMatch(/_setSpawnImpl\(\s*realSpawn\s*\)/);
  });

  it("never writes a literal NULL into message_embedding (graceful fallback only)", () => {
    // embeddingSqlLiteral(null) returns the string "NULL" — that's how a
    // missing daemon stays graceful. But the bundle must NOT contain an
    // INSERT that hardcodes `, NULL,` in the message_embedding slot. If
    // someone reverts to "always NULL" the regex below catches it.
    // Spaces collapsed by esbuild, so match the template-literal form
    // the source produces, not pre-format.
    expect(SRC).not.toMatch(/INSERT INTO "\$\{sessionsTable[^"]*\}"[^;]*?,\s*NULL,\s*'\$\{sqlStr\(cfg\.userName/);
  });
});
