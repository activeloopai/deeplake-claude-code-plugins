#!/usr/bin/env node

import { loadConfig } from "../config.js";
import { loadCredentials } from "../commands/auth.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { HarrierEmbedder } from "../embeddings/harrier.js";
import {
  buildMemoryEmbeddingText,
  buildSessionEmbeddingText,
  stableEmbeddingSourceHash,
  type MemoryEmbeddingRow,
  type SessionEmbeddingRow,
} from "../embeddings/text.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";

type TableKind = "memory" | "sessions";

interface Args {
  table: TableKind | "all";
  memoryTable: string;
  sessionsTable: string;
  modelId: string;
  startOffset: number;
  maxRows?: number;
  device?: string;
  dtype?: string;
  batchSize: number;
  scanBatchSize: number;
  limit?: number;
  force: boolean;
  localFilesOnly: boolean;
  localModelPath?: string;
  cacheDir?: string;
  memoryMaxChars: number;
  sessionsMaxChars: number;
  embeddingColumn: string;
  embeddingModelColumn: string;
  embeddingSourceHashColumn: string;
  embeddingUpdatedAtColumn: string;
}

interface SqlColumnSpec {
  name: string;
  ddl: string;
}

const DEFAULT_MODEL_ID = process.env.HIVEMIND_HARRIER_MODEL_ID
  ?? process.env.DEEPLAKE_HARRIER_MODEL_ID
  ?? "onnx-community/harrier-oss-v1-0.6b-ONNX";
const DEFAULT_EMBEDDING_COLUMN = "embedding";
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_SCAN_BATCH_SIZE = 64;

