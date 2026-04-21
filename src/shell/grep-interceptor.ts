import type { DeeplakeApi } from "../deeplake-api.js";
import { defineCommand } from "just-bash";
import yargsParser from "yargs-parser";
import type { DeeplakeFs } from "./deeplake-fs.js";

import {
  buildGrepSearchOptions,
  buildPathFilterForTargets,
  searchDeeplakeTables,
  normalizeContent,
  refineGrepMatches,
  type GrepMatchParams,
  type ContentRow,
} from "./grep-core.js";

const MAX_FALLBACK_CANDIDATES = 500;

/**
 * grep implementation for the deeplake-shell (virtual bash). Two paths:
 *   1. SQL-first: dual-table LIKE/ILIKE search via grep-core, with session
 *      content projected into the same file-like view used by local reads.
 *   2. Fallback: if SQL returns nothing (or races past a 3s timeout), scan
 *      the in-memory FS cache using the same regex refinement.
 *
 * Falls through (exitCode=127) for paths outside the mount so just-bash can
 * use its own built-in grep.
 */
export function createGrepCommand(
  client: DeeplakeApi,
  fs: DeeplakeFs,
  table: string,
  sessionsTable?: string,
) {
  return defineCommand("grep", async (args, ctx) => {
    const parsed = yargsParser(args, {
      boolean: ["r", "R", "l", "i", "n", "v", "c", "F", "w", "fixed-strings", "recursive", "ignore-case", "word-regexp"],
      alias: {
        r: "recursive", R: "recursive",
        F: "fixed-strings", i: "ignore-case",
        n: "line-number", w: "word-regexp",
        l: "files-with-matches", c: "count", v: "invert-match",
      },
    });

    const positional = parsed._ as string[];
    if (positional.length === 0) {
      return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 1 };
    }

    const pattern = String(positional[0]);
    const targetArgs = positional.slice(1);

    const targets = targetArgs.length > 0
      ? targetArgs.map(t => ctx.fs.resolvePath(ctx.cwd, String(t))).filter(Boolean)
      : [ctx.cwd];
    if (targets.length === 0) return { stdout: "", stderr: "", exitCode: 1 };

    const mount = fs.mountPoint;
    const mountPrefix = mount === "/" ? "/" : mount + "/";
    const allUnderMount = targets.every(t => t === mount || t.startsWith(mountPrefix));
    if (!allUnderMount) return { stdout: "", stderr: "", exitCode: 127 };

    const matchParams: GrepMatchParams = {
      pattern,
      fixedString: Boolean(parsed.F || parsed["fixed-strings"]),
      ignoreCase: Boolean(parsed.i || parsed["ignore-case"]),
      wordMatch: Boolean(parsed.w || parsed["word-regexp"]),
      lineNumber: Boolean(parsed.n || parsed["line-number"]),
      invertMatch: Boolean(parsed.v || parsed["invert-match"]),
      filesOnly: Boolean(parsed.l || parsed["files-with-matches"]),
      countOnly: Boolean(parsed.c || parsed["count"]),
    };

    let rows: ContentRow[] = [];
    try {
      const searchOptions = {
        ...buildGrepSearchOptions(matchParams, targets[0] ?? ctx.cwd),
        pathFilter: buildPathFilterForTargets(targets),
      };
      const queryRows = await Promise.race([
        searchDeeplakeTables(client, table, sessionsTable ?? "sessions", searchOptions),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      rows.push(...queryRows);
    } catch {
      rows = []; // fall through to in-memory fallback
    }

    // Dedup by path (multiple targets may overlap)
    const seen = new Set<string>();
    rows = rows.filter(r => seen.has(r.path) ? false : (seen.add(r.path), true));

    // Fallback: if SQL returned nothing, scan the FS cache. Limits exposure
    // on huge mounts; previously this ran whenever BM25 errored.
    if (rows.length === 0) {
      const withinTargets = (p: string) =>
        targets.some(t => t === "/" || p === t || p.startsWith(t + "/"));
      const candidates = fs.getAllPaths()
        .filter(p => !p.endsWith("/") && withinTargets(p))
        .slice(0, MAX_FALLBACK_CANDIDATES);
      await fs.prefetch(candidates);
      for (const fp of candidates) {
        const content = await fs.readFile(fp).catch(() => null);
        if (content !== null) rows.push({ path: fp, content });
      }
    }

    // Normalize session blobs into the same file-like text view used by reads.
    const normalized = rows.map(r => ({ path: r.path, content: normalizeContent(r.path, r.content) }));
    const forceMultiFilePrefix = parsed.r || parsed.R || parsed.recursive ? true : undefined;
    const output = refineGrepMatches(normalized, matchParams, forceMultiFilePrefix);

    return {
      stdout: output.length > 0 ? output.join("\n") + "\n" : "",
      stderr: "",
      exitCode: output.length > 0 ? 0 : 1,
    };
  });
}
