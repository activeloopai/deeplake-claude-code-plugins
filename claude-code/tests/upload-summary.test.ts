import { describe, it, expect } from "vitest";
import { uploadSummary, extractDescription, esc, type QueryFn } from "../../src/hooks/upload-summary.js";

/**
 * Functional tests against the real uploadSummary helper. The query
 * function is mocked so no network call is made, but every SQL statement
 * the worker would send to Deeplake is captured and asserted on.
 *
 * Context: Deeplake silently drops one of two rapid UPDATEs on the same
 * row. The worker MUST keep summary + description in the same statement.
 */

const TEXT_WITH_WHAT_HAPPENED = `# Session abc-123
- **Project**: test

## What Happened
User ran diagnostic commands to verify the development environment.
All ten commands executed successfully.

## People
**emanuele** — user — ran diagnostic commands

## Entities
**test-project** (directory) — working directory
`;

const TEXT_WITH_STRUCTURED_FACTS = `# Session conv_0_session_10
- **Source**: /sessions/conv_0_session_10.json
- **Date**: 8:56 pm on 20 July, 2023
- **Participants**: Caroline, Melanie
- **Project**: locomo
- **Topics**: LGBTQ activism, family summer traditions

## What Happened
Caroline and Melanie talked about activism, family trips, and recent milestones.

## Searchable Facts
- Caroline joined Connected LGBTQ Activists last Tuesday.
- Melanie's family takes an annual summer camping trip.
- Melanie's youngest child recently took her first steps.
`;

function makeSpyQuery(responses: Array<Array<Record<string, unknown>>> = [[]]): { fn: QueryFn; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn: QueryFn = async (sql: string) => {
    calls.push(sql);
    return responses[i++] ?? [];
  };
  return { fn, calls };
}

const BASE = {
  tableName: "memory",
  vpath: "/summaries/alice/sess-1.md",
  fname: "sess-1.md",
  userName: "alice",
  project: "my-project",
  agent: "claude_code",
  sessionId: "sess-1",
} as const;

