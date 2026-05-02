import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level lock-in for the Cursor wiki-worker. The worker is forked
 * from src/hooks/codex/wiki-worker.ts and only the LLM-spawn step
 * differs — these tests guard the Cursor-specific bits (CLI binary,
 * --print flag, --model, agent label, env-var override) so future
 * refactors against the codex template don't silently regress Cursor.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const WORKER_SRC = readFileSync(join(REPO_ROOT, "src/hooks/cursor/wiki-worker.ts"), "utf-8");
const SPAWN_SRC = readFileSync(join(REPO_ROOT, "src/hooks/cursor/spawn-wiki-worker.ts"), "utf-8");

describe("cursor wiki-worker source", () => {
  it("shells `cursor-agent --print --model X --force` (NOT codex exec)", () => {
    expect(WORKER_SRC).toMatch(/execFileSync\(\s*cfg\.cursorBin/);
    expect(WORKER_SRC).toContain('"--print"');
    expect(WORKER_SRC).toContain('"--model"');
    expect(WORKER_SRC).toContain('"--force"');
    expect(WORKER_SRC).not.toMatch(/execFileSync\(\s*cfg\.codexBin/);
    expect(WORKER_SRC).not.toMatch(/"--dangerously-bypass-approvals-and-sandbox"/);
  });

  it("config carries cursorBin + cursorModel (not codexBin)", () => {
    expect(WORKER_SRC).toContain("cursorBin: string");
    expect(WORKER_SRC).toContain("cursorModel: string");
    expect(WORKER_SRC).not.toContain("codexBin: string");
  });

  it("uploadSummary tags rows agent=\"cursor\"", () => {
    expect(WORKER_SRC).toContain('agent: "cursor"');
    expect(WORKER_SRC).not.toContain('agent: "codex"');
  });

  it("INSERT-side schema uses message_embedding (capture handled by capture.ts; here only the upload-summary path runs, but the file inherits the same imports)", () => {
    expect(WORKER_SRC).toContain("uploadSummary");
    expect(WORKER_SRC).toContain("EmbedClient");
  });
});

describe("cursor spawn-wiki-worker source", () => {
  it("findCursorBin probes `which cursor-agent` and falls back to the literal name", () => {
    expect(SPAWN_SRC).toMatch(/which cursor-agent/);
    expect(SPAWN_SRC).toContain('return "cursor-agent"');
    expect(SPAWN_SRC).not.toContain("which codex");
  });

  it("config builder includes cursorModel from HIVEMIND_CURSOR_MODEL with `auto` default", () => {
    expect(SPAWN_SRC).toContain("HIVEMIND_CURSOR_MODEL");
    expect(SPAWN_SRC).toMatch(/HIVEMIND_CURSOR_MODEL.*\?\?\s*"auto"/);
  });

  it("hooksDir + wikiLog point at ~/.cursor/ (not ~/.codex/)", () => {
    expect(SPAWN_SRC).toContain('".cursor"');
    expect(SPAWN_SRC).not.toMatch(/HOME,\s*"\.codex"/);
  });

  it("exports spawnCursorWikiWorker (not spawnCodexWikiWorker)", () => {
    expect(SPAWN_SRC).toContain("export function spawnCursorWikiWorker");
    expect(SPAWN_SRC).not.toContain("export function spawnCodexWikiWorker");
  });
});
