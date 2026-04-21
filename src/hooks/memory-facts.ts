import { randomUUID } from "node:crypto";
import { buildSummaryBlurb } from "../utils/summary-format.js";
import { buildGraphNodeId } from "./knowledge-graph.js";
import { esc, type QueryFn } from "./upload-summary.js";

export interface MemoryFactSpec {
  subject: string;
  subjectType?: string;
  subjectAliases?: string[];
  predicate: string;
  object: string;
  objectType?: string;
  objectAliases?: string[];
  summary?: string;
  evidence?: string;
  confidence?: number;
  validAt?: string;
  validFrom?: string;
  validTo?: string;
}

export interface MemoryFactExtraction {
  facts: MemoryFactSpec[];
}

export interface ReplaceSessionFactsParams {
  query: QueryFn;
  factsTable: string;
  entitiesTable: string;
  linksTable: string;
  sessionId: string;
  userName: string;
  project: string;
  agent: string;
  sourcePath: string;
  extraction: MemoryFactExtraction;
  ts?: string;
}

export interface ReplaceSessionFactsResult {
  facts: number;
  entities: number;
  links: number;
}

export interface SessionFactTranscriptRow {
  turnIndex: number;
  eventType?: string;
  speaker?: string;
  text?: string;
  turnSummary?: string;
  sourceDateTime?: string;
  creationDate?: string;
}

export const MEMORY_FACT_PROMPT_TEMPLATE = `You are extracting durable long-term memory facts from raw session transcript rows.

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

interface EntityAggregate {
  entityId: string;
  canonicalName: string;
  entityType: string;
  aliases: Set<string>;
  summaries: Set<string>;
  searchTerms: Set<string>;
}

interface FactRowSpec {
  factId: string;
  subjectEntityId: string;
  subjectName: string;
  subjectType: string;
  objectEntityId: string;
  objectName: string;
  objectType: string;
  predicate: string;
  summary: string;
  evidence: string;
  searchText: string;
  confidence: string;
  validAt: string;
  validFrom: string;
  validTo: string;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeString)
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

function normalizeFactType(value: unknown): string {
  return normalizeString(value) || "other";
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return undefined;
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

function buildFactId(sessionId: string, fact: MemoryFactSpec, index: number): string {
  return [
    "fact",
    slugify(sessionId),
    String(index + 1),
    slugify(fact.subject),
    slugify(fact.predicate),
    slugify(fact.object),
  ].join(":");
}

function buildFactSearchText(fact: MemoryFactSpec): string {
  return [
    fact.subject,
    ...(fact.subjectAliases ?? []),
    fact.predicate,
    fact.object,
    ...(fact.objectAliases ?? []),
    fact.summary ?? "",
    fact.evidence ?? "",
    fact.validAt ?? "",
    fact.validFrom ?? "",
    fact.validTo ?? "",
  ].filter(Boolean).join(" | ");
}

function buildEntitySearchText(entity: EntityAggregate): string {
  return [
    entity.canonicalName,
    entity.entityType,
    ...entity.aliases,
    ...entity.searchTerms,
    ...entity.summaries,
  ].filter(Boolean).join(" | ");
}

function mergeDelimited(existing: string, nextValues: Iterable<string>): string {
  const merged = new Set(
    existing.split(",").map((value) => value.trim()).filter(Boolean),
  );
  for (const value of nextValues) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    merged.add(trimmed);
  }
  return [...merged].join(", ");
}

function mergePipeDelimited(existing: string, nextValues: Iterable<string>, maxItems = 8): string {
  const merged = new Set(
    existing.split("|").map((value) => value.trim()).filter(Boolean),
  );
  for (const value of nextValues) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (merged.has(trimmed)) continue;
    if (merged.size >= maxItems) break;
    merged.add(trimmed);
  }
  return [...merged].join(" | ");
}

function wrapFactsPhaseError(error: unknown, args: {
  phase: "delete_facts" | "delete_links" | "upsert_entities" | "insert_facts" | "insert_links";
  sessionId: string;
  table: string;
  sql: string;
}): Error {
  const wrapped = new Error(
    `facts ${args.phase} failed for session ${args.sessionId} on table ${args.table}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  (wrapped as Error & Record<string, unknown>).cause = error;
  (wrapped as Error & Record<string, unknown>).phase = args.phase;
  (wrapped as Error & Record<string, unknown>).sessionId = args.sessionId;
  (wrapped as Error & Record<string, unknown>).table = args.table;
  (wrapped as Error & Record<string, unknown>).sql = args.sql;
  return wrapped;
}

