import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike, sqlStr } from "../utils/sql.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    throw new Error("Missing Hivemind/Deeplake config");
  }

  const queryText = process.argv.slice(2).join(" ").trim() || "book novel literature";
  const api = new DeeplakeApi(
    config.token,
    config.apiUrl,
    config.orgId,
    config.workspaceId,
    config.tableName,
  );

  const started = Date.now();
  await api.ensureSummaryBm25Index();
  const createMs = Date.now() - started;

  const bm25Started = Date.now();
  const bm25Rows = await api.query(
    `SELECT path, (summary <#> '${sqlStr(queryText)}') AS score ` +
    `FROM "${config.tableName}" WHERE path LIKE '/summaries/%' ` +
    `ORDER BY score DESC LIMIT 10`,
  );
  const bm25Ms = Date.now() - bm25Started;

  const ilikeStarted = Date.now();
  const ilikeRows = await api.query(
    `SELECT path FROM "${config.tableName}" WHERE path LIKE '/summaries/%' ` +
    `AND summary ILIKE '%${sqlLike(queryText.split(/\s+/)[0] ?? queryText)}%' LIMIT 10`,
  );
  const ilikeMs = Date.now() - ilikeStarted;

  console.log(JSON.stringify({
    table: config.tableName,
    queryText,
    createIndexMs: createMs,
    bm25Ms,
    bm25TopPaths: bm25Rows.slice(0, 5).map((row) => ({ path: row["path"], score: row["score"] })),
    ilikeMs,
    ilikeTopPaths: ilikeRows.slice(0, 5).map((row) => row["path"]),
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
