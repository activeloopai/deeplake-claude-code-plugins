// Centralized column names for the embedding feature. The same identifiers
// are referenced by the SQL builders in deeplake-api.ts (CREATE / ALTER /
// schema check), capture.ts and upload-summary.ts (INSERT), wiki-worker.ts
// (UPDATE), and the grep paths (SELECT). Keeping them here avoids the typo
// class of bugs that come from string-literal duplication and makes a future
// rename a one-file change.

/** memory.summary_embedding — embedding of the row's `summary` text. */
export const SUMMARY_EMBEDDING_COL = "summary_embedding";

/** sessions.message_embedding — embedding of the row's `message` JSONB content. */
export const MESSAGE_EMBEDDING_COL = "message_embedding";

/** Output dimensionality of the nomic-embed-text-v1.5 daemon (matryoshka-truncated). */
export const EMBEDDING_DIMS = 768;
