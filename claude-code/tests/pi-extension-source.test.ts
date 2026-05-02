import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The pi extension is shipped as raw TypeScript (// @ts-nocheck) into
 * ~/.pi/agent/extensions/hivemind.ts and compiled at runtime by pi.
 * That makes it awkward to import + execute here, so we verify the
 * load-bearing wiring at the source level instead.
 *
 * What's locked in:
 *   - The INSERT into the sessions table includes the message_embedding column
 *     (without it, schema-strict tables reject the row — see the schema race
 *     incident in CLAUDE.md).
 *   - The auto-spawn path uses the canonical shared-deps daemon location so
 *     pi works standalone after `hivemind embeddings install`.
 *   - The socket path matches the same UID-keyed convention EmbedClient uses
 *     (otherwise pi's daemon would never converge with other agents').
 */

const PI_SRC = readFileSync(
  join(__dirname, "..", "..", "pi", "extension-source", "hivemind.ts"),
  "utf-8",
);

describe("pi extension — embedding wiring", () => {
  it("INSERT into the sessions table includes the message_embedding column", () => {
    const insertLine = PI_SRC.match(
      /INSERT INTO "\$\{SESSIONS_TABLE\}"\s*\([^)]+\)/,
    );
    expect(insertLine).not.toBeNull();
    expect(insertLine![0]).toContain("message_embedding");
  });

  it("auto-spawn target is the canonical shared-deps daemon path", () => {
    expect(PI_SRC).toContain('".hivemind"');
    expect(PI_SRC).toContain('"embed-deps"');
    expect(PI_SRC).toContain('"embed-daemon.js"');
  });

  it("uses the same UID-keyed socket convention as EmbedClient", () => {
    expect(PI_SRC).toMatch(/\/tmp\/hivemind-embed-\$\{uid\}\.sock/);
  });

  it("speaks the daemon's protocol shape exactly: {op:'embed', id, kind, text}", () => {
    // Regression guard: an earlier version sent `{type:'embed', id:1, ...}` —
    // the daemon silently ignored the malformed verb (`type` instead of `op`)
    // and the embed ended up null on every call. Source of truth is
    // src/embeddings/protocol.ts (EmbedRequest interface).
    expect(PI_SRC).toContain('op: "embed"');
    expect(PI_SRC).not.toMatch(/type:\s*"embed"/);
    expect(PI_SRC).toMatch(/id:\s*"1"/); // id is a string, not a number
  });

  it("session_start CREATE TABLE IF NOT EXISTS for both memory + sessions tables", () => {
    // Without these, the first writeSessionRow fails because the test's
    // custom HIVEMIND_TABLE / HIVEMIND_SESSIONS_TABLE haven't been created
    // by any other agent. The pi extension's writeSessionRow swallows
    // errors silently — we'd see "no rows" with no log explanation. The
    // CREATE TABLE makes the extension standalone-capable.
    expect(PI_SRC).toMatch(/CREATE TABLE IF NOT EXISTS "\$\{MEMORY_TABLE\}"/);
    expect(PI_SRC).toMatch(/CREATE TABLE IF NOT EXISTS "\$\{SESSIONS_TABLE\}"/);
    expect(PI_SRC).toMatch(/summary_embedding FLOAT4\[\]/);
    expect(PI_SRC).toMatch(/message_embedding FLOAT4\[\]/);
  });

  it("summary-state thresholds match the canonical defaults from src/hooks/summary-state.ts", () => {
    // Source of truth: 50 msgs / 2 hours. If those defaults change in
    // summary-state.ts the pi extension MUST track them — otherwise pi
    // and CC/codex would summarise at different cadences using the same
    // sidecar dir.
    expect(PI_SRC).toContain("HIVEMIND_SUMMARY_EVERY_N_MSGS");
    expect(PI_SRC).toContain("HIVEMIND_SUMMARY_EVERY_HOURS");
    expect(PI_SRC).toMatch(/everyNMessages.*50/);
    expect(PI_SRC).toMatch(/everyHours.*2/);
  });

  it("first-chat trigger fires at FIRST_SUMMARY_AT=10 (matches summary-state.ts canonical)", () => {
    // Without this trigger a brand-new session would have to accumulate 50
    // messages before the first summary lands. The canonical CC/codex
    // shouldTrigger() has an early-fire condition: when lastSummaryCount===0
    // and totalCount>=10. Pi MUST replicate it or fresh pi-only sessions
    // wouldn't get indexed for an unreasonably long time.
    expect(PI_SRC).toContain("FIRST_SUMMARY_AT");
    expect(PI_SRC).toMatch(/FIRST_SUMMARY_AT\s*=\s*10/);
    expect(PI_SRC).toMatch(/lastSummaryCount\s*===?\s*0\s*&&\s*state\.totalCount\s*>=\s*FIRST_SUMMARY_AT/);
  });

  it("time-based trigger formula matches summary-state.ts canonical (everyHours * 3600 * 1000)", () => {
    // Locks in: msgsSince > 0 AND lastSummaryAt > 0 AND elapsed >= everyHours*ms.
    // The "msgsSince > 0" guard is critical — without it a quiet session past
    // 2h would summarise itself in a loop even with no new events.
    expect(PI_SRC).toMatch(/cfg\.everyHours\s*\*\s*3600\s*\*\s*1000/);
    expect(PI_SRC).toMatch(/msgsSince\s*>\s*0/);
    expect(PI_SRC).toMatch(/state\.lastSummaryAt\s*>\s*0/);
  });

  it("shares the summary-state dir with CC/codex/cursor/hermes (~/.claude/hooks/summary-state)", () => {
    // The pi-spawned wiki-worker bundle imports finalizeSummary/releaseLock
    // from src/hooks/summary-state.ts which writes to that dir. The pi
    // extension's inline state helpers MUST point at the same dir or the
    // worker's writes won't be visible to subsequent threshold checks.
    expect(PI_SRC).toContain('".claude"');
    expect(PI_SRC).toContain('"hooks"');
    expect(PI_SRC).toContain('"summary-state"');
  });

  it("session_shutdown spawns the wiki-worker with reason=final", () => {
    expect(PI_SRC).toMatch(/spawnWikiWorker\(creds,\s*sessionId,\s*cwd,\s*"final"\)/);
  });

  it("input/tool_result/message_end each invoke maybeTriggerPeriodicSummary after writing", () => {
    // Three call sites — one per capture event. If any of them is missing,
    // periodic summaries skip events of that type and the threshold drifts
    // (or never fires for a tool-heavy or assistant-heavy session).
    const matches = PI_SRC.match(/maybeTriggerPeriodicSummary\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("wiki-worker spawn target is ~/.pi/agent/hivemind/wiki-worker.js (where install-pi.ts deposits it)", () => {
    expect(PI_SRC).toContain('".pi"');
    expect(PI_SRC).toContain('"agent"');
    expect(PI_SRC).toContain('"hivemind"');
    expect(PI_SRC).toContain('"wiki-worker.js"');
  });

  it("falls back gracefully when embeddings are explicitly disabled", () => {
    expect(PI_SRC).toContain('process.env.HIVEMIND_EMBEDDINGS === "false"');
  });

  it("emits NULL (not a malformed literal) when no embedding is available", () => {
    // embedSqlLiteral(null) → "NULL" — guards against `ARRAY[]::FLOAT4[]` slipping in.
    expect(PI_SRC).toMatch(/return\s+"NULL"/);
  });
});
