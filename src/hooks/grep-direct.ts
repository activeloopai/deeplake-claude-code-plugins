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

function splitFirstPipelineStage(cmd: string): string | null {
  const input = cmd.trim();
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === "\"") {
        escaped = true;
      }
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "|") return input.slice(0, i).trim();
  }

  return quote ? null : input;
}

function tokenizeGrepStage(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === "\"" && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

/** Parse a bash grep/egrep/fgrep command string into GrepParams. */
export function parseBashGrep(cmd: string): GrepParams | null {
  const first = splitFirstPipelineStage(cmd);
  if (!first) return null;
  if (!/^(grep|egrep|fgrep)\b/.test(first)) return null;

  const isFixed = first.startsWith("fgrep");

  const tokens = tokenizeGrepStage(first);
  if (!tokens || tokens.length === 0) return null;

  let ignoreCase = false, wordMatch = false, filesOnly = false, countOnly = false,
      lineNumber = false, invertMatch = false, fixedString = isFixed;
  const explicitPatterns: string[] = [];

  let ti = 1;
  while (ti < tokens.length) {
    const token = tokens[ti];
    if (token === "--") {
      ti++;
      break;
    }
    if (!token.startsWith("-") || token === "-") break;

    if (token.startsWith("--")) {
      const [flag, inlineValue] = token.split("=", 2);
      const handlers: Record<string, () => boolean> = {
        "--ignore-case": () => { ignoreCase = true; return false; },
        "--word-regexp": () => { wordMatch = true; return false; },
        "--files-with-matches": () => { filesOnly = true; return false; },
        "--count": () => { countOnly = true; return false; },
        "--line-number": () => { lineNumber = true; return false; },
        "--invert-match": () => { invertMatch = true; return false; },
        "--fixed-strings": () => { fixedString = true; return false; },
        "--after-context": () => inlineValue === undefined,
        "--before-context": () => inlineValue === undefined,
        "--context": () => inlineValue === undefined,
        "--max-count": () => inlineValue === undefined,
        "--regexp": () => {
          if (inlineValue !== undefined) {
            explicitPatterns.push(inlineValue);
            return false;
          }
          return true;
        },
      };
      const consumeNext = handlers[flag]?.() ?? false;
      if (consumeNext) {
        ti++;
        if (ti >= tokens.length) return null;
        if (flag === "--regexp") explicitPatterns.push(tokens[ti]);
      }
      ti++;
      continue;
    }

    const shortFlags = token.slice(1);
    for (let i = 0; i < shortFlags.length; i++) {
      const flag = shortFlags[i];
      switch (flag) {
        case "i": ignoreCase = true; break;
        case "w": wordMatch = true; break;
        case "l": filesOnly = true; break;
        case "c": countOnly = true; break;
        case "n": lineNumber = true; break;
        case "v": invertMatch = true; break;
        case "F": fixedString = true; break;
        case "r":
        case "R":
        case "E":
          break;
        case "A":
        case "B":
        case "C":
        case "m":
          if (i === shortFlags.length - 1) {
            ti++;
            if (ti >= tokens.length) return null;
          }
          i = shortFlags.length;
          break;
        case "e": {
          const inlineValue = shortFlags.slice(i + 1);
          if (inlineValue) {
            explicitPatterns.push(inlineValue);
          } else {
            ti++;
            if (ti >= tokens.length) return null;
            explicitPatterns.push(tokens[ti]);
          }
          i = shortFlags.length;
          break;
        }
        default:
          break;
      }
    }
    ti++;
  }

  const pattern = explicitPatterns.length > 0 ? explicitPatterns[0] : tokens[ti];
  if (!pattern) return null;

  let target = explicitPatterns.length > 0 ? (tokens[ti] ?? "/") : (tokens[ti + 1] ?? "/");
  if (target === "." || target === "./") target = "/";

  return {
    pattern, targetPath: target,
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
