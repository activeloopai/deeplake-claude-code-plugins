#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { basename } from "node:path";
import { loadCredentials } from "../commands/auth.js";
import { DeeplakeApi, DeeplakeQueryError, summarizeSql } from "../deeplake-api.js";
import {
  buildGraphNodeId,
  buildKnowledgeGraphPrompt,
  type GraphExtraction,
  parseGraphExtraction,
} from "../hooks/knowledge-graph.js";
import { buildSummaryBlurb } from "../utils/summary-format.js";
import { esc } from "../hooks/upload-summary.js";
import { findClaudeBin } from "../hooks/spawn-wiki-worker.js";

const execFileAsync = promisify(execFile);

interface Args {
  memoryTable: string;
  graphNodesTable: string;
  graphEdgesTable: string;
  concurrency: number;
  model: string;
  clearGraph: boolean;
  errorLogPath?: string;
}

interface SummaryRow {
  path: string;
  summary: string;
  project?: string;
}

interface AggregateNode {
  nodeId: string;
  canonicalName: string;
  nodeType: string;
  aliases: Set<string>;
  summaries: Set<string>;
  sourceSessionIds: Set<string>;
  sourcePaths: Set<string>;
  representativeSessionId: string;
  representativeSourcePath: string;
}

interface AggregateEdge {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: string;
  summaries: Set<string>;
  evidences: Set<string>;
  sourceSessionIds: Set<string>;
  sourcePaths: Set<string>;
  representativeSessionId: string;
  representativeSourcePath: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const opts: Args = {
    memoryTable: "memory",
    graphNodesTable: "graph_nodes",
    graphEdgesTable: "graph_edges",
    concurrency: 4,
    model: "haiku",
    clearGraph: false,
    errorLogPath: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--memory-table":
        opts.memoryTable = args[++i] ?? opts.memoryTable;
        break;
      case "--graph-nodes-table":
        opts.graphNodesTable = args[++i] ?? opts.graphNodesTable;
        break;
      case "--graph-edges-table":
        opts.graphEdgesTable = args[++i] ?? opts.graphEdgesTable;
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, parseInt(args[++i] ?? "4", 10) || 4);
        break;
      case "--model":
        opts.model = args[++i] ?? opts.model;
        break;
      case "--clear-graph":
        opts.clearGraph = true;
        break;
      case "--error-log":
        opts.errorLogPath = args[++i] ?? opts.errorLogPath;
        break;
    }
  }
  return opts;
}

function extractSummarySourcePath(summary: string): string {
  const match = summary.match(/^- \*\*Source\*\*: (.+)$/m);
  return match?.[1]?.trim() || "";
}

function sessionIdFromSummaryPath(path: string): string {
  const base = basename(path).replace(/\.md$/, "");
  return base.endsWith("_summary") ? base.slice(0, -"_summary".length) : base;
}

async function generateGraph(summary: string, sourcePath: string, sessionId: string, project: string, claudeBin: string, model: string) {
  const prompt = buildKnowledgeGraphPrompt({
    summaryText: summary,
    sessionId,
    sourcePath,
    project,
  });
  const { stdout } = await execFileAsync(claudeBin, [
    "-p",
    prompt,
    "--no-session-persistence",
    "--model",
    model,
    "--permission-mode",
    "bypassPermissions",
  ], {
    timeout: 120_000,
    env: {
      ...process.env,
      DEEPLAKE_CAPTURE: "false",
      HIVEMIND_CAPTURE: "false",
      HIVEMIND_WIKI_WORKER: "1",
    },
  });
  return parseGraphExtraction(stdout);
}

function serializeError(error: unknown): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error));
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  const record = err as Error & Record<string, unknown>;
  if (typeof record["phase"] === "string") out["phase"] = record["phase"];
  if (typeof record["sessionId"] === "string") out["sessionId"] = record["sessionId"];
  if (typeof record["table"] === "string") out["table"] = record["table"];
  if (typeof record["sql"] === "string") out["sql"] = record["sql"];
  if (error instanceof DeeplakeQueryError) {
    out["sqlSummary"] = error.sqlSummary;
    out["status"] = error.status;
    out["responseBody"] = error.responseBody;
  } else if (typeof record["sql"] === "string") {
    out["sqlSummary"] = summarizeSql(record["sql"] as string);
  }
  const cause = record["cause"];
  if (cause instanceof DeeplakeQueryError) {
    out["cause"] = {
      name: cause.name,
      message: cause.message,
      sqlSummary: cause.sqlSummary,
      status: cause.status,
      responseBody: cause.responseBody,
      stack: cause.stack,
    };
  } else if (cause instanceof Error) {
    out["cause"] = {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
    };
  } else if (cause != null) {
    out["cause"] = String(cause);
  }
  return out;
}

