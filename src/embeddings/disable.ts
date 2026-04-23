/**
 * Master opt-out for the embedding feature.
 *
 * `HIVEMIND_EMBEDDINGS=false` short-circuits every call site that would
 * otherwise talk to the nomic daemon: the SessionStart warmup, the
 * capture-side write embed, the batched flush embed in DeeplakeFs, and
 * both grep query-time embed paths (direct + interceptor). The SQL
 * schema still has the embedding columns and existing rows' embeddings
 * remain readable, but no new embedding is computed and no daemon is
 * spawned.
 *
 * Intended for: air-gapped / no-network installs, CI / benchmarks that
 * want pure-lexical retrieval, and users who want the plugin's capture
 * + grep without paying the ~110 MB nomic download.
 *
 * Read-once: honours mutations during the process lifetime; the hooks
 * are short-lived subprocesses so a live toggle via `export` takes
 * effect on the next session.
 */
export function embeddingsDisabled(): boolean {
  return process.env.HIVEMIND_EMBEDDINGS === "false";
}
