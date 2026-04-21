import { createHash } from "node:crypto";
import { normalizeContent } from "../shell/grep-core.js";

export interface MemoryEmbeddingRow {
  path?: string;
  filename?: string;
  summary?: string;
  description?: string;
  project?: string;
}

export interface SessionEmbeddingRow {
  path?: string;
  event_type?: string;
  speaker?: string;
  text?: string;
  turn_summary?: string;
  source_date_time?: string;
  turn_index?: number;
  message?: unknown;
}

function compact(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function joinSections(sections: Array<[label: string, value: string]>): string {
  return sections
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n[truncated ${normalized.length - maxChars} chars]`;
}

function tryParseObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractTranscriptText(message: unknown): string {
  const payload = tryParseObject(message);
  if (!payload) return "";
  const turns = Array.isArray(payload["turns"])
    ? payload["turns"] as Array<Record<string, unknown>>
    : Array.isArray(payload["dialogue"])
      ? payload["dialogue"] as Array<Record<string, unknown>>
      : null;
  if (!turns || turns.length === 0) return "";

  const intro = joinSections([
    ["Session path", compact(typeof payload["source_path"] === "string" ? payload["source_path"] : "")],
    ["Conversation", compact(typeof payload["conversation_id"] === "string" ? payload["conversation_id"] : "")],
    ["Date", compact(typeof payload["date_time"] === "string" ? payload["date_time"] : typeof payload["date"] === "string" ? payload["date"] : "")],
  ]);
  const transcript = turns
    .map((turn) => {
      const speaker = compact(
        typeof turn["speaker"] === "string"
          ? turn["speaker"]
          : typeof turn["role"] === "string"
            ? turn["role"]
            : typeof turn["author"] === "string"
              ? turn["author"]
              : "",
      ) || "speaker";
      const text = compact(
        typeof turn["text"] === "string"
          ? turn["text"]
          : typeof turn["content"] === "string"
            ? turn["content"]
            : typeof turn["utterance"] === "string"
              ? turn["utterance"]
              : "",
      );
      return text ? `[${speaker}] ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");

  return [intro, transcript].filter(Boolean).join("\n");
}

function fallbackSessionText(row: SessionEmbeddingRow): string {
  const transcriptText = extractTranscriptText(row.message);
  if (transcriptText) return transcriptText;

  if (typeof row.message === "string") {
    return normalizeContent(row.path ?? "/sessions/unknown.jsonl", row.message);
  }
  if (row.message && typeof row.message === "object") {
    return normalizeContent(row.path ?? "/sessions/unknown.jsonl", JSON.stringify(row.message));
  }
  return "";
}

export function buildMemoryEmbeddingText(row: MemoryEmbeddingRow, maxChars = 8_000): string {
  return truncateText(joinSections([
    ["Path", compact(row.path)],
    ["Filename", compact(row.filename)],
    ["Project", compact(row.project)],
    ["Description", compact(row.description)],
    ["Summary", compact(row.summary)],
  ]), maxChars);
}

export function buildSessionEmbeddingText(row: SessionEmbeddingRow, maxChars = 8_000): string {
  const text = compact(row.text);
  const turnSummary = compact(row.turn_summary);
  const fallback = (!text && !turnSummary) ? compact(fallbackSessionText(row)) : "";
  return truncateText(joinSections([
    ["Path", compact(row.path)],
    ["Event", compact(row.event_type)],
    ["Speaker", compact(row.speaker)],
    ["Source time", compact(row.source_date_time)],
    ["Turn index", Number.isFinite(row.turn_index) ? String(row.turn_index) : ""],
    ["Text", text],
    ["Turn summary", turnSummary],
    ["Content", fallback],
  ]), maxChars);
}

export function stableEmbeddingSourceHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
