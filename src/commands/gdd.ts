#!/usr/bin/env node

/**
 * Generic experiment log / GDD command.
 *
 * Usage:
 *   node gdd.js log <change_id> <metric> <status> "<description>" [--metadata <json>] [--metadata-file <path>] [--table <name>]
 *   node gdd.js promote <change_id> [--id <uuid>] [--unset] [--table <name>]
 *   node gdd.js init [--table <name>]
 *
 * Default table:    HIVEMIND_EXPERIMENT_TABLE env, falling back to "experiments".
 * Auth:             reuses ~/.deeplake/credentials.json via loadConfig().
 * Project:          auto-resolved the same way as hooks: current directory name.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yargsParser from "yargs-parser";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { resolveProjectName } from "../utils/project-name.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";

export { resolveProjectName };

const DEFAULT_TABLE = "experiments";

export interface ExperimentRow {
  changeIdentifier: string;
  metric: number;
  status: string;
  description: string;
  project?: string;
  metadata?: Record<string, unknown>;
}

export interface PromoteOptions {
  changeIdentifier: string;
  id?: string;
  unset?: boolean;
}

/** Create the experiment table if it doesn't exist. Idempotent. */
export async function ensureExperimentTable(
  api: DeeplakeApi,
  tableName: string,
): Promise<void> {
  const tbl = sqlIdent(tableName);
  const existing = await api.listTables();
  if (existing.includes(tbl)) return;

  await api.query(
    `CREATE TABLE IF NOT EXISTS "${tbl}" (` +
      `id TEXT NOT NULL DEFAULT '', ` +
      `change_identifier TEXT NOT NULL DEFAULT '', ` +
      `project TEXT NOT NULL DEFAULT '', ` +
      `metric FLOAT NOT NULL DEFAULT 0, ` +
      `metadata JSONB, ` +
      `status TEXT NOT NULL DEFAULT '', ` +
      `description TEXT NOT NULL DEFAULT '', ` +
      `global_promoted TEXT NOT NULL DEFAULT '', ` +
      `timestamp TEXT NOT NULL DEFAULT ''` +
    `) USING deeplake`,
  );
}

/** Append a single experiment row. Returns the row id (UUID). */
export async function logExperiment(
  api: DeeplakeApi,
  tableName: string,
  row: ExperimentRow,
): Promise<string> {
  const tbl = sqlIdent(tableName);
  const id = randomUUID();
  const ts = new Date().toISOString();
  const project = row.project ?? resolveProjectName();
  const metaJson = row.metadata !== undefined ? JSON.stringify(row.metadata) : "{}";
  // For JSONB literals: only escape single quotes. sqlStr() also doubles backslashes
  // and strips control chars, which would corrupt JSON (e.g. "\n" -> "\\n"). Same idiom
  // as src/hooks/capture.ts uses for the sessions.message column.
  const metaForSql = metaJson.replace(/'/g, "''");

  const sql =
    `INSERT INTO "${tbl}" ` +
    `(id, change_identifier, project, metric, metadata, status, description, global_promoted, timestamp) ` +
    `VALUES (` +
      `'${id}', ` +
      `'${sqlStr(row.changeIdentifier)}', ` +
      `'${sqlStr(project)}', ` +
      `${row.metric}, ` +
      `'${metaForSql}'::jsonb, ` +
      `'${sqlStr(row.status)}', ` +
      `'${sqlStr(row.description)}', ` +
      `'no', ` +
      `'${ts}'` +
    `)`;

  await api.query(sql);
  return id;
}

/** Set global_promoted on a row, matched by id when given, else by change_identifier. */
export async function promoteExperiment(
  api: DeeplakeApi,
  tableName: string,
  opts: PromoteOptions,
): Promise<void> {
  const tbl = sqlIdent(tableName);
  const value = opts.unset ? "no" : "yes";
  const where = opts.id
    ? `id = '${sqlStr(opts.id)}'`
    : `change_identifier = '${sqlStr(opts.changeIdentifier)}'`;
  await api.query(
    `UPDATE "${tbl}" SET global_promoted = '${value}' WHERE ${where}`,
  );
}

function resolveTable(argv: yargsParser.Arguments): string {
  return (argv.table as string | undefined)
    ?? process.env.HIVEMIND_EXPERIMENT_TABLE
    ?? DEFAULT_TABLE;
}

function readMetadata(argv: yargsParser.Arguments): Record<string, unknown> | undefined {
  const file = argv["metadata-file"] as string | undefined;
  if (file) {
    return JSON.parse(readFileSync(file, "utf-8"));
  }
  const inline = argv.metadata as string | undefined;
  if (inline !== undefined) {
    return JSON.parse(inline);
  }
  return undefined;
}

function usage(): void {
  console.log("Usage:");
  console.log('  gdd log <change_id> <metric> <status> "<description>" [--metadata <json>] [--metadata-file <path>] [--table <name>]');
  console.log("  gdd promote <change_id> [--id <uuid>] [--unset] [--table <name>]");
  console.log("  gdd init [--table <name>]");
}

function buildApi(): DeeplakeApi {
  const config = loadConfig();
  if (!config) {
    console.log("Not logged in. Run: /hivemind:login");
    process.exit(1);
  }
  return new DeeplakeApi(
    config.token, config.apiUrl, config.orgId, config.workspaceId, "",
  );
}

export async function runGddCommand(args: string[] = process.argv.slice(2)): Promise<void> {
  const argv = yargsParser(args, {
    string: ["table", "metadata", "metadata-file", "id"],
    boolean: ["unset"],
  });
  const cmd = String(argv._[0] ?? "");

  if (!cmd) { usage(); process.exit(1); }

  const table = resolveTable(argv);

  switch (cmd) {
    case "init": {
      const api = buildApi();
      await ensureExperimentTable(api, table);
      console.log(`Initialized experiment table: ${table}`);
      break;
    }

    case "log": {
      const positional = argv._;
      const changeId = positional[1];
      const metricStr = positional[2];
      const status = positional[3];
      const description = positional[4];
      if (!changeId || metricStr === undefined || metricStr === null || !status) {
        console.log('Usage: log <change_id> <metric> <status> "<description>" [--metadata <json>]');
        process.exit(1);
      }
      const metric = Number(metricStr);
      if (!Number.isFinite(metric)) {
        console.log(`Invalid metric: ${metricStr} (must be numeric)`);
        process.exit(1);
      }
      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = readMetadata(argv);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`Invalid metadata JSON: ${msg}`);
        process.exit(1);
      }
      const api = buildApi();
      await ensureExperimentTable(api, table);
      const rowId = await logExperiment(api, table, {
        changeIdentifier: String(changeId),
        metric,
        status: String(status),
        description: description !== undefined ? String(description) : "",
        metadata,
      });
      console.log(`Logged experiment ${rowId} (change_identifier=${changeId}) in ${table}`);
      break;
    }

    case "promote": {
      const changeId = argv._[1];
      if (!changeId) {
        console.log("Usage: promote <change_id> [--id <uuid>] [--unset]");
        process.exit(1);
      }
      const id = argv.id as string | undefined;
      const unset = Boolean(argv.unset);
      const api = buildApi();
      await promoteExperiment(api, table, {
        changeIdentifier: String(changeId),
        id,
        unset,
      });
      const verb = unset ? "Unpromoted" : "Promoted";
      const target = id ? `id=${id}` : `change_identifier=${changeId}`;
      console.log(`${verb} ${target} in ${table}`);
      break;
    }

    default:
      console.log(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runGddCommand().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  });
}