function appendErrorLog(logPath: string | undefined, payload: Record<string, unknown>): void {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf-8");
}

const NODE_TYPE_PRIORITY = [
  "person",
  "organization",
  "place",
  "event",
  "project",
  "artifact",
  "tool",
  "file",
  "goal",
  "status",
  "preference",
  "concept",
  "other",
];

function nodeTypeRank(value: string): number {
  const idx = NODE_TYPE_PRIORITY.indexOf(value);
  return idx === -1 ? NODE_TYPE_PRIORITY.length : idx;
}

function preferNodeType(a: string, b: string): string {
  return nodeTypeRank(a) <= nodeTypeRank(b) ? a : b;
}

function pushLimited(set: Set<string>, value: string, max = 8): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (set.has(trimmed)) return;
  if (set.size >= max) return;
  set.add(trimmed);
}

function mergeSummarySet(set: Set<string>): string {
  return [...set].join(" | ");
}

function chooseRepresentative(set: Set<string>, fallback: string): string {
  return [...set].at(-1) || fallback;
}

function resolveNodeId(name: string, aliases: string[], aliasMap: Map<string, string>): string {
  const candidates = [name, ...aliases]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => buildGraphNodeId(value));
  for (const candidate of candidates) {
    const existing = aliasMap.get(candidate);
    if (existing) return existing;
  }
  return buildGraphNodeId(name);
}

function mergeGraphIntoAggregate(args: {
  graph: GraphExtraction;
  sessionId: string;
  sourcePath: string;
  nodes: Map<string, AggregateNode>;
  edges: Map<string, AggregateEdge>;
  aliasMap: Map<string, string>;
}): void {
  const localNodeIds = new Map<string, string>();
  const ensureNode = (rawName: string, type = "other", summary = "", aliases: string[] = []): string => {
    const name = rawName.trim();
    if (!name) return buildGraphNodeId("unknown");
    const nodeId = resolveNodeId(name, aliases, args.aliasMap);
    const existing = args.nodes.get(nodeId);
    if (existing) {
      existing.nodeType = preferNodeType(existing.nodeType, type || "other");
      pushLimited(existing.summaries, summary);
      existing.sourceSessionIds.add(args.sessionId);
      existing.sourcePaths.add(args.sourcePath);
      existing.representativeSessionId = args.sessionId;
      existing.representativeSourcePath = args.sourcePath;
      for (const alias of [name, ...aliases]) {
        const trimmed = alias.trim();
        if (!trimmed) continue;
        existing.aliases.add(trimmed);
        args.aliasMap.set(buildGraphNodeId(trimmed), nodeId);
      }
    } else {
      const node: AggregateNode = {
        nodeId,
        canonicalName: name,
        nodeType: type || "other",
        aliases: new Set<string>(),
        summaries: new Set<string>(),
        sourceSessionIds: new Set<string>([args.sessionId]),
        sourcePaths: new Set<string>([args.sourcePath]),
        representativeSessionId: args.sessionId,
        representativeSourcePath: args.sourcePath,
      };
      pushLimited(node.summaries, summary);
      for (const alias of [name, ...aliases]) {
        const trimmed = alias.trim();
        if (!trimmed) continue;
        node.aliases.add(trimmed);
        args.aliasMap.set(buildGraphNodeId(trimmed), nodeId);
      }
      args.nodes.set(nodeId, node);
    }
    localNodeIds.set(name, nodeId);
    return nodeId;
  };

  for (const node of args.graph.nodes) {
    ensureNode(node.name, node.type || "other", node.summary || "", node.aliases || []);
  }
  for (const edge of args.graph.edges) {
    const sourceNodeId = localNodeIds.get(edge.source.trim()) || ensureNode(edge.source);
    const targetNodeId = localNodeIds.get(edge.target.trim()) || ensureNode(edge.target);
    const edgeId = `${sourceNodeId}:${edge.relation}:${targetNodeId}`;
    const existing = args.edges.get(edgeId);
    if (existing) {
      pushLimited(existing.summaries, edge.summary || `${edge.source} ${edge.relation} ${edge.target}`);
      pushLimited(existing.evidences, edge.evidence || "");
      existing.sourceSessionIds.add(args.sessionId);
      existing.sourcePaths.add(args.sourcePath);
      existing.representativeSessionId = args.sessionId;
      existing.representativeSourcePath = args.sourcePath;
    } else {
      const aggregateEdge: AggregateEdge = {
        edgeId,
        sourceNodeId,
        targetNodeId,
        relation: edge.relation,
        summaries: new Set<string>(),
        evidences: new Set<string>(),
        sourceSessionIds: new Set<string>([args.sessionId]),
        sourcePaths: new Set<string>([args.sourcePath]),
        representativeSessionId: args.sessionId,
        representativeSourcePath: args.sourcePath,
      };
      pushLimited(aggregateEdge.summaries, edge.summary || `${edge.source} ${edge.relation} ${edge.target}`);
      pushLimited(aggregateEdge.evidences, edge.evidence || "");
      args.edges.set(edgeId, aggregateEdge);
    }
  }
}

