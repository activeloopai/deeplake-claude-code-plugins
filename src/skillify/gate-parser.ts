/**
 * Parse the gate's JSON verdict from arbitrary text — the model can output
 * the JSON directly, fenced in a ```json block, or wrapped in prose. We
 * extract the outermost `{...}` and JSON.parse it.
 *
 * Extracted to its own module so it's unit-testable without spawning the
 * worker (the worker entry-point parses cfg at top level which makes
 * importing it from a test painful).
 */

export interface Verdict {
  verdict: "KEEP" | "SKIP" | "MERGE";
  name?: string;
  description?: string;
  trigger?: string;
  body?: string;
  reason?: string;
}

/** Return the outermost balanced JSON-object substring, or null. */
export function extractJsonBlock(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

export function parseVerdict(raw: string): Verdict | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  try {
    const v = JSON.parse(block) as Verdict;
    if (v.verdict !== "KEEP" && v.verdict !== "SKIP" && v.verdict !== "MERGE") return null;
    return v;
  } catch {
    return null;
  }
}