function printUsage(): void {
  process.stderr.write([
    "Usage: tsx src/tools/backfill-harrier-embeddings.ts [options]",
    "",
    "Options:",
    "  --table <memory|sessions|all>           Tables to backfill (default: all)",
    "  --memory-table <name>                   Memory table name",
    "  --sessions-table <name>                 Sessions table name",
    "  --model-id <id-or-path>                 Harrier model id (default: onnx-community/harrier-oss-v1-0.6b-ONNX)",
    "  --start-offset <n>                      Start scanning at SQL offset n (default: 0)",
    "  --max-rows <n>                          Process at most n scanned rows from the start offset",
    "  --device <cpu|...>                      Transformers.js device (default: cpu)",
    "  --dtype <q4|q8|fp32|...>                Optional ONNX dtype override",
    "  --batch-size <n>                        Embedding batch size (default: 8)",
    "  --scan-batch-size <n>                   Rows read/write per scan batch (default: 64)",
    "  --limit <n>                             Stop after n row updates",
    "  --force                                 Recompute even when source hash matches",
    "  --local-files-only                      Refuse remote model downloads",
    "  --local-model-path <dir>                Local model root for Transformers.js",
    "  --cache-dir <dir>                       Transformers.js cache directory",
    "  --memory-max-chars <n>                  Max chars embedded per memory row (default: 8000)",
    "  --sessions-max-chars <n>                Max chars embedded per sessions row (default: 8000)",
    "",
    "Note: For local TypeScript inference, the practical default is the ONNX export",
    "      of microsoft/harrier-oss-v1-0.6b. Pass --local-files-only with a local model",
    "      cache if you want fully offline execution.",
    "",
  ].join("\n"));
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(): Args {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const opts: Args = {
    table: "all",
    memoryTable: config?.tableName ?? "memory",
    sessionsTable: config?.sessionsTableName ?? "sessions",
    modelId: DEFAULT_MODEL_ID,
    startOffset: 0,
    device: "cpu",
    batchSize: DEFAULT_BATCH_SIZE,
    scanBatchSize: DEFAULT_SCAN_BATCH_SIZE,
    force: false,
    localFilesOnly: false,
    memoryMaxChars: 8_000,
    sessionsMaxChars: 8_000,
    embeddingColumn: DEFAULT_EMBEDDING_COLUMN,
    embeddingModelColumn: "embedding_model",
    embeddingSourceHashColumn: "embedding_source_hash",
    embeddingUpdatedAtColumn: "embedding_updated_at",
  };

  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      case "--table": {
        const value = args[++index];
        if (value === "memory" || value === "sessions" || value === "all") {
          opts.table = value;
        } else {
          throw new Error(`Unsupported --table value: ${value}`);
        }
        break;
      }
      case "--memory-table":
        opts.memoryTable = args[++index] ?? opts.memoryTable;
        break;
      case "--sessions-table":
        opts.sessionsTable = args[++index] ?? opts.sessionsTable;
        break;
      case "--model-id":
        opts.modelId = args[++index] ?? opts.modelId;
        break;
      case "--start-offset":
        opts.startOffset = Math.max(0, parseInteger(args[++index], 0));
        break;
      case "--max-rows":
        opts.maxRows = parseInteger(args[++index], 0);
        break;
      case "--device":
        opts.device = args[++index] ?? opts.device;
        break;
      case "--dtype":
        opts.dtype = args[++index] ?? opts.dtype;
        break;
      case "--batch-size":
        opts.batchSize = parseInteger(args[++index], opts.batchSize);
        break;
      case "--scan-batch-size":
        opts.scanBatchSize = parseInteger(args[++index], opts.scanBatchSize);
        break;
      case "--limit":
        opts.limit = parseInteger(args[++index], 0);
        break;
      case "--force":
        opts.force = true;
        break;
      case "--local-files-only":
        opts.localFilesOnly = true;
        break;
      case "--local-model-path":
        opts.localModelPath = args[++index] ?? opts.localModelPath;
        break;
      case "--cache-dir":
        opts.cacheDir = args[++index] ?? opts.cacheDir;
        break;
      case "--memory-max-chars":
        opts.memoryMaxChars = parseInteger(args[++index], opts.memoryMaxChars);
        break;
      case "--sessions-max-chars":
        opts.sessionsMaxChars = parseInteger(args[++index], opts.sessionsMaxChars);
        break;
      default:
        throw new Error(`Unknown argument: ${args[index]}`);
    }
  }

  return opts;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function hasVector(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function sqlFloat4Array(values: number[]): string {
  return `ARRAY[${values.map((value) => Number.isFinite(value) ? Math.fround(value).toString() : "0").join(", ")}]::float4[]`;
}

async function ensureSqlColumns(api: DeeplakeApi, tableName: string, specs: SqlColumnSpec[]): Promise<void> {
  const table = sqlIdent(tableName);
  for (const spec of specs) {
    const column = sqlIdent(spec.name);
    try {
      await api.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${spec.ddl}`);
    } catch {
      // Older backends may reject IF NOT EXISTS or duplicate adds.
      // Continue so repeated runs remain best-effort.
    }
  }
}

async function ensureEmbeddingIndex(api: DeeplakeApi, tableName: string, columnName: string): Promise<void> {
  const table = sqlIdent(tableName);
  const column = sqlIdent(columnName);
  const indexName = sqlIdent(`idx_${tableName}_${columnName}`.replace(/[^a-zA-Z0-9_]/g, "_"));
  await api.query(
    `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" USING deeplake_index ("${column}")`
  ).catch(() => {});
}

async function fetchMemoryRows(api: DeeplakeApi, args: Args, offset: number): Promise<Record<string, unknown>[]> {
  const table = sqlIdent(args.memoryTable);
  const remainingRows = args.maxRows ? Math.max(0, (args.startOffset + args.maxRows) - offset) : args.scanBatchSize;
  const limit = Math.min(args.scanBatchSize, remainingRows);
  if (limit <= 0) return [];
  return api.query(
    `SELECT id, path, filename, summary, description, project, ` +
    `"${sqlIdent(args.embeddingSourceHashColumn)}" AS embedding_source_hash, ` +
    `"${sqlIdent(args.embeddingModelColumn)}" AS embedding_model ` +
    `FROM "${table}" ORDER BY path ASC LIMIT ${limit} OFFSET ${offset}`
  );
}

async function fetchSessionRows(api: DeeplakeApi, args: Args, offset: number): Promise<Record<string, unknown>[]> {
  const table = sqlIdent(args.sessionsTable);
  const remainingRows = args.maxRows ? Math.max(0, (args.startOffset + args.maxRows) - offset) : args.scanBatchSize;
  const limit = Math.min(args.scanBatchSize, remainingRows);
  if (limit <= 0) return [];
  return api.query(
    `SELECT id, path, event_type, speaker, text, turn_summary, source_date_time, turn_index, message ` +
    `FROM "${table}" ` +
    `ORDER BY path ASC, turn_index ASC, creation_date ASC LIMIT ${limit} OFFSET ${offset}`
  );
}

async function updateEmbeddingRow(
  api: DeeplakeApi,
  tableName: string,
  args: Args,
  id: string,
  vector: number[],
  sourceHash: string,
): Promise<void> {
  const table = sqlIdent(tableName);
  const updatedAt = new Date().toISOString();
  await api.query(
    `UPDATE "${table}" SET ` +
    `"${sqlIdent(args.embeddingColumn)}" = ${sqlFloat4Array(vector)}, ` +
    `"${sqlIdent(args.embeddingModelColumn)}" = '${sqlStr(args.modelId)}', ` +
    `"${sqlIdent(args.embeddingSourceHashColumn)}" = '${sqlStr(sourceHash)}', ` +
    `"${sqlIdent(args.embeddingUpdatedAtColumn)}" = '${sqlStr(updatedAt)}' ` +
    `WHERE id = '${sqlStr(id)}'`
  );
}

async function backfillMemoryTable(api: DeeplakeApi, embedder: HarrierEmbedder, args: Args): Promise<{ updated: number; skipped: number }> {
  await ensureSqlColumns(api, args.memoryTable, [
    { name: args.embeddingColumn, ddl: "float4[]" },
    { name: args.embeddingModelColumn, ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: args.embeddingSourceHashColumn, ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: args.embeddingUpdatedAtColumn, ddl: "TEXT NOT NULL DEFAULT ''" },
  ]);

  let updated = 0;
  let skipped = 0;

  for (let offset = args.startOffset; ; offset += args.scanBatchSize) {
    const rows = await fetchMemoryRows(api, args, offset);
    if (rows.length === 0) break;

    const docs: string[] = [];
    const ids: string[] = [];
    const sourceHashes: string[] = [];

    for (const row of rows) {
      const text = buildMemoryEmbeddingText({
        path: asString(row["path"]),
        filename: asString(row["filename"]),
        summary: asString(row["summary"]),
        description: asString(row["description"]),
        project: asString(row["project"]),
      } satisfies MemoryEmbeddingRow, args.memoryMaxChars);

      if (!text) {
        skipped++;
        continue;
      }

      docs.push(text);
      ids.push(asString(row["id"]));
      sourceHashes.push(stableEmbeddingSourceHash(text));
    }

    for (let batchStart = 0; batchStart < docs.length; batchStart += args.batchSize) {
      const batchDocs = docs.slice(batchStart, batchStart + args.batchSize);
      const batchIds = ids.slice(batchStart, batchStart + args.batchSize);
      const batchHashes = sourceHashes.slice(batchStart, batchStart + args.batchSize);
      const vectors = await embedder.embedDocuments(batchDocs);

      for (let index = 0; index < vectors.length; index++) {
        await updateEmbeddingRow(api, args.memoryTable, args, batchIds[index], vectors[index], batchHashes[index]);
        updated++;
      }

      process.stderr.write(`[memory] updated ${updated}, skipped ${skipped}\n`);
      if (args.limit && updated >= args.limit) {
        await ensureEmbeddingIndex(api, args.memoryTable, args.embeddingColumn);
        return { updated, skipped };
      }
    }
  }

  await ensureEmbeddingIndex(api, args.memoryTable, args.embeddingColumn);
  return { updated, skipped };
}

async function backfillSessionsTable(api: DeeplakeApi, embedder: HarrierEmbedder, args: Args): Promise<{ updated: number; skipped: number }> {
  await ensureSqlColumns(api, args.sessionsTable, [
    { name: args.embeddingColumn, ddl: "float4[]" },
    { name: args.embeddingModelColumn, ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: args.embeddingSourceHashColumn, ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: args.embeddingUpdatedAtColumn, ddl: "TEXT NOT NULL DEFAULT ''" },
  ]);

  let updated = 0;
  let skipped = 0;

  for (let offset = args.startOffset; ; offset += args.scanBatchSize) {
    const rows = await fetchSessionRows(api, args, offset);
    if (rows.length === 0) break;

    const docs: string[] = [];
    const ids: string[] = [];
    const sourceHashes: string[] = [];

    for (const row of rows) {
      const text = buildSessionEmbeddingText({
        path: asString(row["path"]),
        event_type: asString(row["event_type"]),
        speaker: asString(row["speaker"]),
        text: asString(row["text"]),
        turn_summary: asString(row["turn_summary"]),
        source_date_time: asString(row["source_date_time"]),
        turn_index: Number.isFinite(Number(row["turn_index"])) ? Number(row["turn_index"]) : undefined,
        message: row["message"],
      } satisfies SessionEmbeddingRow, args.sessionsMaxChars);

      if (!text) {
        skipped++;
        continue;
      }

      const sourceHash = stableEmbeddingSourceHash(text);
      const existingHash = asString(row["embedding_source_hash"]);
      const existingModel = asString(row["embedding_model"]);
      if (!args.force && existingHash === sourceHash && existingModel === embedder.modelId) {
        skipped++;
        continue;
      }

      docs.push(text);
      ids.push(asString(row["id"]));
      sourceHashes.push(sourceHash);
    }

    for (let batchStart = 0; batchStart < docs.length; batchStart += args.batchSize) {
      const batchDocs = docs.slice(batchStart, batchStart + args.batchSize);
      const batchIds = ids.slice(batchStart, batchStart + args.batchSize);
      const batchHashes = sourceHashes.slice(batchStart, batchStart + args.batchSize);
      const vectors = await embedder.embedDocuments(batchDocs);

      for (let index = 0; index < vectors.length; index++) {
        await updateEmbeddingRow(api, args.sessionsTable, args, batchIds[index], vectors[index], batchHashes[index]);
        updated++;
      }

      process.stderr.write(`[sessions] updated ${updated}, skipped ${skipped}\n`);
      if (args.limit && updated >= args.limit) {
        await ensureEmbeddingIndex(api, args.sessionsTable, args.embeddingColumn);
        return { updated, skipped };
      }
    }
  }

  await ensureEmbeddingIndex(api, args.sessionsTable, args.embeddingColumn);
  return { updated, skipped };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const creds = loadCredentials();
  const config = loadConfig();
  if (!creds?.token || !config) {
    throw new Error("Missing Deeplake credentials. Run `deeplake login` first.");
  }

  const api = new DeeplakeApi(
    config.token,
    config.apiUrl,
    config.orgId,
    config.workspaceId,
    config.tableName,
  );
  const embedder = new HarrierEmbedder({
    modelId: args.modelId,
    cacheDir: args.cacheDir,
    localModelPath: args.localModelPath,
    localFilesOnly: args.localFilesOnly,
    device: args.device,
    dtype: args.dtype,
    batchSize: args.batchSize,
  });

  if (args.table === "memory" || args.table === "all") {
    const result = await backfillMemoryTable(api, embedder, args);
    process.stderr.write(`[memory] complete: updated=${result.updated} skipped=${result.skipped}\n`);
  }
  if (args.table === "sessions" || args.table === "all") {
    const result = await backfillSessionsTable(api, embedder, args);
    process.stderr.write(`[sessions] complete: updated=${result.updated} skipped=${result.skipped}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[backfill-harrier-embeddings] ${message}\n`);
  process.exit(1);
});
