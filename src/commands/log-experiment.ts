#!/usr/bin/env node

/**
 * CLI entry point for the generic experiment log.
 *
 * Usage:
 *   node log-experiment.js log <change_id> <metric> <status> "<description>" [--metadata <json>] [--metadata-file <path>] [--table <name>]
 *   node log-experiment.js promote <change_id> [--id <uuid>] [--unset] [--table <name>]
 *   node log-experiment.js init [--table <name>]
 *
 * Default table:    HIVEMIND_EXPERIMENT_TABLE env, falling back to "experiments".
 * Auth:             reuses ~/.deeplake/credentials.json via loadConfig().
 */

import { readFileSync } from "node:fs";
import yargsParser from "yargs-parser";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import {
  ensureExperimentTable,
  logExperiment,
  promoteExperiment,
} from "./experiment-log.js";

const DEFAULT_TABLE = "experiments";

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
  console.log('  log-experiment log <change_id> <metric> <status> "<description>" [--metadata <json>] [--metadata-file <path>] [--table <name>]');
  console.log("  log-experiment promote <change_id> [--id <uuid>] [--unset] [--table <name>]");
  console.log("  log-experiment init [--table <name>]");
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

async function main(): Promise<void> {
  const argv = yargsParser(process.argv.slice(2), {
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

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(1);
});
