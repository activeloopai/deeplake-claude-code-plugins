import { randomUUID } from "node:crypto";
import { buildSummaryBlurb } from "../utils/summary-format.js";
import { esc, type QueryFn } from "./upload-summary.js";

export interface GraphNodeSpec {
  name: string;
  type?: string;
  summary?: string;
  aliases?: string[];
}

export interface GraphEdgeSpec {
  source: string;
  target: string;
  relation: string;
  summary?: string;
  evidence?: string;
}

export interface GraphExtraction {
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
}

export interface ReplaceSessionGraphParams {
  query: QueryFn;
  nodesTable: string;
  edgesTable: string;
  sessionId: string;
  userName: string;
  project: string;
  agent: string;
  sourcePath: string;
  graph: GraphExtraction;
  ts?: string;
}

export interface ReplaceSessionGraphResult {
  nodes: number;
  edges: number;
}

export const GRAPH_PROMPT_TEMPLATE = `You are extracting a compact knowledge graph delta from a session summary.

SESSION ID: __SESSION_ID__
SOURCE PATH: __SOURCE_PATH__
PROJECT: __PROJECT__

SUMMARY MARKDOWN:
__SUMMARY_TEXT__

Return ONLY valid JSON with this exact shape:
{"nodes":[{"name":"canonical entity name","type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","summary":"short factual description","aliases":["optional alias"]}],"edges":[{"source":"canonical source entity","target":"canonical target entity","relation":"snake_case_relation","summary":"short factual relation summary","evidence":"short supporting phrase"}]}

Rules:
- Use canonical names for repeated entities.
- Include people, places, organizations, books/media, tools, files, goals, status labels, preferences, and notable events when they matter for future recall.
- Convert relationship/status/origin/preferences into edges when possible. Example relation shapes: home_country, relationship_status, enjoys, decided_to_pursue, works_on, uses_tool, located_in, recommended, plans, supports.
- Keep summaries short and factual. Do not invent facts beyond the summary.
- If a source or target appears in an edge but not in nodes, also include it in nodes.
- Prefer stable canonical names over pronouns.
- Return no markdown, no prose, no code fences, only JSON.`;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAliasList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeString)
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

export function parseGraphExtraction(raw: string): GraphExtraction {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const nodes = Array.isArray(parsed["nodes"]) ? parsed["nodes"] as Array<Record<string, unknown>> : [];
  const edges = Array.isArray(parsed["edges"]) ? parsed["edges"] as Array<Record<string, unknown>> : [];
  return {
    nodes: nodes
      .map((node) => ({
        name: normalizeString(node["name"]),
        type: normalizeString(node["type"]) || "other",
        summary: normalizeString(node["summary"]),
        aliases: normalizeAliasList(node["aliases"]),
      }))
      .filter((node) => node.name),
    edges: edges
      .map((edge) => ({
        source: normalizeString(edge["source"]),
        target: normalizeString(edge["target"]),
        relation: normalizeString(edge["relation"]).replace(/\s+/g, "_").toLowerCase(),
        summary: normalizeString(edge["summary"]),
        evidence: normalizeString(edge["evidence"]),
      }))
      .filter((edge) => edge.source && edge.target && edge.relation),
  };
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
}

export function buildGraphNodeId(name: string, _type = "other"): string {
  return `entity:${slugify(name)}`;
}

function buildNodeSearchText(node: GraphNodeSpec): string {
  return [
    node.name,
    node.type ?? "other",
    ...(node.aliases ?? []),
    node.summary ?? "",
  ].filter(Boolean).join(" | ");
}

function buildEdgeSearchText(edge: GraphEdgeSpec, sourceNodeId: string, targetNodeId: string): string {
  return [
    edge.source,
    edge.relation,
    edge.target,
    edge.summary ?? "",
    edge.evidence ?? "",
    sourceNodeId,
    targetNodeId,
  ].filter(Boolean).join(" | ");
}

export function buildKnowledgeGraphPrompt(args: {
  summaryText: string;
  sessionId: string;
  sourcePath: string;
  project: string;
  template?: string;
}): string {
  return (args.template ?? GRAPH_PROMPT_TEMPLATE)
    .replace(/__SUMMARY_TEXT__/g, args.summaryText)
    .replace(/__SESSION_ID__/g, args.sessionId)
    .replace(/__SOURCE_PATH__/g, args.sourcePath)
    .replace(/__PROJECT__/g, args.project);
}