function buildEntityAggregate(
  entityMap: Map<string, EntityAggregate>,
  args: { name: string; type: string; aliases: string[]; summary: string; searchText: string },
): EntityAggregate {
  const entityId = buildGraphNodeId(args.name, args.type);
  const existing = entityMap.get(entityId);
  if (existing) {
    for (const alias of args.aliases) existing.aliases.add(alias);
    if (args.summary) existing.summaries.add(args.summary);
    if (args.searchText) existing.searchTerms.add(args.searchText);
    return existing;
  }
  const created: EntityAggregate = {
    entityId,
    canonicalName: args.name,
    entityType: args.type || "other",
    aliases: new Set(args.aliases),
    summaries: new Set(args.summary ? [args.summary] : []),
    searchTerms: new Set(args.searchText ? [args.searchText] : []),
  };
  entityMap.set(entityId, created);
  return created;
}

async function upsertEntities(params: {
  query: QueryFn;
  entitiesTable: string;
  entityMap: Map<string, EntityAggregate>;
  userName: string;
  project: string;
  agent: string;
  sourcePath: string;
  sessionId: string;
  ts: string;
}): Promise<number> {
  let upserts = 0;
  const path = `/facts/entities/${params.userName}.jsonl`;
  const filename = `${params.userName}.jsonl`;

  for (const entity of params.entityMap.values()) {
    const aliases = [...entity.aliases].filter((alias) => alias !== entity.canonicalName);
    const entitySummary = [...entity.summaries].join(" | ") || entity.canonicalName;
    const searchText = buildEntitySearchText(entity);
    const existingRows = await params.query(
      `SELECT id, aliases, summary, search_text, source_session_ids, source_paths, entity_type FROM "${params.entitiesTable}" ` +
      `WHERE entity_id = '${esc(entity.entityId)}' LIMIT 1`,
    );
    if (existingRows.length === 0) {
      const insertSql =
        `INSERT INTO "${params.entitiesTable}" ` +
        `(id, path, filename, entity_id, canonical_name, entity_type, aliases, summary, search_text, source_session_ids, source_paths, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ` +
        `('${randomUUID()}', '${esc(path)}', '${esc(filename)}', '${esc(entity.entityId)}', '${esc(entity.canonicalName)}', '${esc(entity.entityType)}', ` +
        `'${esc(aliases.join(", "))}', E'${esc(entitySummary)}', E'${esc(searchText)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', ` +
        `'${esc(params.userName)}', 'application/json', ${Buffer.byteLength(searchText, "utf-8")}, '${esc(params.project)}', ` +
        `E'${esc(buildSummaryBlurb(entitySummary))}', '${esc(params.agent)}', '${params.ts}', '${params.ts}')`;
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
    const existingType = normalizeString(existing["entity_type"]);
    const entityType = existingType && existingType !== "other" ? existingType : entity.entityType;
    const updateSql =
      `UPDATE "${params.entitiesTable}" SET ` +
      `canonical_name = '${esc(entity.canonicalName)}', entity_type = '${esc(entityType)}', aliases = '${esc(mergedAliases)}', ` +
      `summary = E'${esc(mergedSummary)}', search_text = E'${esc(mergedSearchText)}', ` +
      `source_session_ids = '${esc(mergedSessionIds)}', source_paths = '${esc(mergedSourcePaths)}', ` +
      `size_bytes = ${Buffer.byteLength(mergedSearchText, "utf-8")}, project = '${esc(params.project)}', ` +
      `description = E'${esc(buildSummaryBlurb(mergedSummary))}', agent = '${esc(params.agent)}', last_update_date = '${params.ts}' ` +
      `WHERE entity_id = '${esc(entity.entityId)}'`;
    await params.query(updateSql);
    upserts += 1;
  }
  return upserts;
}

export function parseMemoryFactExtraction(raw: string): MemoryFactExtraction {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const facts = Array.isArray(parsed["facts"]) ? parsed["facts"] as Array<Record<string, unknown>> : [];
  const dedupe = new Set<string>();
  return {
    facts: facts
      .map((fact) => ({
        subject: normalizeString(fact["subject"]),
        subjectType: normalizeFactType(fact["subject_type"]),
        subjectAliases: normalizeAliases(fact["subject_aliases"]),
        predicate: normalizeString(fact["predicate"]).replace(/\s+/g, "_").toLowerCase(),
        object: normalizeString(fact["object"]),
        objectType: normalizeFactType(fact["object_type"]),
        objectAliases: normalizeAliases(fact["object_aliases"]),
        summary: normalizeString(fact["summary"]),
        evidence: normalizeString(fact["evidence"]),
        confidence: normalizeConfidence(fact["confidence"]),
        validAt: normalizeString(fact["valid_at"]),
        validFrom: normalizeString(fact["valid_from"]),
        validTo: normalizeString(fact["valid_to"]),
      }))
      .filter((fact) => fact.subject && fact.predicate && fact.object)
      .filter((fact) => {
        const key = `${fact.subject}::${fact.predicate}::${fact.object}`;
        if (dedupe.has(key)) return false;
        dedupe.add(key);
        return true;
      }),
  };
}

export function buildMemoryFactTranscript(rows: SessionFactTranscriptRow[]): string {
  const normalized = rows
    .map((row) => ({
      turnIndex: Number.isFinite(row.turnIndex) ? row.turnIndex : 0,
      speaker: normalizeString(row.speaker),
      text: normalizeString(row.text),
      eventType: normalizeString(row.eventType) || "message",
      turnSummary: normalizeString(row.turnSummary),
      sourceDateTime: normalizeString(row.sourceDateTime) || normalizeString(row.creationDate),
    }))
    .filter((row) => row.text || row.turnSummary);

  if (normalized.length === 0) return "(no transcript rows)";

  return normalized.map((row) => {
    const prefix = [
      `turn=${row.turnIndex}`,
      row.sourceDateTime ? `time=${row.sourceDateTime}` : "",
      row.speaker ? `speaker=${row.speaker}` : `event=${row.eventType}`,
    ].filter(Boolean).join(" | ");
    const lines = [`[${prefix}] ${row.text || row.turnSummary}`];
    if (row.turnSummary && row.turnSummary !== row.text) {
      lines.push(`summary: ${row.turnSummary}`);
    }
    return lines.join("\n");
  }).join("\n");
}

export function buildMemoryFactPrompt(args: {
  transcriptText: string;
  sessionId: string;
  sourcePath: string;
  project: string;
  template?: string;
}): string {
  return (args.template ?? MEMORY_FACT_PROMPT_TEMPLATE)
    .replace(/__TRANSCRIPT_TEXT__/g, args.transcriptText)
    .replace(/__SESSION_ID__/g, args.sessionId)
    .replace(/__SOURCE_PATH__/g, args.sourcePath)
    .replace(/__PROJECT__/g, args.project);
}

export async function replaceSessionFacts(params: ReplaceSessionFactsParams): Promise<ReplaceSessionFactsResult> {
  const ts = params.ts ?? new Date().toISOString();
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
      sql: deleteFactsSql,
    });
  }
  try {
    await params.query(deleteLinksSql);
  } catch (error) {
    throw wrapFactsPhaseError(error, {
      phase: "delete_links",
      sessionId: params.sessionId,
      table: params.linksTable,
      sql: deleteLinksSql,
    });
  }

  const entityMap = new Map<string, EntityAggregate>();
  const factRows: FactRowSpec[] = params.extraction.facts.map((fact, index) => {
    const summary = fact.summary || `${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`;
    const searchText = buildFactSearchText(fact);
    const subjectEntity = buildEntityAggregate(entityMap, {
      name: fact.subject,
      type: fact.subjectType || "other",
      aliases: fact.subjectAliases ?? [],
      summary,
      searchText,
    });
    const objectEntity = buildEntityAggregate(entityMap, {
      name: fact.object,
      type: fact.objectType || "other",
      aliases: fact.objectAliases ?? [],
      summary,
      searchText,
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
      validTo: fact.validTo || "",
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
      ts,
    });
  } catch (error) {
    throw wrapFactsPhaseError(error, {
      phase: "upsert_entities",
      sessionId: params.sessionId,
      table: params.entitiesTable,
      sql: `UPSERT entities for ${params.sessionId}`,
    });
  }

  if (factRows.length > 0) {
    const values = factRows.map((row) =>
      `('${randomUUID()}', '${esc(factPath)}', '${esc(factFilename)}', '${esc(row.factId)}', ` +
      `'${esc(row.subjectEntityId)}', '${esc(row.subjectName)}', '${esc(row.subjectType)}', '${esc(row.predicate)}', ` +
      `'${esc(row.objectEntityId)}', '${esc(row.objectName)}', '${esc(row.objectType)}', E'${esc(row.summary)}', ` +
      `E'${esc(row.evidence)}', E'${esc(row.searchText)}', '${esc(row.confidence)}', '${esc(row.validAt)}', ` +
      `'${esc(row.validFrom)}', '${esc(row.validTo)}', '${esc(params.sessionId)}', '${esc(params.sourcePath)}', ` +
      `'${esc(params.userName)}', 'application/json', ${Buffer.byteLength(row.searchText, "utf-8")}, '${esc(params.project)}', ` +
      `E'${esc(buildSummaryBlurb(row.summary))}', '${esc(params.agent)}', '${ts}', '${ts}')`,
    );
    const insertFactsSql =
      `INSERT INTO "${params.factsTable}" ` +
      `(id, path, filename, fact_id, subject_entity_id, subject_name, subject_type, predicate, object_entity_id, object_name, object_type, summary, evidence, search_text, confidence, valid_at, valid_from, valid_to, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
      `VALUES ${values.join(", ")}`;
    try {
      await params.query(insertFactsSql);
    } catch (error) {
      throw wrapFactsPhaseError(error, {
        phase: "insert_facts",
        sessionId: params.sessionId,
        table: params.factsTable,
        sql: insertFactsSql,
      });
    }
  }

  const linkRows = factRows.flatMap((row) => ([
    {
      linkId: `${row.factId}:subject:${row.subjectEntityId}`,
      factId: row.factId,
      entityId: row.subjectEntityId,
      entityRole: "subject",
    },
    {
      linkId: `${row.factId}:object:${row.objectEntityId}`,
      factId: row.factId,
      entityId: row.objectEntityId,
      entityRole: "object",
    },
  ]));

  if (linkRows.length > 0) {
    const values = linkRows.map((row) =>
      `('${randomUUID()}', '${esc(linkPath)}', '${esc(linkFilename)}', '${esc(row.linkId)}', ` +
      `'${esc(row.factId)}', '${esc(row.entityId)}', '${esc(row.entityRole)}', ` +
      `'${esc(params.sessionId)}', '${esc(params.sourcePath)}', '${esc(params.userName)}', 'application/json', ${Buffer.byteLength(row.linkId, "utf-8")}, ` +
      `'${esc(params.project)}', 'fact entity link', '${esc(params.agent)}', '${ts}', '${ts}')`,
    );
    const insertLinksSql =
      `INSERT INTO "${params.linksTable}" ` +
      `(id, path, filename, link_id, fact_id, entity_id, entity_role, source_session_id, source_path, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
      `VALUES ${values.join(", ")}`;
    try {
      await params.query(insertLinksSql);
    } catch (error) {
      throw wrapFactsPhaseError(error, {
        phase: "insert_links",
        sessionId: params.sessionId,
        table: params.linksTable,
        sql: insertLinksSql,
      });
    }
  }

  return {
    facts: factRows.length,
    entities: entityMap.size,
    links: linkRows.length,
  };
}
