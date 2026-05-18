/**
 * Unit tests for the pure helpers in src/commands/mine-local.ts:
 *   - summaryTokens / jaccard / findOverlap (overlap detection)
 *   - parseMultiVerdict (multi-skill gate output parsing)
 *
 * The orchestrator runMineLocal itself is exercised by the e2e flow
 * (`hivemind skillify mine-local --force`), not unit-tested here.
 */

import { describe, it, expect } from "vitest";
import {
  summaryTokens,
  jaccard,
  findOverlap,
  parseMultiVerdict,
} from "../../src/commands/mine-local.js";

describe("summaryTokens", () => {
  it("lowercases, drops short tokens, drops stopwords", () => {
    const tokens = summaryTokens("The quick brown fox jumps over the lazy dog");
    // "the" is stoplisted; tokens shorter than 4 chars are dropped (so "fox" goes too).
    expect(tokens.has("quick")).toBe(true);
    expect(tokens.has("brown")).toBe(true);
    expect(tokens.has("jumps")).toBe(true);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("fox")).toBe(false); // 3 chars, filtered
  });

  it("treats punctuation as a token boundary", () => {
    const tokens = summaryTokens("table-driven, code-review.workflow");
    expect(tokens.has("table")).toBe(true);
    expect(tokens.has("driven")).toBe(true);
    expect(tokens.has("review")).toBe(true);
    expect(tokens.has("workflow")).toBe(true);
  });

  it("returns empty set for empty / pure-stopword input", () => {
    expect(summaryTokens("").size).toBe(0);
    expect(summaryTokens("the and for with").size).toBe(0);
  });
});

describe("jaccard", () => {
  it("returns 0 for empty sets", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  it("computes |A ∩ B| / |A ∪ B|", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} (2), ∪ = {a,b,c,d} (4) → 0.5
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(0.5);
  });
});

describe("findOverlap", () => {
  const baseline = [
    { name: "deeplake-schema-migration", desc: "Add required column to existing Deeplake table via lazy ALTER" },
    { name: "oauth-callback-over-ssh", desc: "Diagnosing ERR_CONNECTION_REFUSED when OAuth callback runs over SSH" },
  ];

  it("returns null when nothing crosses the threshold", () => {
    const result = findOverlap("Unrelated React component testing pattern", baseline);
    expect(result).toBeNull();
  });

  it("detects clear semantic overlap (different wording, same concept)", () => {
    // Same topic as the baseline first entry, different phrasing
    const result = findOverlap("lazy Deeplake column ALTER migration approach", baseline);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("deeplake-schema-migration");
    expect(result!.score).toBeGreaterThanOrEqual(0.4);
  });

  it("picks the best match when multiple cross the threshold", () => {
    const overlapping = [
      { name: "first-match", desc: "deeplake column migration alter table workflow" },
      { name: "better-match", desc: "deeplake required column lazy alter table existing migration workflow" },
    ];
    const result = findOverlap("deeplake required column lazy alter migration", overlapping);
    expect(result).not.toBeNull();
    // The "better-match" shares more non-stopword tokens; score should win.
    expect(result!.name).toBe("better-match");
  });

  it("stopword-heavy descriptions do not falsely match", () => {
    // Two descriptions that share lots of stopwords but no content words
    const others = [{ name: "stopwords", desc: "the and for with from into via this that" }];
    const result = findOverlap("the and for with from into via this that", others);
    // After stopword filter, both reduce to empty token sets → jaccard returns 0.
    expect(result).toBeNull();
  });

  it("returns null when candidate description is empty", () => {
    expect(findOverlap("", baseline)).toBeNull();
  });
});

describe("parseMultiVerdict", () => {
  it("parses valid JSON with skills array", () => {
    const raw = JSON.stringify({
      reason: "found two patterns",
      skills: [
        { name: "skill-one", description: "first", trigger: "when X", body: "## body 1" },
        { name: "skill-two", description: "second", body: "## body 2" },
      ],
    });
    const mv = parseMultiVerdict(raw);
    expect(mv).not.toBeNull();
    expect(mv!.reason).toBe("found two patterns");
    expect(mv!.skills).toHaveLength(2);
    expect(mv!.skills[0].name).toBe("skill-one");
    expect(mv!.skills[0].trigger).toBe("when X");
    expect(mv!.skills[1].trigger).toBeUndefined();
  });

  it("returns {skills: []} for the empty-skills SKIP shape", () => {
    const mv = parseMultiVerdict(JSON.stringify({ reason: "nothing worth keeping", skills: [] }));
    expect(mv).not.toBeNull();
    expect(mv!.skills).toEqual([]);
  });

  it("filters entries missing required fields (name or body)", () => {
    const raw = JSON.stringify({
      reason: "mixed",
      skills: [
        { name: "good", description: "ok", body: "## body" },
        { name: "", description: "missing name", body: "## body" },
        { name: "no-body", description: "missing body", body: "" },
        { description: "no-name-key-either" },
      ],
    });
    const mv = parseMultiVerdict(raw);
    expect(mv).not.toBeNull();
    expect(mv!.skills).toHaveLength(1);
    expect(mv!.skills[0].name).toBe("good");
  });

  it("returns null for malformed JSON", () => {
    expect(parseMultiVerdict("not json at all")).toBeNull();
    expect(parseMultiVerdict("{ skills: [")).toBeNull();
  });

  it("returns null when skills is not an array", () => {
    expect(parseMultiVerdict(JSON.stringify({ reason: "x", skills: "oops" }))).toBeNull();
    expect(parseMultiVerdict(JSON.stringify({ reason: "x" }))).toBeNull();
  });

  it("extracts JSON wrapped in prose or code fence", () => {
    const fenced = "Here's my decision:\n\n```json\n" + JSON.stringify({ reason: "ok", skills: [] }) + "\n```\nDone.";
    const mv = parseMultiVerdict(fenced);
    expect(mv).not.toBeNull();
    expect(mv!.skills).toEqual([]);
  });

  it("trims string field whitespace", () => {
    const raw = JSON.stringify({
      reason: "ok",
      skills: [{ name: "  trimmed  ", description: "  also  ", body: "  body  " }],
    });
    const mv = parseMultiVerdict(raw);
    expect(mv!.skills[0].name).toBe("trimmed");
    expect(mv!.skills[0].description).toBe("also");
    expect(mv!.skills[0].body).toBe("body");
  });

  it("returns null when parsed JSON is not an object", () => {
    expect(parseMultiVerdict(JSON.stringify("just a string"))).toBeNull();
    expect(parseMultiVerdict(JSON.stringify(42))).toBeNull();
  });

  it("returns undefined reason when missing", () => {
    const mv = parseMultiVerdict(JSON.stringify({ skills: [] }));
    expect(mv).not.toBeNull();
    expect(mv!.reason).toBeUndefined();
  });

  it("skips entries where skill is null or not an object", () => {
    const raw = JSON.stringify({
      reason: "mixed",
      skills: [
        null,
        "not an object",
        { name: "kept", description: "x", body: "y" },
      ],
    });
    const mv = parseMultiVerdict(raw);
    expect(mv!.skills).toHaveLength(1);
    expect(mv!.skills[0].name).toBe("kept");
  });
});
