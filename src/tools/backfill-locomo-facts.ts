#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import { loadCredentials } from "../commands/auth.js";
import { DeeplakeApi, DeeplakeQueryError, summarizeSql } from "../deeplake-api.js";
import {
  buildMemoryFactPrompt,
  parseMemoryFactExtraction,
  replaceSessionFacts,
} from "../hooks/memory-facts.js";
import { findClaudeBin } from "../hooks/spawn-wiki-worker.js";

const execFileAsync = promisify(execFile);

interface Args {
  memoryTable: string;
  factsTable: string;
  entitiesTable: string;
  linksTable: string;
  pathContains?: string;
  concurrency: number;
  model: string;
  clearFacts: boolean;
  clearEntities: boolean;
  errorLogPath?: string;
}

interface SummaryRow {
  path: string;
  summary: string;
  project?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const opts: Args = {
    memoryTable: "memory",
    factsTable: "memory_facts",
    entitiesTable: "memory_entities",
    linksTable: "fact_entity_links",
    pathContains: undefined,
    concurrency: 4,
    model: "haiku",
    clearFacts: false,
    clearEntities: false,
    errorLogPath: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--memory-table":
        opts.memoryTable = args[++i] ?? opts.memoryTable;
        break;
      case "--facts-table":
        opts.factsTable = args[++i] ?? opts.factsTable;
        break;
      case "--entities-table":
        opts.entitiesTable = args[++i] ?? opts.entitiesTable;
        break;
      case "--links-table":
        opts.linksTable = args[++i] ?? opts.linksTable;
        break;
      case "--path-contains":
        opts.pathContains = args[++i] ?? opts.pathContains;
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, parseInt(args[++i] ?? "4", 10) || 4);
        break;
      case "--model":
        opts.model = args[++i] ?? opts.model;
        break;
      case "--clear-facts":
        opts.clearFacts = true;
        break;
      case "--clear-entities":
        opts.clearEntities = true;
        break;
      case "--error-log":
        opts.errorLogPath = args[++i] ?? opts.errorLogPath;
        break;
    }
  }
  return opts;
}

function extractSummarySourcePath(summary: string): string {
  const match = summary.match(/^- \*\*Source\*\*: (.+)$/m);
  return match?.[1]?.trim() || "";
}

function sessionIdFromSummaryPath(path: string): string {
  const base = basename(path).replace(/\.md$/, "");
  return base.endsWith("_summary") ? base.slice(0, -"_summary".length) : base;
}

function serializeError(error: unknown): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error));
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  const record = err as Error & Record<string, unknown>;
  if (typeof record["phase"] === "string") out["phase"] = record["phase"];
  if (typeof record["sessionId"] === "string") out["sessionId"] = record["sessionId"];
  if (typeof record["table"] === "string") out["table"] = record["table"];
  if (typeof record["sql"] === "string") out["sql"] = record["sql"];
  if (error instanceof DeeplakeQueryError) {
    out["sqlSummary"] = error.sqlSummary;
    out["status"] = error.status;
    out["responseBody"] = error.responseBody;
  } else if (typeof record["sql"] === "string") {
    out["sqlSummary"] = summarizeSql(record["sql"] as string);
  }
  const cause = record["cause"];
  if (cause instanceof DeeplakeQueryError) {
    out["cause"] = {
      name: cause.name,
      message: cause.message,
      sqlSummary: cause.sqlSummary,
      status: cause.status,
      responseBody: cause.responseBody,
      stack: cause.stack,
    };
  } else if (cause instanceof Error) {
    out["cause"] = {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
    };
  }
  return out;
}

function appendErrorLog(logPath: string | undefined, payload: Record<string, unknown>): void {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf-8");
}

async function generateFacts(
  summary: string,
  sourcePath: string,
  sessionId: string,
  project: string,
  claudeBin: string,
  model: string,
) {
  const prompt = buildMemoryFactPrompt({
    summaryText: summary,
    sessionId,
    sourcePath,
    project,
  });
  const { stdout } = await execFileAsync(claudeBin, [
    "-p",
    prompt,
    "--no-session-persistence",
    "--model",
    model,
    "--permission-mode",
    "bypassPermissions",
  ], {
    timeout: 120_000,
    env: {
      ...process.env,
      DEEPLAKE_CAPTURE: "false",
      HIVEMIND_CAPTURE: "false",
      HIVEMIND_WIKI_WORKER: "1",
    },
  });
  return parseMemoryFactExtraction(stdout);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const creds = loadCredentials();
  if (!creds?.token || !creds.orgId) {
    throw new Error("Missing Deeplake credentials. Run auth first.");
  }

  const workspaceId = creds.workspaceId ?? "default";
  const apiUrl = process.env["HIVEMIND_API_URL"] ?? process.env["DEEPLAKE_API_URL"] ?? creds.apiUrl ?? "https://api.deeplake.ai";
  const api = new DeeplakeApi(creds.token, apiUrl, creds.orgId, workspaceId, opts.memoryTable);
  await api.ensureFactsTable(opts.factsTable);
  await api.ensureEntitiesTable(opts.entitiesTable);
  await api.ensureFactEntityLinksTable(opts.linksTable);

  if (opts.clearFacts) {
    await api.query(`DELETE FROM "${opts.factsTable}"`);
    await api.query(`DELETE FROM "${opts.linksTable}"`);
  }
  if (opts.clearEntities) {
    await api.query(`DELETE FROM "${opts.entitiesTable}"`);
  }

  const summaryRows = await api.query(
    `SELECT path, summary, project FROM "${opts.memoryTable}" WHERE path LIKE '/summaries/locomo/%' ORDER BY path ASC`,
  );
  const summaries: SummaryRow[] = summaryRows.map((row) => ({
    path: String(row["path"] ?? ""),
    summary: String(row["summary"] ?? ""),
    project: row["project"] == null ? undefined : String(row["project"]),
  }))
    .filter((row) => row.path && row.summary)
    .filter((row) => !opts.pathContains || row.path.includes(opts.pathContains));

  const claudeBin = findClaudeBin();
  let nextIndex = 0;
  let completed = 0;
  let failures = 0;
  let totalFacts = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= summaries.length) return;
      const row = summaries[index];
      const sessionId = sessionIdFromSummaryPath(row.path);
      const sourcePath = extractSummarySourcePath(row.summary) || `/sessions/${sessionId}.json`;
      try {
        const extraction = await generateFacts(
          row.summary,
          sourcePath,
          sessionId,
          row.project || "locomo",
          claudeBin,
          opts.model,
        );
        const result = await replaceSessionFacts({
          query: (sql) => api.query(sql),
          factsTable: opts.factsTable,
          entitiesTable: opts.entitiesTable,
          linksTable: opts.linksTable,
          sessionId,
          userName: "locomo",
          project: row.project || "locomo",
          agent: "claude_code",
          sourcePath,
          extraction,
        });
        totalFacts += result.facts;
        completed += 1;
        process.stdout.write(`facts ${completed}/${summaries.length}: ${sessionId} facts=${result.facts} entities=${result.entities} links=${result.links}\n`);
      } catch (error) {
        failures += 1;
        const payload = {
          path: row.path,
          sessionId,
          sourcePath,
          failureAt: new Date().toISOString(),
          error: serializeError(error),
        };
        appendErrorLog(opts.errorLogPath, payload);
        process.stderr.write(`FAIL ${row.path}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  process.stdout.write(`Done. facts_summaries=${completed} failed=${failures} total_facts=${totalFacts}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