function wrapGraphPhaseError(error: unknown, args: {
  phase: "delete_nodes" | "delete_edges" | "insert_nodes" | "insert_edges";
  sessionId: string;
  table: string;
  sql: string;
}): Error {
  const wrapped = new Error(
    `graph ${args.phase} failed for session ${args.sessionId} on table ${args.table}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  (wrapped as Error & Record<string, unknown>).cause = error;
  (wrapped as Error & Record<string, unknown>).phase = args.phase;
  (wrapped as Error & Record<string, unknown>).sessionId = args.sessionId;
  (wrapped as Error & Record<string, unknown>).table = args.table;
  (wrapped as Error & Record<string, unknown>).sql = args.sql;
  return wrapped;
}

export async function replaceSessionGraph(params: ReplaceSessionGraphParams): Promise<ReplaceSessionGraphResult> {
  const ts = params.ts ?? new Date().toISOString();
  const nodePath = `/graphs/nodes/${params.userName}/${params.sessionId}.jsonl`;
  const edgePath = `/graphs/edges/${params.userName}/${params.sessionId}.jsonl`;
  const nodeFilename = `${params.sessionId}.jsonl`;
  const edgeFilename = `${params.sessionId}.jsonl`;

  const nodeMap = new Map<string, GraphNodeSpec>();
  for (const node of params.graph.nodes) {
    const key = buildGraphNodeId(node.name, node.type);
    nodeMap.set(key, {
      name: node.name,
      type: node.type || "other",
      summary: node.summary || "",
      aliases: node.aliases || [],
    });
  }
  for (const edge of params.graph.edges) {
    const sourceKey = buildGraphNodeId(edge.source);
    const targetKey = buildGraphNodeId(edge.target);
    if (!nodeMap.has(sourceKey)) nodeMap.set(sourceKey, { name: edge.source, type: "other", summary: "", aliases: [] });
    if (!nodeMap.has(targetKey)) nodeMap.set(targetKey, { name: edge.target, type: "other", summary: "", aliases: [] });
  }

  const deleteNodesSql = `DELETE FROM "${params.nodesTable}" WHERE source_session_id = '${esc(params.sessionId)}'`;
  const deleteEdgesSql = `DELETE FROM "${params.edgesTable}" WHERE source_session_id = '${esc(params.sessionId)}'`;
  try {
    await params.query(deleteNodesSql);
  } catch (error) {
    throw wrapGraphPhaseError(error, {
      phase: "delete_nodes",
      sessionId: params.sessionId,
      table: params.nodesTable,
      sql: deleteNodesSql,
    });
  }
  try {
    await params.query(deleteEdgesSql);
  } catch (error) {
    throw wrapGraphPhaseError(error, {
      phase: "delete_edges",
      sessionId: params.sessionId,
      table: params.edgesTable,
      sql: deleteEdgesSql,
    });
  }

  const nodeRows = [...nodeMap.entries()].map(([nodeId, node]) => {
    const summary = node.summary || buildSummaryBlurb(`# Graph Node\n\n${node.name}`);
    const aliases = (node.aliases ?? []).join(", ");
    const searchText = buildNodeSearchText(node);
    return (
      `('${randomUUID()}', '${esc(nodePath)}', '${esc(nodeFilename)}', '${esc(nodeId)}', ` +
      `'${esc(node.name)}', '${esc(node.type || "other")}', E'${esc(summary)}', E'${esc(searchText)}', ` +
      `'${esc(aliases)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', '${esc(params.userName)}', ` +
      `'application/json', ${Buffer.byteLength(searchText, "utf-8")}, '${esc(params.project)}', ` +
      `E'${esc(buildSummaryBlurb(summary))}', '${esc(params.agent)}', '${ts}', '${ts}')`
    );
  });

  if (nodeRows.length > 0) {
    const insertNodesSql = `INSERT INTO "${params.nodesTable}" ` +
      `(id, path, filename, node_id, canonical_name, node_type, summary, search_text, aliases, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
      `VALUES ${nodeRows.join(", ")}`;
    try {
      await params.query(insertNodesSql);
    } catch (error) {
      throw wrapGraphPhaseError(error, {
        phase: "insert_nodes",
        sessionId: params.sessionId,
        table: params.nodesTable,
        sql: insertNodesSql,
      });
    }
  }

  const edgeRows = params.graph.edges.map((edge) => {
    const sourceNodeId = buildGraphNodeId(edge.source);
    const targetNodeId = buildGraphNodeId(edge.target);
    const searchText = buildEdgeSearchText(edge, sourceNodeId, targetNodeId);
    const summary = edge.summary || `${edge.source} ${edge.relation} ${edge.target}`;
    const evidence = edge.evidence || "";
    const edgeId = `${sourceNodeId}:${edge.relation}:${targetNodeId}`;
    return (
      `('${randomUUID()}', '${esc(edgePath)}', '${esc(edgeFilename)}', '${esc(edgeId)}', ` +
      `'${esc(sourceNodeId)}', '${esc(targetNodeId)}', '${esc(edge.relation)}', E'${esc(summary)}', ` +
      `E'${esc(evidence)}', E'${esc(searchText)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', ` +
      `'${esc(params.userName)}', 'application/json', ${Buffer.byteLength(searchText, "utf-8")}, '${esc(params.project)}', ` +
      `E'${esc(buildSummaryBlurb(summary))}', '${esc(params.agent)}', '${ts}', '${ts}')`
    );
  });

  if (edgeRows.length > 0) {
    const insertEdgesSql = `INSERT INTO "${params.edgesTable}" ` +
      `(id, path, filename, edge_id, source_node_id, target_node_id, relation, summary, evidence, search_text, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
      `VALUES ${edgeRows.join(", ")}`;
    try {
      await params.query(insertEdgesSql);
    } catch (error) {
      throw wrapGraphPhaseError(error, {
        phase: "insert_edges",
        sessionId: params.sessionId,
        table: params.edgesTable,
        sql: insertEdgesSql,
      });
    }
  }

  return { nodes: nodeRows.length, edges: edgeRows.length };
}
