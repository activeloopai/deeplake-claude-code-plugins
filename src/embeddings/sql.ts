// Helpers for embedding values in SQL. Deeplake stores vectors as `FLOAT4[]`;
// the literal form is `ARRAY[f1, f2, ...]::float4[]`. When the embedding is
// missing (daemon unavailable, timeout, etc.) we emit `NULL`.

export function embeddingSqlLiteral(vec: number[] | null | undefined): string {
  if (!vec || vec.length === 0) return "NULL";
  // FLOAT4 is IEEE-754 single-precision. `toFixed` would lose precision; use
  // the raw JS Number → string conversion which yields the shortest round-trip.
  // Safety: only allow finite numbers; otherwise NULL.
  const parts: string[] = [];
  for (const v of vec) {
    if (!Number.isFinite(v)) return "NULL";
    parts.push(String(v));
  }
  return `ARRAY[${parts.join(",")}]::float4[]`;
}
