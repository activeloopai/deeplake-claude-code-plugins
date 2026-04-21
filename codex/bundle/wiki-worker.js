#!/usr/bin/env node

// dist/src/hooks/codex/wiki-worker.js
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, existsSync as existsSync2, appendFileSync as appendFileSync2, mkdirSync as mkdirSync2, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join as join3 } from "node:path";

// dist/src/hooks/summary-state.js
import { readFileSync, writeFileSync, writeSync, mkdirSync, renameSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var DEBUG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var LOG = join(homedir(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/hooks/summary-state.js
var dlog = (msg) => log("summary-state", msg);
var STATE_DIR = join2(homedir2(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function statePath(sessionId) {
  return join2(STATE_DIR, `${sessionId}.json`);
}
function lockPath(sessionId) {
  return join2(STATE_DIR, `${sessionId}.lock`);
}
function readState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync(p))
    return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = statePath(sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}
function withRmwLock(sessionId, fn) {
  mkdirSync(STATE_DIR, { recursive: true });
  const rmwLock = statePath(sessionId) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(rmwLock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        dlog(`rmw lock deadline exceeded for ${sessionId}, reclaiming stale lock`);
        try {
          unlinkSync(rmwLock);
        } catch (unlinkErr) {
          dlog(`stale rmw lock unlink failed for ${sessionId}: ${unlinkErr.message}`);
        }
        continue;
      }
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(rmwLock);
    } catch (unlinkErr) {
      dlog(`rmw lock cleanup failed for ${sessionId}: ${unlinkErr.message}`);
    }
  }
}
function finalizeSummary(sessionId, jsonlLines) {
  withRmwLock(sessionId, () => {
    const prev = readState(sessionId);
    writeState(sessionId, {
      lastSummaryAt: Date.now(),
      lastSummaryCount: jsonlLines,
      totalCount: Math.max(prev?.totalCount ?? 0, jsonlLines)
    });
  });
}
function releaseLock(sessionId) {
  try {
    unlinkSync(lockPath(sessionId));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      dlog(`releaseLock unlink failed for ${sessionId}: ${e.message}`);
    }
  }
}

// dist/src/hooks/upload-summary.js
import { randomUUID } from "node:crypto";

// dist/src/utils/summary-format.js
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractSection(text, heading) {
  const re = new RegExp(`^## ${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}
function extractHeaderField(text, field) {
  const re = new RegExp(`^- \\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+)$`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}
function compactText(value) {
  return value.replace(/\s+/g, " ").trim();
}
function extractBullets(section, limit = 3) {
  if (!section)
    return [];
  return section.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => compactText(line.slice(2))).filter(Boolean).slice(0, limit);
}
function extractSummaryParticipants(text) {
  return extractHeaderField(text, "Participants") ?? extractHeaderField(text, "Speakers");
}
function extractSummaryTopics(text) {
  return extractHeaderField(text, "Topics");
}
function buildSummaryBlurb(text) {
  const participants = extractSummaryParticipants(text);
  const topics = extractSummaryTopics(text);
  const factBullets = extractBullets(extractSection(text, "Searchable Facts"), 3);
  const keyBullets = factBullets.length > 0 ? factBullets : extractBullets(extractSection(text, "Key Facts"), 3);
  const whatHappened = compactText(extractSection(text, "What Happened") ?? "");
  const parts = [];
  if (participants)
    parts.push(participants);
  if (topics)
    parts.push(topics);
  if (keyBullets.length > 0)
    parts.push(keyBullets.join("; "));
  if (parts.length === 0 && whatHappened)
    parts.push(whatHappened);
  const blurb = parts.join(" | ").slice(0, 300).trim();
  return blurb || "completed";
}

// dist/src/hooks/upload-summary.js
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function extractDescription(text) {
  return buildSummaryBlurb(text);
}
async function uploadSummary(query2, params) {
  const { tableName, vpath, fname, userName, project, agent, text } = params;
  const ts = params.ts ?? (/* @__PURE__ */ new Date()).toISOString();
  const desc = extractDescription(text);
  const sizeBytes = Buffer.byteLength(text);
  const existing = await query2(`SELECT path FROM "${tableName}" WHERE path = '${esc(vpath)}' LIMIT 1`);
  if (existing.length > 0) {
    const sql2 = `UPDATE "${tableName}" SET summary = E'${esc(text)}', size_bytes = ${sizeBytes}, description = E'${esc(desc)}', last_update_date = '${ts}' WHERE path = '${esc(vpath)}'`;
    await query2(sql2);
    return { path: "update", sql: sql2, descLength: desc.length, summaryLength: text.length };
  }
  const sql = `INSERT INTO "${tableName}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ('${randomUUID()}', '${esc(vpath)}', '${esc(fname)}', E'${esc(text)}', '${esc(userName)}', 'text/markdown', ${sizeBytes}, '${esc(project)}', E'${esc(desc)}', '${esc(agent)}', '${ts}', '${ts}')`;
  await query2(sql);
  return { path: "insert", sql, descLength: desc.length, summaryLength: text.length };
}

// dist/src/hooks/knowledge-graph.js
import { randomUUID as randomUUID2 } from "node:crypto";
var GRAPH_PROMPT_TEMPLATE = `You are extracting a compact knowledge graph delta from a session summary.

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
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function normalizeAliasList(value) {
  if (!Array.isArray(value))
    return [];
  return value.map(normalizeString).filter(Boolean).filter((item, index, arr) => arr.indexOf(item) === index);
}
function parseGraphExtraction(raw) {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);
  const nodes = Array.isArray(parsed["nodes"]) ? parsed["nodes"] : [];
  const edges = Array.isArray(parsed["edges"]) ? parsed["edges"] : [];
  return {
    nodes: nodes.map((node) => ({
      name: normalizeString(node["name"]),
      type: normalizeString(node["type"]) || "other",
      summary: normalizeString(node["summary"]),
      aliases: normalizeAliasList(node["aliases"])
    })).filter((node) => node.name),
    edges: edges.map((edge) => ({
      source: normalizeString(edge["source"]),
      target: normalizeString(edge["target"]),
      relation: normalizeString(edge["relation"]).replace(/\s+/g, "_").toLowerCase(),
      summary: normalizeString(edge["summary"]),
      evidence: normalizeString(edge["evidence"])
    })).filter((edge) => edge.source && edge.target && edge.relation)
  };
}
function slugify(value) {
  return value.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}
function buildGraphNodeId(name, _type = "other") {
  return `entity:${slugify(name)}`;
}
function buildNodeSearchText(node) {
  return [
    node.name,
    node.type ?? "other",
    ...node.aliases ?? [],
    node.summary ?? ""
  ].filter(Boolean).join(" | ");
}
function buildEdgeSearchText(edge, sourceNodeId, targetNodeId) {
  return [
    edge.source,
    edge.relation,
    edge.target,
    edge.summary ?? "",
    edge.evidence ?? "",
    sourceNodeId,
    targetNodeId
  ].filter(Boolean).join(" | ");
}
function buildKnowledgeGraphPrompt(args) {
  return (args.template ?? GRAPH_PROMPT_TEMPLATE).replace(/__SUMMARY_TEXT__/g, args.summaryText).replace(/__SESSION_ID__/g, args.sessionId).replace(/__SOURCE_PATH__/g, args.sourcePath).replace(/__PROJECT__/g, args.project);
}
function wrapGraphPhaseError(error, args) {
  const wrapped = new Error(`graph ${args.phase} failed for session ${args.sessionId} on table ${args.table}: ${error instanceof Error ? error.message : String(error)}`);
  wrapped.cause = error;
  wrapped.phase = args.phase;
  wrapped.sessionId = args.sessionId;
  wrapped.table = args.table;
  wrapped.sql = args.sql;
  return wrapped;
}
async function replaceSessionGraph(params) {
  const ts = params.ts ?? (/* @__PURE__ */ new Date()).toISOString();
  const nodePath = `/graphs/nodes/${params.userName}/${params.sessionId}.jsonl`;
  const edgePath = `/graphs/edges/${params.userName}/${params.sessionId}.jsonl`;
  const nodeFilename = `${params.sessionId}.jsonl`;
  const edgeFilename = `${params.sessionId}.jsonl`;
  const nodeMap = /* @__PURE__ */ new Map();
  for (const node of params.graph.nodes) {
    const key = buildGraphNodeId(node.name, node.type);
    nodeMap.set(key, {
      name: node.name,
      type: node.type || "other",
      summary: node.summary || "",
      aliases: node.aliases || []
    });
  }
  for (const edge of params.graph.edges) {
    const sourceKey = buildGraphNodeId(edge.source);
    const targetKey = buildGraphNodeId(edge.target);
    if (!nodeMap.has(sourceKey))
      nodeMap.set(sourceKey, { name: edge.source, type: "other", summary: "", aliases: [] });
    if (!nodeMap.has(targetKey))
      nodeMap.set(targetKey, { name: edge.target, type: "other", summary: "", aliases: [] });
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
      sql: deleteNodesSql
    });
  }
  try {
    await params.query(deleteEdgesSql);
  } catch (error) {
    throw wrapGraphPhaseError(error, {
      phase: "delete_edges",
      sessionId: params.sessionId,
      table: params.edgesTable,
      sql: deleteEdgesSql
    });
  }
  const nodeRows = [...nodeMap.entries()].map(([nodeId, node]) => {
    const summary = node.summary || buildSummaryBlurb(`# Graph Node

${node.name}`);
    const aliases = (node.aliases ?? []).join(", ");
    const searchText = buildNodeSearchText(node);
    return `('${randomUUID2()}', '${esc(nodePath)}', '${esc(nodeFilename)}', '${esc(nodeId)}', '${esc(node.name)}', '${esc(node.type || "other")}', E'${esc(summary)}', E'${esc(searchText)}', '${esc(aliases)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', '${esc(params.userName)}', 'application/json', ${Buffer.byteLength(searchText, "utf-8")}, '${esc(params.project)}', E'${esc(buildSummaryBlurb(summary))}', '${esc(params.agent)}', '${ts}', '${ts}')`;
  });
  if (nodeRows.length > 0) {
    const insertNodesSql = `INSERT INTO "${params.nodesTable}" (id, path, filename, node_id, canonical_name, node_type, summary, search_text, aliases, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${nodeRows.join(", ")}`;
    try {
      await params.query(insertNodesSql);
    } catch (error) {
      throw wrapGraphPhaseError(error, {
        phase: "insert_nodes",
        sessionId: params.sessionId,
        table: params.nodesTable,
        sql: insertNodesSql
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
    return `('${randomUUID2()}', '${esc(edgePath)}', '${esc(edgeFilename)}', '${esc(edgeId)}', '${esc(sourceNodeId)}', '${esc(targetNodeId)}', '${esc(edge.relation)}', E'${esc(summary)}', E'${esc(evidence)}', E'${esc(searchText)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', '${esc(params.userName)}', 'application/json', ${Buffer.byteLength(searchText, "utf-8")}, '${esc(params.project)}', E'${esc(buildSummaryBlurb(summary))}', '${esc(params.agent)}', '${ts}', '${ts}')`;
  });
  if (edgeRows.length > 0) {
    const insertEdgesSql = `INSERT INTO "${params.edgesTable}" (id, path, filename, edge_id, source_node_id, target_node_id, relation, summary, evidence, search_text, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${edgeRows.join(", ")}`;
    try {
      await params.query(insertEdgesSql);
    } catch (error) {
      throw wrapGraphPhaseError(error, {
        phase: "insert_edges",
        sessionId: params.sessionId,
        table: params.edgesTable,
        sql: insertEdgesSql
      });
    }
  }
  return { nodes: nodeRows.length, edges: edgeRows.length };
}

// dist/src/hooks/memory-facts.js
import { randomUUID as randomUUID3 } from "node:crypto";
var MEMORY_FACT_PROMPT_TEMPLATE = `You are extracting durable long-term memory facts from raw session transcript rows.

SESSION ID: __SESSION_ID__
SOURCE PATH: __SOURCE_PATH__
PROJECT: __PROJECT__

TRANSCRIPT ROWS:
__TRANSCRIPT_TEXT__

Return ONLY valid JSON with this exact shape:
{"facts":[{"subject":"canonical entity","subject_type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","subject_aliases":["optional alias"],"predicate":"snake_case_relation","object":"canonical object text","object_type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","object_aliases":["optional alias"],"summary":"short factual claim","evidence":"short supporting phrase","confidence":0.0,"valid_at":"optional date/time text","valid_from":"optional date/time text","valid_to":"optional date/time text"}]}

Rules:
- The transcript rows are the only source of truth for this extraction. Do not rely on summaries or inferred rewrites.
- Extract atomic facts that are useful for later recall. One durable claim per fact.
- Prefer canonical names for repeated people, organizations, places, projects, tools, and artifacts.
- Use relation-style predicates such as works_on, home_country, relationship_status, prefers, plans, decided_to_pursue, located_in, uses_tool, recommended, supports, owns, read, attends, moved_from, moved_to.
- Facts should preserve temporal history instead of overwriting it. If the transcript says something changed, emit the new fact and include timing in valid_at / valid_from / valid_to when the transcript supports it.
- Include assistant-confirmed or tool-confirmed actions when they are stated as completed facts in the transcript.
- If a speaker explicitly self-identifies or states a status, preserve that exact label instead of broadening it.
- Preserve exact named places, titles, organizations, and relative time phrases when they are the stated fact.
- Do not invent facts that are not supported by the transcript.
- Avoid duplicates or near-duplicates. If two facts say the same thing, keep the more specific one.
- Return no markdown, no prose, no code fences, only JSON.`;
function stripCodeFences2(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
function normalizeString2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function normalizeAliases(value) {
  if (!Array.isArray(value))
    return [];
  return value.map(normalizeString2).filter(Boolean).filter((item, index, arr) => arr.indexOf(item) === index);
}
function normalizeFactType(value) {
  return normalizeString2(value) || "other";
}
function normalizeConfidence(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      return Math.max(0, Math.min(1, parsed));
  }
  return void 0;
}
function slugify2(value) {
  return value.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}
function buildFactId(sessionId, fact, index) {
  return [
    "fact",
    slugify2(sessionId),
    String(index + 1),
    slugify2(fact.subject),
    slugify2(fact.predicate),
    slugify2(fact.object)
  ].join(":");
}
function buildFactSearchText(fact) {
  return [
    fact.subject,
    ...fact.subjectAliases ?? [],
    fact.predicate,
    fact.object,
    ...fact.objectAliases ?? [],
    fact.summary ?? "",
    fact.evidence ?? "",
    fact.validAt ?? "",
    fact.validFrom ?? "",
    fact.validTo ?? ""
  ].filter(Boolean).join(" | ");
}
function buildEntitySearchText(entity) {
  return [
    entity.canonicalName,
    entity.entityType,
    ...entity.aliases,
    ...entity.searchTerms,
    ...entity.summaries
  ].filter(Boolean).join(" | ");
}
function mergeDelimited(existing, nextValues) {
  const merged = new Set(existing.split(",").map((value) => value.trim()).filter(Boolean));
  for (const value of nextValues) {
    const trimmed = value.trim();
    if (!trimmed)
      continue;
    merged.add(trimmed);
  }
  return [...merged].join(", ");
}
function mergePipeDelimited(existing, nextValues, maxItems = 8) {
  const merged = new Set(existing.split("|").map((value) => value.trim()).filter(Boolean));
  for (const value of nextValues) {
    const trimmed = value.trim();
    if (!trimmed)
      continue;
    if (merged.has(trimmed))
      continue;
    if (merged.size >= maxItems)
      break;
    merged.add(trimmed);
  }
  return [...merged].join(" | ");
}
function wrapFactsPhaseError(error, args) {
  const wrapped = new Error(`facts ${args.phase} failed for session ${args.sessionId} on table ${args.table}: ${error instanceof Error ? error.message : String(error)}`);
  wrapped.cause = error;
  wrapped.phase = args.phase;
  wrapped.sessionId = args.sessionId;
  wrapped.table = args.table;
  wrapped.sql = args.sql;
  return wrapped;
}
function buildEntityAggregate(entityMap, args) {
  const entityId = buildGraphNodeId(args.name, args.type);
  const existing = entityMap.get(entityId);
  if (existing) {
    for (const alias of args.aliases)
      existing.aliases.add(alias);
    if (args.summary)
      existing.summaries.add(args.summary);
    if (args.searchText)
      existing.searchTerms.add(args.searchText);
    return existing;
  }
  const created = {
    entityId,
    canonicalName: args.name,
    entityType: args.type || "other",
    aliases: new Set(args.aliases),
    summaries: new Set(args.summary ? [args.summary] : []),
    searchTerms: new Set(args.searchText ? [args.searchText] : [])
  };
  entityMap.set(entityId, created);
  return created;
}
async function upsertEntities(params) {
  let upserts = 0;
  const path = `/facts/entities/${params.userName}.jsonl`;
  const filename = `${params.userName}.jsonl`;
  for (const entity of params.entityMap.values()) {
    const aliases = [...entity.aliases].filter((alias) => alias !== entity.canonicalName);
    const entitySummary = [...entity.summaries].join(" | ") || entity.canonicalName;
    const searchText = buildEntitySearchText(entity);
    const existingRows = await params.query(`SELECT id, aliases, summary, search_text, source_session_ids, source_paths, entity_type FROM "${params.entitiesTable}" WHERE entity_id = '${esc(entity.entityId)}' LIMIT 1`);
    if (existingRows.length === 0) {
      const insertSql = `INSERT INTO "${params.entitiesTable}" (id, path, filename, entity_id, canonical_name, entity_type, aliases, summary, search_text, source_session_ids, source_paths, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ('${randomUUID3()}', '${esc(path)}', '${esc(filename)}', '${esc(entity.entityId)}', '${esc(entity.canonicalName)}', '${esc(entity.entityType)}', '${esc(aliases.join(", "))}', E'${esc(entitySummary)}', E'${esc(searchText)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', '${esc(params.userName)}', 'application/json', ${Buffer.byteLength(searchText, "utf-8")}, '${esc(params.project)}', E'${esc(buildSummaryBlurb(entitySummary))}', '${esc(params.agent)}', '${params.ts}', '${params.ts}')`;
      await params.query(insertSql);
      upserts += 1;
      continue;
    }
    const existing = existingRows[0];
    const mergedAliases = mergeDelimited(String(existing["aliases"] ?? ""), aliases);
    const mergedSummary = mergePipeDelimited(String(existing["summary"] ?? ""), entity.summaries, 10) || entitySummary;
    const mergedSearchText = mergePipeDelimited(String(existing["search_text"] ?? ""), [searchText], 12) || searchText;
    const mergedSessionIds = mergeDelimited(String(existing["source_session_ids"] ?? ""), [params.sessionId]);
    const mergedSourcePaths = mergeDelimited(String(existing["source_paths"] ?? ""), [params.sourcePath]);
    const existingType = normalizeString2(existing["entity_type"]);
    const entityType = existingType && existingType !== "other" ? existingType : entity.entityType;
    const updateSql = `UPDATE "${params.entitiesTable}" SET canonical_name = '${esc(entity.canonicalName)}', entity_type = '${esc(entityType)}', aliases = '${esc(mergedAliases)}', summary = E'${esc(mergedSummary)}', search_text = E'${esc(mergedSearchText)}', source_session_ids = '${esc(mergedSessionIds)}', source_paths = '${esc(mergedSourcePaths)}', size_bytes = ${Buffer.byteLength(mergedSearchText, "utf-8")}, project = '${esc(params.project)}', description = E'${esc(buildSummaryBlurb(mergedSummary))}', agent = '${esc(params.agent)}', last_update_date = '${params.ts}' WHERE entity_id = '${esc(entity.entityId)}'`;
    await params.query(updateSql);
    upserts += 1;
  }
  return upserts;
}
function parseMemoryFactExtraction(raw) {
  const cleaned = stripCodeFences2(raw);
  const parsed = JSON.parse(cleaned);
  const facts = Array.isArray(parsed["facts"]) ? parsed["facts"] : [];
  const dedupe = /* @__PURE__ */ new Set();
  return {
    facts: facts.map((fact) => ({
      subject: normalizeString2(fact["subject"]),
      subjectType: normalizeFactType(fact["subject_type"]),
      subjectAliases: normalizeAliases(fact["subject_aliases"]),
      predicate: normalizeString2(fact["predicate"]).replace(/\s+/g, "_").toLowerCase(),
      object: normalizeString2(fact["object"]),
      objectType: normalizeFactType(fact["object_type"]),
      objectAliases: normalizeAliases(fact["object_aliases"]),
      summary: normalizeString2(fact["summary"]),
      evidence: normalizeString2(fact["evidence"]),
      confidence: normalizeConfidence(fact["confidence"]),
      validAt: normalizeString2(fact["valid_at"]),
      validFrom: normalizeString2(fact["valid_from"]),
      validTo: normalizeString2(fact["valid_to"])
    })).filter((fact) => fact.subject && fact.predicate && fact.object).filter((fact) => {
      const key = `${fact.subject}::${fact.predicate}::${fact.object}`;
      if (dedupe.has(key))
        return false;
      dedupe.add(key);
      return true;
    })
  };
}
function buildMemoryFactTranscript(rows) {
  const normalized = rows.map((row) => ({
    turnIndex: Number.isFinite(row.turnIndex) ? row.turnIndex : 0,
    speaker: normalizeString2(row.speaker),
    text: normalizeString2(row.text),
    eventType: normalizeString2(row.eventType) || "message",
    turnSummary: normalizeString2(row.turnSummary),
    sourceDateTime: normalizeString2(row.sourceDateTime) || normalizeString2(row.creationDate)
  })).filter((row) => row.text || row.turnSummary);
  if (normalized.length === 0)
    return "(no transcript rows)";
  return normalized.map((row) => {
    const prefix = [
      `turn=${row.turnIndex}`,
      row.sourceDateTime ? `time=${row.sourceDateTime}` : "",
      row.speaker ? `speaker=${row.speaker}` : `event=${row.eventType}`
    ].filter(Boolean).join(" | ");
    const lines = [`[${prefix}] ${row.text || row.turnSummary}`];
    if (row.turnSummary && row.turnSummary !== row.text) {
      lines.push(`summary: ${row.turnSummary}`);
    }
    return lines.join("\n");
  }).join("\n");
}
function buildMemoryFactPrompt(args) {
  return (args.template ?? MEMORY_FACT_PROMPT_TEMPLATE).replace(/__TRANSCRIPT_TEXT__/g, args.transcriptText).replace(/__SESSION_ID__/g, args.sessionId).replace(/__SOURCE_PATH__/g, args.sourcePath).replace(/__PROJECT__/g, args.project);
}
async function replaceSessionFacts(params) {
  const ts = params.ts ?? (/* @__PURE__ */ new Date()).toISOString();
  const factPath = `/facts/${params.userName}/${params.sessionId}.jsonl`;
  const linkPath = `/facts/links/${params.userName}/${params.sessionId}.jsonl`;
  const factFilename = `${params.sessionId}.jsonl`;
  const linkFilename = `${params.sessionId}.jsonl`;
  const deleteFactsSql = `DELETE FROM "${params.factsTable}" WHERE source_session_id = '${esc(params.sessionId)}'`;
  const deleteLinksSql = `DELETE FROM "${params.linksTable}" WHERE source_session_id = '${esc(params.sessionId)}'`;
  try {
    await params.query(deleteFactsSql);
  } catch (error) {
    throw wrapFactsPhaseError(error, {
      phase: "delete_facts",
      sessionId: params.sessionId,
      table: params.factsTable,
      sql: deleteFactsSql
    });
  }
  try {
    await params.query(deleteLinksSql);
  } catch (error) {
    throw wrapFactsPhaseError(error, {
      phase: "delete_links",
      sessionId: params.sessionId,
      table: params.linksTable,
      sql: deleteLinksSql
    });
  }
  const entityMap = /* @__PURE__ */ new Map();
  const factRows = params.extraction.facts.map((fact, index) => {
    const summary = fact.summary || `${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`;
    const searchText = buildFactSearchText(fact);
    const subjectEntity = buildEntityAggregate(entityMap, {
      name: fact.subject,
      type: fact.subjectType || "other",
      aliases: fact.subjectAliases ?? [],
      summary,
      searchText
    });
    const objectEntity = buildEntityAggregate(entityMap, {
      name: fact.object,
      type: fact.objectType || "other",
      aliases: fact.objectAliases ?? [],
      summary,
      searchText
    });
    return {
      factId: buildFactId(params.sessionId, fact, index),
      subjectEntityId: subjectEntity.entityId,
      subjectName: fact.subject,
      subjectType: fact.subjectType || "other",
      objectEntityId: objectEntity.entityId,
      objectName: fact.object,
      objectType: fact.objectType || "other",
      predicate: fact.predicate,
      summary,
      evidence: fact.evidence || "",
      searchText,
      confidence: fact.confidence == null ? "" : String(fact.confidence),
      validAt: fact.validAt || "",
      validFrom: fact.validFrom || "",
      validTo: fact.validTo || ""
    };
  });
  try {
    await upsertEntities({
      query: params.query,
      entitiesTable: params.entitiesTable,
      entityMap,
      userName: params.userName,
      project: params.project,
      agent: params.agent,
      sourcePath: params.sourcePath,
      sessionId: params.sessionId,
      ts
    });
  } catch (error) {
    throw wrapFactsPhaseError(error, {
      phase: "upsert_entities",
      sessionId: params.sessionId,
      table: params.entitiesTable,
      sql: `UPSERT entities for ${params.sessionId}`
    });
  }
  if (factRows.length > 0) {
    const values = factRows.map((row) => `('${randomUUID3()}', '${esc(factPath)}', '${esc(factFilename)}', '${esc(row.factId)}', '${esc(row.subjectEntityId)}', '${esc(row.subjectName)}', '${esc(row.subjectType)}', '${esc(row.predicate)}', '${esc(row.objectEntityId)}', '${esc(row.objectName)}', '${esc(row.objectType)}', E'${esc(row.summary)}', E'${esc(row.evidence)}', E'${esc(row.searchText)}', '${esc(row.confidence)}', '${esc(row.validAt)}', '${esc(row.validFrom)}', '${esc(row.validTo)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', '${esc(params.userName)}', 'application/json', ${Buffer.byteLength(row.searchText, "utf-8")}, '${esc(params.project)}', E'${esc(buildSummaryBlurb(row.summary))}', '${esc(params.agent)}', '${ts}', '${ts}')`);
    const insertFactsSql = `INSERT INTO "${params.factsTable}" (id, path, filename, fact_id, subject_entity_id, subject_name, subject_type, predicate, object_entity_id, object_name, object_type, summary, evidence, search_text, confidence, valid_at, valid_from, valid_to, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${values.join(", ")}`;
    try {
      await params.query(insertFactsSql);
    } catch (error) {
      throw wrapFactsPhaseError(error, {
        phase: "insert_facts",
        sessionId: params.sessionId,
        table: params.factsTable,
        sql: insertFactsSql
      });
    }
  }
  const linkRows = factRows.flatMap((row) => [
    {
      linkId: `${row.factId}:subject:${row.subjectEntityId}`,
      factId: row.factId,
      entityId: row.subjectEntityId,
      entityRole: "subject"
    },
    {
      linkId: `${row.factId}:object:${row.objectEntityId}`,
      factId: row.factId,
      entityId: row.objectEntityId,
      entityRole: "object"
    }
  ]);
  if (linkRows.length > 0) {
    const values = linkRows.map((row) => `('${randomUUID3()}', '${esc(linkPath)}', '${esc(linkFilename)}', '${esc(row.linkId)}', '${esc(row.factId)}', '${esc(row.entityId)}', '${esc(row.entityRole)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', '${esc(params.userName)}', 'application/json', ${Buffer.byteLength(row.linkId, "utf-8")}, '${esc(params.project)}', 'fact entity link', '${esc(params.agent)}', '${ts}', '${ts}')`);
    const insertLinksSql = `INSERT INTO "${params.linksTable}" (id, path, filename, link_id, fact_id, entity_id, entity_role, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${values.join(", ")}`;
    try {
      await params.query(insertLinksSql);
    } catch (error) {
      throw wrapFactsPhaseError(error, {
        phase: "insert_links",
        sessionId: params.sessionId,
        table: params.linksTable,
        sql: insertLinksSql
      });
    }
  }
  return {
    facts: factRows.length,
    entities: entityMap.size,
    links: linkRows.length
  };
}

// dist/src/hooks/codex/wiki-worker.js
var cfg = JSON.parse(readFileSync2(process.argv[2], "utf-8"));
var tmpDir = cfg.tmpDir;
var tmpJsonl = join3(tmpDir, "session.jsonl");
var tmpSummary = join3(tmpDir, "summary.md");
function wlog(msg) {
  try {
    mkdirSync2(cfg.hooksDir, { recursive: true });
    appendFileSync2(cfg.wikiLog, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] wiki-worker(${cfg.sessionId}): ${msg}
`);
  } catch {
  }
}
function esc2(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
async function query(sql, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(`${cfg.apiUrl}/workspaces/${cfg.workspaceId}/tables/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "X-Activeloop-Org-Id": cfg.orgId
      },
      body: JSON.stringify({ query: sql })
    });
    if (r.ok) {
      const j = await r.json();
      if (!j.columns || !j.rows)
        return [];
      return j.rows.map((row) => Object.fromEntries(j.columns.map((col, i) => [col, row[i]])));
    }
    const retryable = r.status === 401 || r.status === 403 || r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503;
    if (attempt < retries && retryable) {
      const base = Math.min(3e4, 2e3 * Math.pow(2, attempt));
      const delay = base + Math.floor(Math.random() * 1e3);
      wlog(`API ${r.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return [];
}
function cleanup() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
  }
}
async function main() {
  try {
    wlog("fetching session events");
    const rows = await query(`SELECT path, message, creation_date, turn_index, event_type, speaker, text, turn_summary, source_date_time FROM "${cfg.sessionsTable}" WHERE path LIKE E'${esc2(`/sessions/%${cfg.sessionId}%`)}' ORDER BY creation_date ASC, turn_index ASC`);
    if (rows.length === 0) {
      wlog("no session events found \u2014 exiting");
      return;
    }
    const jsonlContent = rows.map((r) => typeof r.message === "string" ? r.message : JSON.stringify(r.message)).join("\n");
    const jsonlLines = rows.length;
    const pathRows = await query(`SELECT DISTINCT path FROM "${cfg.sessionsTable}" WHERE path LIKE '${esc2(`/sessions/%${cfg.sessionId}%`)}' LIMIT 1`);
    const jsonlServerPath = pathRows.length > 0 ? pathRows[0].path : `/sessions/unknown/${cfg.sessionId}.jsonl`;
    writeFileSync2(tmpJsonl, jsonlContent);
    wlog(`found ${jsonlLines} events at ${jsonlServerPath}`);
    let prevOffset = 0;
    try {
      const sumRows = await query(`SELECT summary FROM "${cfg.memoryTable}" WHERE path = '${esc2(`/summaries/${cfg.userName}/${cfg.sessionId}.md`)}' LIMIT 1`);
      if (sumRows.length > 0 && sumRows[0]["summary"]) {
        const existing = sumRows[0]["summary"];
        const match = existing.match(/\*\*JSONL offset\*\*:\s*(\d+)/);
        if (match)
          prevOffset = parseInt(match[1], 10);
        writeFileSync2(tmpSummary, existing);
        wlog(`existing summary found, offset=${prevOffset}`);
      }
    } catch {
    }
    const prompt = cfg.promptTemplate.replace(/__JSONL__/g, tmpJsonl).replace(/__SUMMARY__/g, tmpSummary).replace(/__SESSION_ID__/g, cfg.sessionId).replace(/__PROJECT__/g, cfg.project).replace(/__PREV_OFFSET__/g, String(prevOffset)).replace(/__JSONL_LINES__/g, String(jsonlLines)).replace(/__JSONL_SERVER_PATH__/g, jsonlServerPath);
    wlog("running codex exec");
    try {
      execFileSync(cfg.codexBin, [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 12e4,
        env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" }
      });
      wlog("codex exec exited (code 0)");
    } catch (e) {
      wlog(`codex exec failed: ${e.status ?? e.message}`);
    }
    if (existsSync2(tmpSummary)) {
      const text = readFileSync2(tmpSummary, "utf-8");
      if (text.trim()) {
        const fname = `${cfg.sessionId}.md`;
        const vpath = `/summaries/${cfg.userName}/${fname}`;
        const result = await uploadSummary(query, {
          tableName: cfg.memoryTable,
          vpath,
          fname,
          userName: cfg.userName,
          project: cfg.project,
          agent: "codex",
          sessionId: cfg.sessionId,
          text
        });
        wlog(`uploaded ${vpath} (summary=${result.summaryLength}, desc=${result.descLength})`);
        try {
          const graphPrompt = buildKnowledgeGraphPrompt({
            summaryText: text,
            sessionId: cfg.sessionId,
            sourcePath: jsonlServerPath,
            project: cfg.project,
            template: cfg.graphPromptTemplate
          });
          const graphRaw = execFileSync(cfg.codexBin, [
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            graphPrompt
          ], {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 12e4,
            env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" }
          }).toString("utf-8");
          const graph = parseGraphExtraction(graphRaw);
          const graphResult = await replaceSessionGraph({
            query,
            nodesTable: cfg.graphNodesTable,
            edgesTable: cfg.graphEdgesTable,
            sessionId: cfg.sessionId,
            userName: cfg.userName,
            project: cfg.project,
            agent: "codex",
            sourcePath: jsonlServerPath,
            graph
          });
          wlog(`graph updated nodes=${graphResult.nodes} edges=${graphResult.edges}`);
        } catch (e) {
          wlog(`graph update failed: ${e.message}`);
        }
        try {
          const transcriptText = buildMemoryFactTranscript(rows.map((row) => ({
            turnIndex: Number(row["turn_index"] ?? 0),
            eventType: typeof row["event_type"] === "string" ? row["event_type"] : "",
            speaker: typeof row["speaker"] === "string" ? row["speaker"] : "",
            text: typeof row["text"] === "string" ? row["text"] : "",
            turnSummary: typeof row["turn_summary"] === "string" ? row["turn_summary"] : "",
            sourceDateTime: typeof row["source_date_time"] === "string" ? row["source_date_time"] : "",
            creationDate: typeof row["creation_date"] === "string" ? row["creation_date"] : ""
          })));
          const factPrompt = buildMemoryFactPrompt({
            transcriptText,
            sessionId: cfg.sessionId,
            sourcePath: jsonlServerPath,
            project: cfg.project,
            template: cfg.factPromptTemplate
          });
          const factsRaw = execFileSync(cfg.codexBin, [
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            factPrompt
          ], {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 12e4,
            env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" }
          }).toString("utf-8");
          const extraction = parseMemoryFactExtraction(factsRaw);
          const factResult = await replaceSessionFacts({
            query,
            factsTable: cfg.factsTable,
            entitiesTable: cfg.entitiesTable,
            linksTable: cfg.factEntityLinksTable,
            sessionId: cfg.sessionId,
            userName: cfg.userName,
            project: cfg.project,
            agent: "codex",
            sourcePath: jsonlServerPath,
            extraction
          });
          wlog(`facts updated facts=${factResult.facts} entities=${factResult.entities} links=${factResult.links}`);
        } catch (e) {
          wlog(`fact update failed: ${e.message}`);
        }
        try {
          finalizeSummary(cfg.sessionId, jsonlLines);
          wlog(`sidecar updated: lastSummaryCount=${jsonlLines}`);
        } catch (e) {
          wlog(`sidecar update failed: ${e.message}`);
        }
      }
    } else {
      wlog("no summary file generated");
    }
    wlog("done");
  } catch (e) {
    wlog(`fatal: ${e.message}`);
  } finally {
    cleanup();
    try {
      releaseLock(cfg.sessionId);
    } catch {
    }
  }
}
main();
