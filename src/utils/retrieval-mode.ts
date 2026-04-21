export function isSessionsOnlyMode(): boolean {
  const raw = process.env["HIVEMIND_SESSIONS_ONLY"] ?? process.env["DEEPLAKE_SESSIONS_ONLY"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export type GrepRetrievalMode = "classic" | "embedding" | "hybrid";

export function getGrepRetrievalMode(): GrepRetrievalMode {
  const raw = (process.env["HIVEMIND_GREP_RETRIEVAL_MODE"] ?? process.env["DEEPLAKE_GREP_RETRIEVAL_MODE"] ?? "").trim().toLowerCase();
  if (raw === "embedding" || raw === "hybrid") return raw;
  return "classic";
}

export function isIndexDisabled(): boolean {
  const raw = process.env["HIVEMIND_DISABLE_INDEX"] ?? process.env["DEEPLAKE_DISABLE_INDEX"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function isSummaryBm25Disabled(): boolean {
  const raw = process.env["HIVEMIND_DISABLE_SUMMARY_BM25"] ?? process.env["DEEPLAKE_DISABLE_SUMMARY_BM25"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function isPsqlMode(): boolean {
  const raw = process.env["HIVEMIND_PSQL_MODE"] ?? process.env["DEEPLAKE_PSQL_MODE"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function isFactsSessionsOnlyPsqlMode(): boolean {
  const raw = process.env["HIVEMIND_PSQL_FACTS_SESSIONS_ONLY"] ?? process.env["DEEPLAKE_PSQL_FACTS_SESSIONS_ONLY"] ?? "";
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
