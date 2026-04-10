export interface WriteRow {
    path: string;
    filename: string;
    contentText: string;
    mimeType: string;
    sizeBytes: number;
    project?: string;
    description?: string;
    creationDate?: string;
    lastUpdateDate?: string;
}
export declare class DeeplakeApi {
    private token;
    private apiUrl;
    private orgId;
    private workspaceId;
    readonly tableName: string;
    private _pendingRows;
    constructor(token: string, apiUrl: string, orgId: string, workspaceId: string, tableName: string);
    /** Execute SQL and return results as row-objects. */
    query(sql: string): Promise<Record<string, unknown>[]>;
    /** Queue rows for writing. Call commit() to flush. */
    appendRows(rows: WriteRow[]): void;
    /** Flush pending rows via SQL. */
    commit(): Promise<void>;
    private upsertRowSql;
    /** Update specific columns on a row by path. */
    updateColumns(path: string, columns: Record<string, string | number>): Promise<void>;
    /** Create a BM25 search index on a column. */
    createIndex(column: string): Promise<void>;
    /** List all tables in the workspace. */
    listTables(): Promise<string[]>;
    /** Create the memory table if it doesn't already exist. Migrate columns on existing tables. */
    ensureTable(name?: string): Promise<void>;
    /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
    ensureSessionsTable(name: string): Promise<void>;
}
