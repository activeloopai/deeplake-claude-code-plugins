/**
 * Hivemind MCP server — exposes shared org memory as MCP tools.
 *
 * Tools:
 *   hivemind_search  — keyword/regex search across summaries + sessions
 *   hivemind_read    — read full content of a specific memory path
 *   hivemind_index   — list summaries with their dates and descriptions
 *
 * Transport: stdio. Spawned as a subprocess by the consuming MCP client
 * (Hermes today; reused by any future MCP-aware agent).
 *
 * Auth: loads ~/.deeplake/credentials.json. If credentials are missing,
 * tools return a clear "not authenticated" message rather than crashing.
 */

import * as z from "zod/v3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr, sqlLike } from "../utils/sql.js";
import { searchDeeplakeTables, buildGrepSearchOptions, normalizeContent, type GrepMatchParams } from "../shell/grep-core.js";
import { getVersion } from "../cli/version.js";

interface ServerContext {
  api: DeeplakeApi;
  memoryTable: string;
  sessionsTable: string;
}

function getContext(): ServerContext | { error: string } {
  const creds = loadCredentials();
  if (!creds?.token) {
    return { error: "Not authenticated. Run `hivemind login` to sign in to Deeplake." };
  }
  const config = loadConfig();
  if (!config) {
    return { error: "Hivemind config could not be loaded — credentials present but invalid." };
  }
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
  return { api, memoryTable: config.tableName, sessionsTable: config.sessionsTableName };
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

const server = new McpServer({
  name: "hivemind",
  version: getVersion(),
});

server.registerTool(
  "hivemind_search",
  {
    description: "Search Hivemind shared memory (summaries + raw sessions) by keyword or multi-word phrase. Returns matching paths and snippets. Use this first when the user asks about prior work, conversations, or context that may exist in Hivemind. Different paths under /summaries/<username>/ are different users — do not merge them.",
    inputSchema: {
      query: z.string().describe("Keyword or multi-word phrase to search for (literal substring match)."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum hits to return (default 10)."),
    },
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    const params: GrepMatchParams = {
      pattern: query,
      ignoreCase: true,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: true,
    };
    const opts = buildGrepSearchOptions(params, "/");
    opts.limit = limit ?? 10;

    try {
      const rows = await searchDeeplakeTables(ctx.api, ctx.memoryTable, ctx.sessionsTable, opts);
      if (rows.length === 0) return errorResult(`No matches for "${query}".`);
      const lines = rows.map(r => {
        const body = normalizeContent(r.path, r.content);
        return `[${r.path}]\n${body.slice(0, 600)}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Search failed: ${msg}`);
    }
  },
);

server.registerTool(
  "hivemind_read",
  {
    description: "Read the full content of a specific Hivemind memory path. Use after hivemind_search to drill into a hit, or when you already know the path (e.g. /summaries/alice/abc.md or /sessions/alice/alice_org_ws_xyz.jsonl or /index.md).",
    inputSchema: {
      path: z.string().describe("Absolute Hivemind memory path, e.g. /summaries/alice/abc.md"),
    },
  },
  async ({ path }: { path: string }) => {
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    if (!path.startsWith("/")) {
      return errorResult(`Path must start with '/': got "${path}"`);
    }

    const isSession = path.startsWith("/sessions/");
    const table = isSession ? ctx.sessionsTable : ctx.memoryTable;
    const column = isSession ? "message::text" : "summary::text";

    try {
      const sql = `SELECT path, ${column} AS content FROM "${table}" WHERE path = '${sqlStr(path)}' LIMIT 200`;
      const rows = await ctx.api.query(sql);
      if (rows.length === 0) return errorResult(`No content found at ${path}.`);
      const text = rows.map(r => normalizeContent(String(r["path"]), String(r["content"] ?? ""))).join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Read failed: ${msg}`);
    }
  },
);

server.registerTool(
  "hivemind_index",
  {
    description: "List Hivemind summary entries (one row per session). Use to see what's in shared memory and find relevant sessions to drill into with hivemind_read.",
    inputSchema: {
      prefix: z.string().optional().describe("Path prefix to filter by, e.g. '/summaries/alice/' to scope to one user."),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum rows (default 50)."),
    },
  },
  async ({ prefix, limit }: { prefix?: string; limit?: number }) => {
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    // sqlLike escapes both quotes AND LIKE wildcards (% / _) so an
    // LLM-supplied prefix can't bypass the filter (e.g. prefix='%' would
    // match every row otherwise). ESCAPE '\\' tells the engine to honour
    // the backslash escapes sqlLike inserts.
    const where = prefix
      ? `WHERE path LIKE '${sqlLike(prefix)}%' ESCAPE '\\'`
      : `WHERE path LIKE '/summaries/%'`;
    const sql = `SELECT path, description, project, last_update_date FROM "${ctx.memoryTable}" ${where} ORDER BY last_update_date DESC LIMIT ${limit ?? 50}`;

    try {
      const rows = await ctx.api.query(sql);
      if (rows.length === 0) return errorResult("No summaries found.");
      const lines = rows.map(r => {
        const path = String(r["path"] ?? "?");
        const desc = String(r["description"] ?? "");
        const project = String(r["project"] ?? "");
        const date = String(r["last_update_date"] ?? "");
        return `${path}\t${date}\t${project}\t${desc}`;
      });
      return { content: [{ type: "text", text: `path\tlast_updated\tproject\tdescription\n${lines.join("\n")}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Index failed: ${msg}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`hivemind-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
