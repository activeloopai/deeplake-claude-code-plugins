/**
 * Unit tests for src/skillify/local-manifest.ts — shared manifest
 * read/write used by mine-local and the per-agent SessionStart hooks.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countLocalManifestEntries,
  readLocalManifest,
  writeLocalManifest,
  type LocalManifest,
} from "../../src/skillify/local-manifest.js";

const TMP = mkdtempSync(join(tmpdir(), "local-manifest-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function manifestPath(name: string): string {
  return join(TMP, `${name}.json`);
}

function makeManifest(count: number): LocalManifest {
  return {
    created_at: "2026-05-13T00:00:00.000Z",
    entries: Array.from({ length: count }, (_, i) => ({
      skill_name: `skill-${i}`,
      canonical_path: `/home/x/.claude/skills/skill-${i}/SKILL.md`,
      symlinks: [],
      source_session_ids: [`sid-${i}`],
      source_session_paths: [`/x/sid-${i}.jsonl`],
      source_agent: "claude_code",
      gate_agent: "claude_code",
      created_at: "2026-05-13T00:00:00.000Z",
      uploaded: false,
    })),
  };
}

describe("countLocalManifestEntries", () => {
  it("returns 0 when the manifest doesn't exist", () => {
    expect(countLocalManifestEntries(manifestPath("nope"))).toBe(0);
  });

  it("returns 0 for an empty entries array", () => {
    const path = manifestPath("empty");
    writeLocalManifest(makeManifest(0), path);
    expect(countLocalManifestEntries(path)).toBe(0);
  });

  it("returns the entry count for a populated manifest", () => {
    const path = manifestPath("populated");
    writeLocalManifest(makeManifest(7), path);
    expect(countLocalManifestEntries(path)).toBe(7);
  });

  it("returns 0 for malformed JSON (treats it as missing)", () => {
    const path = manifestPath("malformed");
    writeFileSync(path, "{ not valid json");
    expect(countLocalManifestEntries(path)).toBe(0);
  });

  it("returns 0 when entries field is missing", () => {
    const path = manifestPath("no-entries-field");
    writeFileSync(path, JSON.stringify({ created_at: "2026-05-13T00:00:00.000Z" }));
    expect(countLocalManifestEntries(path)).toBe(0);
  });

  it("returns 0 when entries is not an array", () => {
    const path = manifestPath("entries-not-array");
    writeFileSync(path, JSON.stringify({ created_at: "x", entries: "oops" }));
    expect(countLocalManifestEntries(path)).toBe(0);
  });
});

describe("readLocalManifest", () => {
  it("round-trips a populated manifest through write + read", () => {
    const path = manifestPath("roundtrip");
    const original = makeManifest(3);
    writeLocalManifest(original, path);
    const read = readLocalManifest(path);
    expect(read).not.toBeNull();
    expect(read!.entries).toHaveLength(3);
    expect(read!.entries[0].skill_name).toBe("skill-0");
    expect(read!.created_at).toBe(original.created_at);
  });

  it("creates parent directories on write", () => {
    const nested = join(TMP, "a", "b", "c", "manifest.json");
    writeLocalManifest(makeManifest(1), nested);
    expect(readLocalManifest(nested)?.entries).toHaveLength(1);
  });
});