describe("uploadSummary — Deeplake single-UPDATE invariant", () => {
  it("UPDATE path: issues exactly one UPDATE containing BOTH summary and description", async () => {
    // SELECT returns 1 row → UPDATE branch
    const { fn, calls } = makeSpyQuery([[{ path: BASE.vpath }]]);
    await uploadSummary(fn, { ...BASE, text: TEXT_WITH_WHAT_HAPPENED });

    expect(calls, "expected SELECT then one UPDATE").toHaveLength(2);
    expect(calls[0]).toMatch(/^SELECT\s+path\s+FROM/i);

    const update = calls[1];
    expect(update).toMatch(/^UPDATE\s/i);
    expect(update).toMatch(/summary\s*=\s*E'/);
    expect(update).toMatch(/description\s*=\s*E'/);
    expect(update).toMatch(/size_bytes\s*=\s*\d+/);
    expect(update).toMatch(/last_update_date\s*=/);
    expect(update).toMatch(/WHERE\s+path\s*=/i);
  });

  it("UPDATE path: does NOT issue a second UPDATE for description", async () => {
    const { fn, calls } = makeSpyQuery([[{ path: BASE.vpath }]]);
    await uploadSummary(fn, { ...BASE, text: TEXT_WITH_WHAT_HAPPENED });

    const updateCount = calls.filter(s => /^UPDATE\s/i.test(s)).length;
    expect(updateCount, "exactly one UPDATE must be sent").toBe(1);
    const descOnlyUpdate = calls.find(s => /^UPDATE\s/i.test(s) && /SET\s+description\s*=/i.test(s) && !/summary\s*=/.test(s));
    expect(descOnlyUpdate, "no description-only UPDATE allowed").toBeUndefined();
  });

  it("INSERT path: issues exactly one INSERT containing BOTH summary and description", async () => {
    // SELECT returns no rows → INSERT branch
    const { fn, calls } = makeSpyQuery([[]]);
    await uploadSummary(fn, { ...BASE, text: TEXT_WITH_WHAT_HAPPENED });

    expect(calls).toHaveLength(2);
    const insert = calls[1];
    expect(insert).toMatch(/^INSERT INTO/i);
    // column list must include summary AND description
    expect(insert).toMatch(/\(\s*id[^)]*\bsummary\b[^)]*\bdescription\b[^)]*\)/i);
    // the value block must contain an E'...' for both
    const eStrings = insert.match(/E'[^']*(?:''[^']*)*'/g) ?? [];
    expect(eStrings.length, "INSERT must provide E-strings for both summary and description").toBeGreaterThanOrEqual(2);
  });

  it("reports summary/desc lengths and which path was taken", async () => {
    const { fn } = makeSpyQuery([[]]);
    const result = await uploadSummary(fn, { ...BASE, text: TEXT_WITH_WHAT_HAPPENED });
    expect(result.path).toBe("insert");
    expect(result.summaryLength).toBe(TEXT_WITH_WHAT_HAPPENED.length);
    expect(result.descLength).toBeGreaterThan(0);

    const { fn: fn2 } = makeSpyQuery([[{ path: BASE.vpath }]]);
    const result2 = await uploadSummary(fn2, { ...BASE, text: TEXT_WITH_WHAT_HAPPENED });
    expect(result2.path).toBe("update");
  });

  it("threads the user-provided timestamp through both UPDATE and INSERT", async () => {
    const ts = "2030-01-02T03:04:05.000Z";
    const upd = makeSpyQuery([[{ path: BASE.vpath }]]);
    await uploadSummary(upd.fn, { ...BASE, text: TEXT_WITH_WHAT_HAPPENED, ts });
    expect(upd.calls[1]).toContain(`last_update_date = '${ts}'`);

    const ins = makeSpyQuery([[]]);
    await uploadSummary(ins.fn, { ...BASE, text: TEXT_WITH_WHAT_HAPPENED, ts });
    // INSERT uses ts for both creation_date and last_update_date
    const tsCount = ins.calls[1].split(`'${ts}'`).length - 1;
    expect(tsCount).toBeGreaterThanOrEqual(2);
  });

  it("embeds the correct agent literal in the INSERT", async () => {
    const cc = makeSpyQuery([[]]);
    await uploadSummary(cc.fn, { ...BASE, agent: "claude_code", text: TEXT_WITH_WHAT_HAPPENED });
    expect(cc.calls[1]).toContain(`'claude_code'`);

    const cx = makeSpyQuery([[]]);
    await uploadSummary(cx.fn, { ...BASE, agent: "codex", text: TEXT_WITH_WHAT_HAPPENED });
    expect(cx.calls[1]).toContain(`'codex'`);
  });

  it("summary + description land atomically even when description extraction fails (no ## What Happened)", async () => {
    // A summary that lacks the expected section — description must fall back to "completed"
    // and STILL be in the same UPDATE as summary.
    const weird = "# Session xyz\n\nSome freeform content without structured sections.\n";
    const { fn, calls } = makeSpyQuery([[{ path: BASE.vpath }]]);
    await uploadSummary(fn, { ...BASE, text: weird });
    expect(calls[1]).toMatch(/summary\s*=\s*E'/);
    expect(calls[1]).toContain("description = E'completed'");
  });
});

describe("extractDescription", () => {
  it("falls back to the What Happened section when no richer structure exists", () => {
    const d = extractDescription(TEXT_WITH_WHAT_HAPPENED);
    expect(d.startsWith("User ran diagnostic commands")).toBe(true);
    expect(d.length).toBeLessThanOrEqual(300);
  });

  it("prefers participants, topics, and searchable facts when present", () => {
    const d = extractDescription(TEXT_WITH_STRUCTURED_FACTS);
    expect(d).toContain("Caroline, Melanie");
    expect(d).toContain("LGBTQ activism, family summer traditions");
    expect(d).toContain("Connected LGBTQ Activists");
    expect(d).not.toContain("## Searchable Facts");
  });

  it("returns 'completed' when the section is absent", () => {
    expect(extractDescription("# Only header, nothing else.")).toBe("completed");
  });

  it("stops at the next ## heading", () => {
    const d = extractDescription(TEXT_WITH_WHAT_HAPPENED);
    expect(d).not.toContain("## People");
    expect(d).not.toContain("## Entities");
  });
});

describe("esc — SQL E-string escaping", () => {
  it("doubles single quotes", () => {
    expect(esc("it's")).toBe("it''s");
  });

  it("doubles backslashes", () => {
    expect(esc("a\\b")).toBe("a\\\\b");
  });

  it("strips control chars that break E-strings", () => {
    expect(esc("hello\x01world\x7fend")).toBe("helloworldend");
  });

  it("preserves real newlines (markdown structure)", () => {
    expect(esc("line1\nline2")).toBe("line1\nline2");
  });
});
