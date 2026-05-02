import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level lock-in for the Hermes wiki-worker. Forked from
 * src/hooks/codex/wiki-worker.ts; only the LLM-spawn step differs
 * (Hermes uses `hermes -z` oneshot mode with --provider + -m). These
 * tests pin the Hermes-specific bits so a future refactor against the
 * codex template doesn't silently regress Hermes.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const WORKER_SRC = readFileSync(join(REPO_ROOT, "src/hooks/hermes/wiki-worker.ts"), "utf-8");
const SPAWN_SRC = readFileSync(join(REPO_ROOT, "src/hooks/hermes/spawn-wiki-worker.ts"), "utf-8");
const SESSION_START_SRC = readFileSync(join(REPO_ROOT, "src/hooks/hermes/session-start.ts"), "utf-8");

describe("hermes wiki-worker source", () => {
  it("shells `hermes -z PROMPT --provider X -m Y --yolo` (NOT codex exec)", () => {
    expect(WORKER_SRC).toMatch(/execFileSync\(\s*cfg\.hermesBin/);
    expect(WORKER_SRC).toContain('"-z"');
    expect(WORKER_SRC).toContain('"--provider"');
    expect(WORKER_SRC).toContain('"-m"');
    expect(WORKER_SRC).toContain('"--yolo"');
    expect(WORKER_SRC).not.toMatch(/execFileSync\(\s*cfg\.codexBin/);
    expect(WORKER_SRC).not.toMatch(/"--dangerously-bypass-approvals-and-sandbox"/);
  });

  it("config carries hermesBin + hermesProvider + hermesModel (not codexBin)", () => {
    expect(WORKER_SRC).toContain("hermesBin: string");
    expect(WORKER_SRC).toContain("hermesProvider: string");
    expect(WORKER_SRC).toContain("hermesModel: string");
    expect(WORKER_SRC).not.toContain("codexBin: string");
  });

  it("uploadSummary tags rows agent=\"hermes\"", () => {
    expect(WORKER_SRC).toContain('agent: "hermes"');
    expect(WORKER_SRC).not.toContain('agent: "codex"');
  });

  it("uploads via the canonical helper + uses EmbedClient for summary_embedding", () => {
    expect(WORKER_SRC).toContain("uploadSummary");
    expect(WORKER_SRC).toContain("EmbedClient");
  });
});

describe("hermes spawn-wiki-worker source", () => {
  it("findHermesBin probes `which hermes` and falls back to the literal name", () => {
    expect(SPAWN_SRC).toMatch(/which hermes/);
    expect(SPAWN_SRC).toContain('return "hermes"');
    expect(SPAWN_SRC).not.toContain("which codex");
  });

  it("config builder reads HIVEMIND_HERMES_PROVIDER (default openrouter) and HIVEMIND_HERMES_MODEL (default haiku-4-5)", () => {
    expect(SPAWN_SRC).toContain("HIVEMIND_HERMES_PROVIDER");
    expect(SPAWN_SRC).toContain("HIVEMIND_HERMES_MODEL");
    expect(SPAWN_SRC).toMatch(/HIVEMIND_HERMES_PROVIDER.*\?\?\s*"openrouter"/);
    expect(SPAWN_SRC).toMatch(/HIVEMIND_HERMES_MODEL.*\?\?\s*"anthropic\/claude-haiku-4-5"/);
  });

  it("hooksDir + wikiLog point at ~/.hermes/ (not ~/.codex/)", () => {
    expect(SPAWN_SRC).toContain('".hermes"');
    expect(SPAWN_SRC).not.toMatch(/HOME,\s*"\.codex"/);
  });

  it("exports spawnHermesWikiWorker (not spawnCodexWikiWorker)", () => {
    expect(SPAWN_SRC).toContain("export function spawnHermesWikiWorker");
    expect(SPAWN_SRC).not.toContain("export function spawnCodexWikiWorker");
  });
});

describe("hermes session-start source", () => {
  it("ensures both memory + sessions tables before INSERTing the placeholder", () => {
    // Without these calls, fresh table names (or first install on an org
    // that predates the embedding feature) leave wiki-worker uploads
    // failing with "Table does not exist". Caught during e2e validation.
    expect(SESSION_START_SRC).toMatch(/api\.ensureTable\(\)/);
    expect(SESSION_START_SRC).toMatch(/api\.ensureSessionsTable\(/);
    const ensureMemoryIdx = SESSION_START_SRC.search(/api\.ensureTable\(\)/);
    const placeholderCallIdx = SESSION_START_SRC.search(/await\s+createPlaceholder\(/);
    expect(ensureMemoryIdx).toBeGreaterThan(-1);
    expect(placeholderCallIdx).toBeGreaterThan(ensureMemoryIdx);
  });
});
