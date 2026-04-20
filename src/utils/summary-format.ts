function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function extractSection(text: string, heading: string): string | null {
  const re = new RegExp(`^## ${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

export function extractHeaderField(text: string, field: string): string | null {
  const re = new RegExp(`^- \\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+)$`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitMetadataList(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(
    value
      .split(/\s*(?:,|;|&|\band\b)\s*/i)
      .map((part) => compactText(part))
      .filter((part) => part.length >= 2 && !/^unknown$/i.test(part)),
  )];
}

function extractBullets(section: string | null, limit = 3): string[] {
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => compactText(line.slice(2)))
    .filter(Boolean)
    .slice(0, limit);
}

export function extractSummaryDate(text: string): string | null {
  return extractHeaderField(text, "Date")
    ?? extractHeaderField(text, "Started");
}

export function extractSummaryParticipants(text: string): string | null {
  return extractHeaderField(text, "Participants")
    ?? extractHeaderField(text, "Speakers");
}

export function extractSummaryTopics(text: string): string | null {
  return extractHeaderField(text, "Topics");
}

export function extractSummarySource(text: string): string | null {
  return extractHeaderField(text, "Source");
}

export function buildSummaryBlurb(text: string): string {
  const participants = extractSummaryParticipants(text);
  const topics = extractSummaryTopics(text);
  const factBullets = extractBullets(extractSection(text, "Searchable Facts"), 3);
  const keyBullets = factBullets.length > 0 ? factBullets : extractBullets(extractSection(text, "Key Facts"), 3);
  const whatHappened = compactText(extractSection(text, "What Happened") ?? "");

  const parts: string[] = [];
  if (participants) parts.push(participants);
  if (topics) parts.push(topics);
  if (keyBullets.length > 0) parts.push(keyBullets.join("; "));
  if (parts.length === 0 && whatHappened) parts.push(whatHappened);

  const blurb = parts.join(" | ").slice(0, 300).trim();
  return blurb || "completed";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function formatIndexTimestamp(value: string): string {
  if (!value) return "";
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const ts = new Date(parsed);
  const yyyy = ts.getUTCFullYear();
  const mm = String(ts.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ts.getUTCDate()).padStart(2, "0");
  const hh = String(ts.getUTCHours()).padStart(2, "0");
  const min = String(ts.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

export interface SummaryIndexRow {
  path?: unknown;
  project?: unknown;
  description?: unknown;
  summary?: unknown;
  creation_date?: unknown;
  last_update_date?: unknown;
}

export interface SummaryIndexEntry {
  path: string;
  label: string;
  project: string;
  description: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  sortDate: string;
  participantsText: string;
  participants: string[];
  topicsText: string;
  topics: string[];
  source: string;
  blurb: string;
}

export function buildSummaryIndexEntry(row: SummaryIndexRow): SummaryIndexEntry | null {
  const path = typeof row.path === "string" ? row.path : "";
  if (!path) return null;
  if (path.startsWith("/summaries/") && !/^\/summaries\/[^/]+\/[^/]+$/.test(path)) return null;

  const summary = typeof row.summary === "string" ? row.summary : "";
  const project = typeof row.project === "string" ? row.project.trim() : "";
  const description = typeof row.description === "string" ? compactText(row.description) : "";
  const creationDate = typeof row.creation_date === "string" ? row.creation_date : "";
  const lastUpdateDate = typeof row.last_update_date === "string" ? row.last_update_date : "";

  const label = basename(path) || path;
  const date = summary ? extractSummaryDate(summary) ?? creationDate : creationDate;
  const participantsText = summary ? extractSummaryParticipants(summary) ?? "" : "";
  const topicsText = summary ? extractSummaryTopics(summary) ?? "" : "";
  const source = summary ? extractSummarySource(summary) ?? "" : "";
  const structuredBlurb = summary ? buildSummaryBlurb(summary) : "";
  const blurb = structuredBlurb && structuredBlurb !== "completed"
    ? structuredBlurb
    : truncate(description, 220);

  return {
    path,
    label,
    project,
    description,
    date,
    createdAt: creationDate,
    updatedAt: lastUpdateDate,
    sortDate: lastUpdateDate || creationDate || date,
    participantsText,
    participants: splitMetadataList(participantsText),
    topicsText,
    topics: splitMetadataList(topicsText),
    source,
    blurb,
  };
}

export function formatSummaryIndexEntry(entry: SummaryIndexEntry): string {
  const parts = [`- [summary: ${entry.label}](${entry.path})`];
  if (entry.source) parts.push(`[session](${entry.source})`);
  if (entry.date) parts.push(truncate(entry.date, 40));
  const visibleTime = entry.updatedAt || entry.createdAt;
  if (visibleTime) parts.push(`updated: ${truncate(formatIndexTimestamp(visibleTime), 24)}`);
  if (entry.participantsText) parts.push(truncate(entry.participantsText, 80));
  if (entry.topicsText) parts.push(`topics: ${truncate(entry.topicsText, 90)}`);
  if (entry.project) parts.push(`[${truncate(entry.project, 40)}]`);
  if (entry.blurb && entry.blurb !== "completed") parts.push(truncate(entry.blurb, 220));
  return parts.join(" — ");
}

export function buildSummaryIndexLine(row: SummaryIndexRow | SummaryIndexEntry): string | null {
  const entry = "label" in row && typeof row.label === "string"
    ? row
    : buildSummaryIndexEntry(row);
  return entry ? formatSummaryIndexEntry(entry) : null;
}
