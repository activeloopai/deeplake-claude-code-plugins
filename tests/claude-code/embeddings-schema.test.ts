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
  const apiSrc = read("src/deeplake-api.ts");

  it("memory table CREATE includes summary_embedding FLOAT4[]", () => {
    expect(apiSrc).toMatch(/summary_embedding FLOAT4\[\]/);
  });

  it("sessions table CREATE includes message_embedding FLOAT4[]", () => {
    expect(apiSrc).toMatch(/message_embedding FLOAT4\[\]/);
  });

  it("embedding columns do NOT use TEXT (regression guard)", () => {
    expect(apiSrc).not.toMatch(/summary_embedding TEXT/);
    expect(apiSrc).not.toMatch(/message_embedding TEXT/);
  });
});
