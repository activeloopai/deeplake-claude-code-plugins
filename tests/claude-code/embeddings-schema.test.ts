// Bundle-level guard: make sure the shipped hook bundles contain the new
// embedding columns in their INSERT statements. Catches regressions where
// the schema migration is done in src/ but a bundle referencing the old
// column list remains in the shipped artifact.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_DIRS = [
  "claude-code/bundle",
  "codex/bundle",
];

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("shipped bundles include embedding columns", () => {
  for (const dir of BUNDLE_DIRS) {
    it(`${dir}/capture.js writes message_embedding`, () => {
      const src = read(join(dir, "capture.js"));
      expect(src).toMatch(/message_embedding/);
    });

    it(`${dir}/shell/deeplake-shell.js writes summary_embedding`, () => {
      const src = read(join(dir, "shell/deeplake-shell.js"));
      expect(src).toMatch(/summary_embedding/);
    });

    it(`${dir} has an embed-daemon bundle`, () => {
      // Just check the file exists and is non-empty — not runnable without deps.
      const src = read(join(dir, "embeddings/embed-daemon.js"));
      expect(src.length).toBeGreaterThan(100);
    });
  }
});

describe("src-level schema includes new embedding columns", () => {
  // Schemas moved from inline strings in deeplake-api.ts to structured
  // arrays in deeplake-schema.ts. The bundles still need to inline these
  // columns, but the source of truth is now the new module.
  const schemaSrc = read("src/deeplake-schema.ts");

  // Scope each regex to a single object literal (`[^}]*`) so a later
  // entry's SQL can't accidentally satisfy the match.

  it("MEMORY_COLUMNS includes summary_embedding FLOAT4[]", () => {
    expect(schemaSrc).toMatch(/name:\s*"summary_embedding"[^}]*FLOAT4\[\]/);
  });

  it("SESSIONS_COLUMNS includes message_embedding FLOAT4[]", () => {
    expect(schemaSrc).toMatch(/name:\s*"message_embedding"[^}]*FLOAT4\[\]/);
  });

  it("embedding columns do NOT use TEXT (regression guard)", () => {
    expect(schemaSrc).not.toMatch(/name:\s*"summary_embedding"[^}]*TEXT/);
    expect(schemaSrc).not.toMatch(/name:\s*"message_embedding"[^}]*TEXT/);
  });
});
