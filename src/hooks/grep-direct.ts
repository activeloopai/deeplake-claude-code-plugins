/**
 * Fast-path grep handler invoked from the pre-tool-use hook. Parses a Bash
 * grep/egrep/fgrep command (or accepts pre-parsed Grep-tool params) and
 * delegates the actual search to the shared core in ../shell/grep-core.ts,
 * which handles dual-table SQL + session-JSON normalization + regex refinement.
 */

import type { DeeplakeApi } from "../deeplake-api.js";
import { grepBothTables, type GrepMatchParams } from "../shell/grep-core.js";

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

/** Run grep via the shared dual-table core. Returns formatted grep output. */
export async function handleGrepDirect(
  api: DeeplakeApi,
  table: string,
  sessionsTable: string,
  params: GrepParams,
): Promise<string | null> {
  if (!params.pattern) return null;

  const matchParams: GrepMatchParams = {
    pattern: params.pattern,
    ignoreCase: params.ignoreCase,
    wordMatch: params.wordMatch,
    filesOnly: params.filesOnly,
    countOnly: params.countOnly,
    lineNumber: params.lineNumber,
    invertMatch: params.invertMatch,
    fixedString: params.fixedString,
  };

  const output = await grepBothTables(api, table, sessionsTable, matchParams, params.targetPath);
  return output.join("\n") || "(no matches)";
}
