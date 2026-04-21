import { describe, expect, it } from "vitest";
import {
  buildGraphNodeId,
  buildKnowledgeGraphPrompt,
  parseGraphExtraction,
  replaceSessionGraph,
} from "../../src/hooks/knowledge-graph.js";

describe("knowledge-graph", () => {
  it("parses fenced JSON graph output", () => {
    const graph = parseGraphExtraction(`\`\`\`json
{"nodes":[{"name":"Caroline","type":"person","summary":"Artist","aliases":["Caro"]}],"edges":[{"source":"Caroline","target":"Sweden","relation":"home_country","summary":"Caroline is from Sweden","evidence":"home country"}]}
\`\`\``);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes[0].aliases).toEqual(["Caro"]);
    expect(graph.edges[0].relation).toBe("home_country");
  });

  it("uses stable canonical-name node ids", () => {
    expect(buildGraphNodeId("Caroline")).toBe("entity:caroline");
    expect(buildGraphNodeId("Dr. Seuss")).toBe("entity:dr_seuss");
  });

  it("builds a graph prompt with summary and source metadata", () => {
    const prompt = buildKnowledgeGraphPrompt({
      summaryText: "# Session\n- **Source**: /sessions/x.json",
      sessionId: "sess-1",
      sourcePath: "/sessions/x.json",
      project: "proj",
    });
    expect(prompt).toContain("SESSION ID: sess-1");
    expect(prompt).toContain("SOURCE PATH: /sessions/x.json");
    expect(prompt).toContain("SUMMARY MARKDOWN:");
  });

  it("replaces per-session node and edge rows using stable ids", async () => {
    const calls: string[] = [];
    const query = async (sql: string) => {
      calls.push(sql);
      return [];
    };
    const result = await replaceSessionGraph({
      query,
      nodesTable: "graph_nodes",
      edgesTable: "graph_edges",
      sessionId: "sess-1",
      userName: "alice",
      project: "proj",
      agent: "claude_code",
      sourcePath: "/sessions/alice/sess-1.jsonl",
      graph: {
        nodes: [{ name: "Caroline", type: "person", summary: "Artist", aliases: ["Caro"] }],
        edges: [{ source: "Caroline", target: "Sweden", relation: "home_country", summary: "Caroline is from Sweden", evidence: "home country" }],
      },
      ts: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({ nodes: 2, edges: 1 });
    expect(calls[0]).toContain('DELETE FROM "graph_nodes"');
    expect(calls[1]).toContain('DELETE FROM "graph_edges"');
    expect(calls[2]).toContain('INSERT INTO "graph_nodes"');
    expect(calls[2]).toContain("entity:caroline");
    expect(calls[2]).toContain("entity:sweden");
    expect(calls[3]).toContain('INSERT INTO "graph_edges"');
    expect(calls[3]).toContain("home_country");
  });
});
