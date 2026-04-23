import type { DeeplakeApi } from "../deeplake-api.js";
import { defineCommand } from "just-bash";
import yargsParser from "yargs-parser";
import type { DeeplakeFs } from "./deeplake-fs.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingsDisabled } from "../embeddings/disable.js";

import {
  buildGrepSearchOptions,
  buildPathFilterForTargets,
  searchDeeplakeTables,
  normalizeContent,
  refineGrepMatches,
  type GrepMatchParams,
  type ContentRow,
} from "./grep-core.js";

const SEMANTIC_SEARCH_ENABLED = process.env.HIVEMIND_SEMANTIC_SEARCH !== "false" && !embeddingsDisabled();
const SEMANTIC_EMBED_TIMEOUT_MS = Number(process.env.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS ?? "500");

function resolveGrepEmbedDaemonPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "embeddings", "embed-daemon.js");
}

let sharedGrepEmbedClient: EmbedClient | null = null;
function getGrepEmbedClient(): EmbedClient {
  if (!sharedGrepEmbedClient) {
    sharedGrepEmbedClient = new EmbedClient({
      daemonEntry: resolveGrepEmbedDaemonPath(),
      timeoutMs: SEMANTIC_EMBED_TIMEOUT_MS,
    });
  }
  return sharedGrepEmbedClient;
}

/**
 * Plain-text-ish pattern → candidate for semantic search.
 * Skip regex-heavy queries (many metachars) where cosine similarity is not
 * what the user asked for.
 */
function patternIsSemanticFriendly(pattern: string, fixedString: boolean): boolean {
  if (!pattern || pattern.length < 2) return false;
  if (fixedString) return true;
  // Literal-ish patterns with only occasional `.*` are still fine for semantic.
  const metaMatches = pattern.match(/[|()\[\]{}+?^$\\]/g);
  if (!metaMatches) return true;
  return metaMatches.length <= 1;
}

const MAX_FALLBACK_CANDIDATES = 500;

/**
 * grep implementation for the deeplake-shell (virtual bash). Two paths:
 *   1. SQL-first: dual-table LIKE/ILIKE search via grep-core, with session
 *      JSON normalized to per-turn lines for sane output.
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

    // Try semantic search first (daemon-backed embedding of the pattern).
    // Falls back to lexical LIKE if the daemon is unreachable, disabled by
    // env flag, or the pattern is regex-heavy.
    let queryEmbedding: number[] | null = null;
    if (SEMANTIC_SEARCH_ENABLED && patternIsSemanticFriendly(pattern, matchParams.fixedString)) {
      try {
        queryEmbedding = await getGrepEmbedClient().embed(pattern, "query");
      } catch {
        queryEmbedding = null;
      }
    }

    let rows: ContentRow[] = [];
    try {
      const searchOptions = {
        ...buildGrepSearchOptions(matchParams, targets[0] ?? ctx.cwd),
        pathFilter: buildPathFilterForTargets(targets),
        limit: 100,
        queryEmbedding,
      };
      const queryRows = await Promise.race([
        searchDeeplakeTables(client, table, sessionsTable ?? "sessions", searchOptions),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      rows.push(...queryRows);
    } catch {
      rows = []; // fall through to in-memory fallback
    }

    // Semantic returned nothing → retry with lexical LIKE as a second shot
    // before giving up to the in-memory fallback. Keeps behavior robust when
    // embeddings miss but BM25 would match.
    if (rows.length === 0 && queryEmbedding) {
      try {
        const lexicalOptions = {
          ...buildGrepSearchOptions(matchParams, targets[0] ?? ctx.cwd),
          pathFilter: buildPathFilterForTargets(targets),
          limit: 100,
        };
        const lexicalRows = await Promise.race([
          searchDeeplakeTables(client, table, sessionsTable ?? "sessions", lexicalOptions),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
        rows.push(...lexicalRows);
      } catch {
        // fall through to in-memory fallback below
      }
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

    // Normalize session JSON blobs to per-turn lines.
    const normalized = rows.map(r => ({ path: r.path, content: normalizeContent(r.path, r.content) }));

    // In semantic mode, skip the regex refinement: cosine similarity has
    // already done the filtering, and dropping lines whose literal text
    // doesn't match the pattern would defeat the semantic retrieval.
    // Toggle with HIVEMIND_SEMANTIC_EMIT_ALL=false to restore strict regex.
    let output: string[];
    if (queryEmbedding && queryEmbedding.length > 0 && process.env.HIVEMIND_SEMANTIC_EMIT_ALL !== "false") {
      output = [];
      for (const r of normalized) {
        for (const line of r.content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) output.push(`${r.path}:${line}`);
        }
      }
    } else {
      output = refineGrepMatches(normalized, matchParams);
    }

    return {
      stdout: output.length > 0 ? output.join("\n") + "\n" : "",
      stderr: "",
      exitCode: output.length > 0 ? 0 : 1,
    };
  });
}
