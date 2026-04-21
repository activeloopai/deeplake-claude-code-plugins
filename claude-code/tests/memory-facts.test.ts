import { describe, expect, it } from "vitest";
import {
  buildMemoryFactPrompt,
  parseMemoryFactExtraction,
  replaceSessionFacts,
} from "../../src/hooks/memory-facts.js";

describe("memory-facts", () => {
  it("parses fenced JSON fact output and normalizes predicates", () => {
    const extraction = parseMemoryFactExtraction(`\`\`\`json
{"facts":[{"subject":"Caroline","subject_type":"person","predicate":"Home Country","object":"Sweden","object_type":"place","summary":"Caroline's home country is Sweden","evidence":"home country","confidence":0.92}]}
\`\`\``);
    expect(extraction.facts).toHaveLength(1);
    expect(extraction.facts[0].predicate).toBe("home_country");
    expect(extraction.facts[0].confidence).toBe(0.92);
  });

  it("builds a fact prompt with summary and source metadata", () => {
    const prompt = buildMemoryFactPrompt({
      summaryText: "# Session\n- **Source**: /sessions/x.json",
      sessionId: "sess-1",
      sourcePath: "/sessions/x.json",
      project: "proj",
    });
    expect(prompt).toContain("SESSION ID: sess-1");
    expect(prompt).toContain("SOURCE PATH: /sessions/x.json");
    expect(prompt).toContain("SUMMARY MARKDOWN:");
  });

  it("replaces per-session fact rows and upserts canonical entities", async () => {
    const calls: string[] = [];
    const query = async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM "memory_entities"')) return [];
      return [];
    };
    const result = await replaceSessionFacts({
      query,
      factsTable: "memory_facts",
      entitiesTable: "memory_entities",
      linksTable: "fact_entity_links",
      sessionId: "sess-1",
      userName: "alice",
      project: "proj",
      agent: "claude_code",
      sourcePath: "/sessions/alice/sess-1.jsonl",
      extraction: {
        facts: [
          {
            subject: "Caroline",
            subjectType: "person",
            predicate: "home_country",
            object: "Sweden",
            objectType: "place",
            summary: "Caroline's home country is Sweden",
            evidence: "home country",
            confidence: 0.92,
          },
        ],
      },
      ts: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({ facts: 1, entities: 2, links: 2 });
    expect(calls[0]).toContain('DELETE FROM "memory_facts"');
    expect(calls[1]).toContain('DELETE FROM "fact_entity_links"');
    expect(calls.some((sql) => sql.includes('INSERT INTO "memory_entities"'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO "memory_facts"'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO "fact_entity_links"'))).toBe(true);
    expect(calls.join("\n")).toContain("entity:caroline");
    expect(calls.join("\n")).toContain("entity:sweden");
    const linkInsert = calls.find((sql) => sql.includes('INSERT INTO "fact_entity_links"'));
    expect(linkInsert).toContain("fact:sess_1:1:caroline:home_country:sweden");
    expect(linkInsert).toContain("'fact:sess_1:1:caroline:home_country:sweden', 'entity:caroline', 'subject'");
    expect(linkInsert).toContain("'fact:sess_1:1:caroline:home_country:sweden', 'entity:sweden', 'object'");
  });
});
