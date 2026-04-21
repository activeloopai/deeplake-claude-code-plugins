export interface ScoredRetrievalRow {
  path: string;
  content: string;
  sourceOrder: number;
  creationDate: string;
  score: number;
}

export interface FusedRetrievalRow {
  path: string;
  content: string;
  sourceOrder: number;
  creationDate: string;
  textScore: number;
  vectorScore: number;
  fusedScore: number;
}

function coerceFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeWeights(vectorWeight: number, textWeight: number): { vectorWeight: number; textWeight: number } {
  const safeVector = Math.max(0, coerceFinite(vectorWeight));
  const safeText = Math.max(0, coerceFinite(textWeight));
  const total = safeVector + safeText;
  if (total <= 0) return { vectorWeight: 0.5, textWeight: 0.5 };
  return {
    vectorWeight: safeVector / total,
    textWeight: safeText / total,
  };
}

export function softmaxNormalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const safeScores = scores.map(coerceFinite);
  const maxScore = Math.max(...safeScores);
  const exps = safeScores.map((score) => Math.exp(score - maxScore));
  const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
  return exps.map((value) => value / sum);
}

function pickPreferredRow(existing: ScoredRetrievalRow | undefined, candidate: ScoredRetrievalRow): ScoredRetrievalRow {
  if (!existing) return candidate;
  if (candidate.score > existing.score) return candidate;
  if (candidate.score < existing.score) return existing;
  if (candidate.sourceOrder < existing.sourceOrder) return candidate;
  if (candidate.sourceOrder > existing.sourceOrder) return existing;
  if (candidate.creationDate < existing.creationDate) return candidate;
  if (candidate.creationDate > existing.creationDate) return existing;
  return candidate.path < existing.path ? candidate : existing;
}

function dedupeBestRows(rows: ScoredRetrievalRow[]): ScoredRetrievalRow[] {
  const bestByPath = new Map<string, ScoredRetrievalRow>();
  for (const row of rows) {
    if (!row.path) continue;
    bestByPath.set(row.path, pickPreferredRow(bestByPath.get(row.path), row));
  }
  return [...bestByPath.values()];
}

export function fuseRetrievalRows(args: {
  textRows: ScoredRetrievalRow[];
  vectorRows: ScoredRetrievalRow[];
  textWeight: number;
  vectorWeight: number;
  limit: number;
}): FusedRetrievalRow[] {
  const {
    textRows,
    vectorRows,
    limit,
  } = args;
  const { textWeight, vectorWeight } = normalizeWeights(args.vectorWeight, args.textWeight);
  const dedupedTextRows = dedupeBestRows(textRows);
  const dedupedVectorRows = dedupeBestRows(vectorRows);
  const textNorm = softmaxNormalizeScores(dedupedTextRows.map((row) => row.score));
  const vectorNorm = softmaxNormalizeScores(dedupedVectorRows.map((row) => row.score));
  const fusedByPath = new Map<string, FusedRetrievalRow>();

  for (let i = 0; i < dedupedTextRows.length; i++) {
    const row = dedupedTextRows[i];
    fusedByPath.set(row.path, {
      path: row.path,
      content: row.content,
      sourceOrder: row.sourceOrder,
      creationDate: row.creationDate,
      textScore: textNorm[i] ?? 0,
      vectorScore: 0,
      fusedScore: textWeight * (textNorm[i] ?? 0),
    });
  }

  for (let i = 0; i < dedupedVectorRows.length; i++) {
    const row = dedupedVectorRows[i];
    const existing = fusedByPath.get(row.path);
    const vectorScore = vectorNorm[i] ?? 0;
    if (existing) {
      if (existing.content.length === 0 && row.content.length > 0) existing.content = row.content;
      existing.sourceOrder = Math.min(existing.sourceOrder, row.sourceOrder);
      if (!existing.creationDate || row.creationDate < existing.creationDate) existing.creationDate = row.creationDate;
      existing.vectorScore = vectorScore;
      existing.fusedScore = (textWeight * existing.textScore) + (vectorWeight * existing.vectorScore);
      continue;
    }
    fusedByPath.set(row.path, {
      path: row.path,
      content: row.content,
      sourceOrder: row.sourceOrder,
      creationDate: row.creationDate,
      textScore: 0,
      vectorScore,
      fusedScore: vectorWeight * vectorScore,
    });
  }

  return [...fusedByPath.values()]
    .sort((a, b) =>
      (b.fusedScore - a.fusedScore)
      || (b.vectorScore - a.vectorScore)
      || (b.textScore - a.textScore)
      || (a.sourceOrder - b.sourceOrder)
      || a.creationDate.localeCompare(b.creationDate)
      || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit));
}