async function insertAggregatedGraph(args: {
  api: DeeplakeApi;
  nodesTable: string;
  edgesTable: string;
  project: string;
  agent: string;
  nodes: Map<string, AggregateNode>;
  edges: Map<string, AggregateEdge>;
}): Promise<void> {
  const ts = new Date().toISOString();
  const nodePath = "/graphs/nodes/locomo/global.jsonl";
  const edgePath = "/graphs/edges/locomo/global.jsonl";
  const nodeFilename = "global.jsonl";
  const edgeFilename = "global.jsonl";

  await args.api.query(`DELETE FROM "${args.nodesTable}"`);
  await args.api.query(`DELETE FROM "${args.edgesTable}"`);

  const nodeRows = [...args.nodes.values()].map((node) => {
    const aliases = [...node.aliases].filter((alias) => alias !== node.canonicalName);
    const sourceSessionIds = [...node.sourceSessionIds];
    const sourcePaths = [...node.sourcePaths];
    const summary = mergeSummarySet(node.summaries) || buildSummaryBlurb(`# Graph Node\n\n${node.canonicalName}`);
    const searchText = [
      node.canonicalName,
      node.nodeType,
      ...aliases,
      ...node.summaries,
      ...sourceSessionIds,
      ...sourcePaths,
    ].join(" | ");
    return (
      `('${randomUUID()}', '${esc(nodePath)}', '${esc(nodeFilename)}', '${esc(node.nodeId)}', ` +
      `'${esc(node.canonicalName)}', '${esc(node.nodeType)}', E'${esc(summary)}', E'${esc(searchText)}', ` +
      `'${esc(aliases.join(", "))}', '${esc(chooseRepresentative(node.sourceSessionIds, node.representativeSessionId))}', ` +
      `'${esc(sourceSessionIds.join(" || "))}', '${esc(chooseRepresentative(node.sourcePaths, node.representativeSourcePath))}', ` +
      `'${esc(sourcePaths.join(" || "))}', 'locomo', 'application/json', ` +
      `${Buffer.byteLength(searchText, "utf-8")}, '${esc(args.project)}', E'${esc(buildSummaryBlurb(summary))}', ` +
      `'${esc(args.agent)}', '${ts}', '${ts}')`
    );
  });

  for (let i = 0; i < nodeRows.length; i += 100) {
    const chunk = nodeRows.slice(i, i + 100);
    if (chunk.length === 0) continue;
    await args.api.query(
      `INSERT INTO "${args.nodesTable}" ` +
      `(id, path, filename, node_id, canonical_name, node_type, summary, search_text, aliases, source_session_id, source_session_ids, source_path, source_paths, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
      `VALUES ${chunk.join(", ")}`
    );
  }

  const edgeRows = [...args.edges.values()].map((edge) => {
    const sourceSessionIds = [...edge.sourceSessionIds];
    const sourcePaths = [...edge.sourcePaths];
    const summary = mergeSummarySet(edge.summaries) || edge.edgeId;
    const evidence = mergeSummarySet(edge.evidences);
    const searchText = [
      edge.sourceNodeId,
      edge.relation,
      edge.targetNodeId,
      ...edge.summaries,
      ...edge.evidences,
      ...sourceSessionIds,
      ...sourcePaths,
    ].join(" | ");
    return (
      `('${randomUUID()}', '${esc(edgePath)}', '${esc(edgeFilename)}', '${esc(edge.edgeId)}', ` +
      `'${esc(edge.sourceNodeId)}', '${esc(edge.targetNodeId)}', '${esc(edge.relation)}', E'${esc(summary)}', ` +
      `E'${esc(evidence)}', E'${esc(searchText)}', '${esc(chooseRepresentative(edge.sourceSessionIds, edge.representativeSessionId))}', ` +
      `'${esc(sourceSessionIds.join(" || "))}', '${esc(chooseRepresentative(edge.sourcePaths, edge.representativeSourcePath))}', ` +
      `'${esc(sourcePaths.join(" || "))}', 'locomo', 'application/json', ` +
      `${Buffer.byteLength(searchText, "utf-8")}, '${esc(args.project)}', E'${esc(buildSummaryBlurb(summary))}', ` +
      `'${esc(args.agent)}', '${ts}', '${ts}')`
    );
  });

  for (let i = 0; i < edgeRows.length; i += 100) {
    const chunk = edgeRows.slice(i, i + 100);
    if (chunk.length === 0) continue;
    await args.api.query(
      `INSERT INTO "${args.edgesTable}" ` +
      `(id, path, filename, edge_id, source_node_id, target_node_id, relation, summary, evidence, search_text, source_session_id, source_session_ids, source_path, source_paths, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
      `VALUES ${chunk.join(", ")}`
    );
  }
}

async function withConcurrency<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>) {
  let next = 0;
  let running = 0;
  await new Promise<void>((resolve) => {
    function launch() {
      while (running < concurrency && next < items.length) {
        const idx = next++;
        running++;
        fn(items[idx], idx).finally(() => {
          running--;
          if (next >= items.length && running === 0) resolve();
          else launch();
        });
      }
    }
    launch();
  });
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const errorLogPath = opts.errorLogPath || `/tmp/locomo-graph-backfill-errors-${Date.now()}.jsonl`;
  writeFileSync(errorLogPath, "", "utf-8");
  console.log(`error_log=${errorLogPath}`);
  const creds = loadCredentials();
  if (!creds?.token) throw new Error("No Deeplake credentials found. Run hivemind login first.");

  const api = new DeeplakeApi(
    creds.token,
    creds.apiUrl ?? "https://api.deeplake.ai",
    creds.orgId,
    creds.workspaceId ?? "default",
    opts.memoryTable,
  );

  await api.ensureGraphNodesTable(opts.graphNodesTable);
  await api.ensureGraphEdgesTable(opts.graphEdgesTable);
  if (opts.clearGraph) {
    await api.query(`DELETE FROM "${opts.graphNodesTable}"`);
    await api.query(`DELETE FROM "${opts.graphEdgesTable}"`);
  }

  const summaryRows = (await api.query(
    `SELECT path, summary, project FROM "${opts.memoryTable}" WHERE path LIKE '/summaries/locomo/%' ORDER BY path`
  ))
    .filter((row) => typeof row["path"] === "string" && typeof row["summary"] === "string")
    .map((row) => ({
      path: row["path"] as string,
      summary: row["summary"] as string,
      project: typeof row["project"] === "string" ? row["project"] as string : undefined,
    })) as SummaryRow[];
  const claudeBin = findClaudeBin();
  const aggregateNodes = new Map<string, AggregateNode>();
  const aggregateEdges = new Map<string, AggregateEdge>();
  const aliasMap = new Map<string, string>();

  let completed = 0;
  let failed = 0;
  await withConcurrency(summaryRows, opts.concurrency, async (row) => {
    const sessionId = sessionIdFromSummaryPath(row.path);
    const sourcePath = extractSummarySourcePath(row.summary) || `/sessions/${sessionId}.jsonl`;
    try {
      const graph = await generateGraph(row.summary, sourcePath, sessionId, row.project || "locomo", claudeBin, opts.model);
      mergeGraphIntoAggregate({
        graph,
        sessionId,
        sourcePath,
        nodes: aggregateNodes,
        edges: aggregateEdges,
        aliasMap,
      });
      completed++;
      if (completed % 10 === 0 || completed === summaryRows.length) {
        console.log(`graph ${completed}/${summaryRows.length}`);
      }
    } catch (error) {
      failed++;
      const serialized = serializeError(error);
      appendErrorLog(errorLogPath, {
        ts: new Date().toISOString(),
        summaryPath: row.path,
        sessionId,
        sourcePath,
        project: row.project || "locomo",
        ...serialized,
      });
      const phase = typeof serialized["phase"] === "string" ? ` phase=${serialized["phase"]}` : "";
      const status = typeof serialized["status"] === "number" ? ` status=${serialized["status"]}` : "";
      const sqlSummary = typeof serialized["sqlSummary"] === "string" ? ` sql=${serialized["sqlSummary"]}` : "";
      console.error(`FAIL ${row.path}:${phase}${status}${sqlSummary} ${serialized["message"]}`);
    }
  });

  if (failed === 0 || completed > 0) {
    await insertAggregatedGraph({
      api,
      nodesTable: opts.graphNodesTable,
      edgesTable: opts.graphEdgesTable,
      project: "locomo",
      agent: "claude_code",
      nodes: aggregateNodes,
      edges: aggregateEdges,
    });
    console.log(`graph_rows nodes=${aggregateNodes.size} edges=${aggregateEdges.size}`);
  }

  console.log(`Done. graph_summaries=${completed} failed=${failed}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
