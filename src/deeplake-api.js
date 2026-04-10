import { randomUUID } from "node:crypto";
import { log as _log } from "./utils/debug.js";
import { sqlStr } from "./utils/sql.js";
const log = (msg) => _log("sdk", msg);
export class DeeplakeApi {
    token;
    apiUrl;
    orgId;
    workspaceId;
    tableName;
    _pendingRows = [];
    constructor(token, apiUrl, orgId, workspaceId, tableName) {
        this.token = token;
        this.apiUrl = apiUrl;
        this.orgId = orgId;
        this.workspaceId = workspaceId;
        this.tableName = tableName;
    }
    /** Execute SQL and return results as row-objects. */
    async query(sql) {
        const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "X-Activeloop-Org-Id": this.orgId,
            },
            body: JSON.stringify({ query: sql }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`Query failed: ${resp.status}: ${text.slice(0, 200)}`);
        }
        const raw = await resp.json();
        if (!raw?.rows || !raw?.columns)
            return [];
        return raw.rows.map(row => Object.fromEntries(raw.columns.map((col, i) => [col, row[i]])));
    }
    // ── Writes ──────────────────────────────────────────────────────────────────
    /** Queue rows for writing. Call commit() to flush. */
    appendRows(rows) {
        this._pendingRows.push(...rows);
    }
    /** Flush pending rows via SQL. */
    async commit() {
        if (this._pendingRows.length === 0)
            return;
        const rows = this._pendingRows;
        this._pendingRows = [];
        const CONCURRENCY = 10;
        for (let i = 0; i < rows.length; i += CONCURRENCY) {
            const chunk = rows.slice(i, i + CONCURRENCY);
            await Promise.allSettled(chunk.map(r => this.upsertRowSql(r)));
        }
        log(`commit: ${rows.length} rows`);
    }
    async upsertRowSql(row) {
        const ts = new Date().toISOString();
        const cd = row.creationDate ?? ts;
        const lud = row.lastUpdateDate ?? ts;
        const exists = await this.query(`SELECT path FROM "${this.tableName}" WHERE path = '${sqlStr(row.path)}' LIMIT 1`);
        if (exists.length > 0) {
            let setClauses = `summary = E'${sqlStr(row.contentText)}', ` +
                `mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
            if (row.project !== undefined)
                setClauses += `, project = '${sqlStr(row.project)}'`;
            if (row.description !== undefined)
                setClauses += `, description = '${sqlStr(row.description)}'`;
            await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`);
        }
        else {
            const id = randomUUID();
            let cols = "id, path, filename, summary, mime_type, size_bytes, creation_date, last_update_date";
            let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
            if (row.project !== undefined) {
                cols += ", project";
                vals += `, '${sqlStr(row.project)}'`;
            }
            if (row.description !== undefined) {
                cols += ", description";
                vals += `, '${sqlStr(row.description)}'`;
            }
            await this.query(`INSERT INTO "${this.tableName}" (${cols}) VALUES (${vals})`);
        }
    }
    /** Update specific columns on a row by path. */
    async updateColumns(path, columns) {
        const setClauses = Object.entries(columns)
            .map(([col, val]) => typeof val === "number" ? `${col} = ${val}` : `${col} = '${sqlStr(String(val))}'`)
            .join(", ");
        await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(path)}'`);
    }
    // ── Convenience ─────────────────────────────────────────────────────────────
    /** Create a BM25 search index on a column. */
    async createIndex(column) {
        await this.query(`CREATE INDEX IF NOT EXISTS idx_${sqlStr(column)}_bm25 ON "${this.tableName}" USING deeplake_index ("${column}")`);
    }
    /** List all tables in the workspace. */
    async listTables() {
        const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables`, {
            headers: {
                Authorization: `Bearer ${this.token}`,
                "X-Activeloop-Org-Id": this.orgId,
            },
        });
        if (!resp.ok)
            return [];
        const data = await resp.json();
        return (data.tables ?? []).map(t => t.table_name);
    }
    /** Create the memory table if it doesn't already exist. Migrate columns on existing tables. */
    async ensureTable(name) {
        const tbl = name ?? this.tableName;
        const tables = await this.listTables();
        if (!tables.includes(tbl)) {
            log(`table "${tbl}" not found, creating`);
            await this.query(`CREATE TABLE IF NOT EXISTS "${tbl}" (` +
                `id TEXT NOT NULL DEFAULT '', ` +
                `path TEXT NOT NULL DEFAULT '', ` +
                `filename TEXT NOT NULL DEFAULT '', ` +
                `summary TEXT NOT NULL DEFAULT '', ` +
                `author TEXT NOT NULL DEFAULT '', ` +
                `mime_type TEXT NOT NULL DEFAULT 'text/plain', ` +
                `size_bytes BIGINT NOT NULL DEFAULT 0, ` +
                `project TEXT NOT NULL DEFAULT '', ` +
                `description TEXT NOT NULL DEFAULT '', ` +
                `creation_date TEXT NOT NULL DEFAULT '', ` +
                `last_update_date TEXT NOT NULL DEFAULT ''` +
                `) USING deeplake`);
            log(`table "${tbl}" created`);
        }
        else {
            // Migrate: add new columns if missing on existing tables
            for (const col of ["project", "description", "creation_date", "last_update_date", "author"]) {
                try {
                    await this.query(`ALTER TABLE "${tbl}" ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
                    log(`added column "${col}" to "${tbl}"`);
                }
                catch {
                    // Column already exists — ignore
                }
            }
        }
    }
    /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
    async ensureSessionsTable(name) {
        const tables = await this.listTables();
        if (!tables.includes(name)) {
            log(`table "${name}" not found, creating`);
            await this.query(`CREATE TABLE IF NOT EXISTS "${name}" (` +
                `id TEXT NOT NULL DEFAULT '', ` +
                `path TEXT NOT NULL DEFAULT '', ` +
                `filename TEXT NOT NULL DEFAULT '', ` +
                `message JSONB, ` +
                `author TEXT NOT NULL DEFAULT '', ` +
                `mime_type TEXT NOT NULL DEFAULT 'application/json', ` +
                `size_bytes BIGINT NOT NULL DEFAULT 0, ` +
                `project TEXT NOT NULL DEFAULT '', ` +
                `description TEXT NOT NULL DEFAULT '', ` +
                `creation_date TEXT NOT NULL DEFAULT '', ` +
                `last_update_date TEXT NOT NULL DEFAULT ''` +
                `) USING deeplake`);
            log(`table "${name}" created`);
        }
    }
}
//# sourceMappingURL=deeplake-api.js.map