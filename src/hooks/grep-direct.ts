/**
 * Shared grep handler — single SQL query + in-memory regex refinement.
 * Used by both Claude Code and Codex pre-tool-use hooks.
 */

import type { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr, sqlLike } from "../utils/sql.js";

export interface GrepParams {
  pattern: string;
  targetPath: string;
  ignoreCase: boolean;
  wordMatch: boolean;
  filesOnly: boolean;
  countOnly: boolean;
  lineNumber: boolean;
  invertMatch: boolean;
  fixedString: boolean;
}

/** Parse a bash grep/egrep/fgrep command string into GrepParams. */
export function parseBashGrep(cmd: string): GrepParams | null {
  const first = cmd.trim().split(/\s*\|\s*/)[0];
  if (!/^(grep|egrep|fgrep)\b/.test(first)) return null;

  const isFixed = first.startsWith("fgrep");

  // Tokenize respecting single/double quotes
  const tokens: string[] = [];
  let pos = 0;
  while (pos < first.length) {
    if (first[pos] === " " || first[pos] === "\t") { pos++; continue; }
    if (first[pos] === "'" || first[pos] === '"') {
      const q = first[pos];
      let end = pos + 1;
      while (end < first.length && first[end] !== q) end++;
      tokens.push(first.slice(pos + 1, end));
      pos = end + 1;
    } else {
      let end = pos;
      while (end < first.length && first[end] !== " " && first[end] !== "\t") end++;
      tokens.push(first.slice(pos, end));
      pos = end;
    }
  }

  let ignoreCase = false, wordMatch = false, filesOnly = false, countOnly = false,
      lineNumber = false, invertMatch = false, fixedString = isFixed;

  let ti = 1;
  while (ti < tokens.length && tokens[ti].startsWith("-") && tokens[ti] !== "--") {
    const flag = tokens[ti];
    if (flag.startsWith("--")) {
      const handlers: Record<string, () => void> = {
        "--ignore-case": () => { ignoreCase = true; },
        "--word-regexp": () => { wordMatch = true; },
        "--files-with-matches": () => { filesOnly = true; },
        "--count": () => { countOnly = true; },
        "--line-number": () => { lineNumber = true; },
        "--invert-match": () => { invertMatch = true; },
        "--fixed-strings": () => { fixedString = true; },
      };
      handlers[flag]?.();
      ti++; continue;
    }
    for (const c of flag.slice(1)) {
      switch (c) {
        case "i": ignoreCase = true; break;
        case "w": wordMatch = true; break;
        case "l": filesOnly = true; break;
        case "c": countOnly = true; break;
        case "n": lineNumber = true; break;
        case "v": invertMatch = true; break;
        case "F": fixedString = true; break;
        // r/R/E: no-op (recursive implied, extended default)
      }
    }
    ti++;
  }
  if (ti < tokens.length && tokens[ti] === "--") ti++;
  if (ti >= tokens.length) return null;

  let target = tokens[ti + 1] ?? "/";
  if (target === "." || target === "./") target = "/";

  return {
    pattern: tokens[ti], targetPath: target,
    ignoreCase, wordMatch, filesOnly, countOnly, lineNumber, invertMatch, fixedString,
  };
}

/** Run grep via single SQL query + in-memory regex refinement. */
export async function handleGrepDirect(
  api: DeeplakeApi,
  table: string,
  sessionsTable: string,
  params: GrepParams,
): Promise<string | null> {
  if (!params.pattern) return null;

  const { pattern, targetPath, ignoreCase, wordMatch, filesOnly, countOnly,
          lineNumber, invertMatch, fixedString } = params;

  const likeOp = ignoreCase ? "ILIKE" : "LIKE";
  const escapedLike = sqlLike(pattern);

  // ── path filter ──
  let pathFilter = "";
  if (targetPath && targetPath !== "/") {
    const clean = targetPath.replace(/\/+$/, "");
    pathFilter = ` AND (path = '${sqlStr(clean)}' OR path LIKE '${sqlLike(clean)}/%')`;
  }

  // For regex patterns, can't use BM25 or LIKE — fetch all files under path
  const hasRegexMeta = !fixedString && /[.*+?^${}()|[\]\\]/.test(pattern);

  // Search only the memory/summaries table — sessions contain raw JSONB
  // (prompts, tool calls) which is slow to scan and produces noisy results.
  // Summaries already contain all useful content from sessions.
  //
  // Strategy: BM25 first (ranked, fast with index), LIKE fallback if BM25 fails.
  let rows: Record<string, unknown>[] = [];

  // Search primary table
  if (!hasRegexMeta) {
    const contentFilter = ` AND summary ${likeOp} '%${escapedLike}%'`;
    try {
      rows = await api.query(
        `SELECT path, summary AS content FROM "${table}" WHERE 1=1${pathFilter}${contentFilter} LIMIT 100`,
      );
    } catch { rows = []; }
  } else {
    try {
      rows = await api.query(
        `SELECT path, summary AS content FROM "${table}" WHERE 1=1${pathFilter} LIMIT 100`,
      );
    } catch { rows = []; }
  }

  const output: string[] = [];
  // Cross-table enrichment: search the companion memory/summaries table
  // for structured wiki-style context. Convention: if table is X_sessions
  // or X, companion is X_memory. Summaries are prepended for priority.
  if (!hasRegexMeta) {
    const memoryTable = table.endsWith("_sessions")
      ? table.replace(/_sessions$/, "_memory")
      : (sessionsTable !== table ? sessionsTable : null);
    if (memoryTable && memoryTable !== table) {
      try {
        const contentFilter = ` AND summary ${likeOp} '%${escapedLike}%'`;
        const summaryRows = await api.query(
          `SELECT path, summary AS content FROM "${memoryTable}" WHERE 1=1${contentFilter} LIMIT 20`,
        );
        if (summaryRows.length > 0) {
          // Output full summaries directly (compact and structured)
          for (const sr of summaryRows) {
            const sp = sr["path"] as string;
            const sc = sr["content"] as string;
            if (sc) {
              output.push(`=== ${sp} ===`);
              output.push(sc);
              output.push("");
            }
          }
        }
      } catch { /* best-effort — table may not exist */ }
    }
  }

  // ── regex refinement ──
  let reStr = fixedString
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : pattern;
  if (wordMatch) reStr = `\\b${reStr}\\b`;
  let re: RegExp;
  try { re = new RegExp(reStr, ignoreCase ? "i" : ""); }
  catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : ""); }

  const multi = rows.length > 1;

  for (const row of rows) {
    const p = row["path"] as string;
    const text = row["content"] as string;
    if (!text) continue;

    const lines = text.split("\n");
    const matched: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) !== !!invertMatch) {
        if (filesOnly) { output.push(p); break; }
        const prefix = multi ? `${p}:` : "";
        const ln = lineNumber ? `${i + 1}:` : "";
        matched.push(`${prefix}${ln}${lines[i]}`);
      }
    }

    if (!filesOnly) {
      if (countOnly) {
        output.push(`${multi ? `${p}:` : ""}${matched.length}`);
      } else {
        output.push(...matched);
      }
    }
  }

  return output.join("\n") || "(no matches)";
}
