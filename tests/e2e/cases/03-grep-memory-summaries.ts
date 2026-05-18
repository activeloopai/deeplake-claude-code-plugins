/**
 * grep over ~/.deeplake/memory/summaries/ routes through the SQL fast-path.
 *
 * The agent is told to grep for a sentinel string the harness seeds into
 * the memory table. With the grep-direct intercept wired, the hook
 * issues one SQL query against the memory table and returns matching
 * rows; without it, grep walks the real filesystem and finds nothing
 * because the mount is virtual.
 *
 * setup() inserts a deterministic memory row keyed on this case's
 * session_id, so we don't depend on any pre-existing test data and the
 * assertion has a stable, unique sentinel to match against.
 */

import { DeeplakeApi } from "../../../src/deeplake-api.js";
import type { E2ECase } from "../types.js";

const SENTINEL = "HIVEMIND_E2E_GREP_SENTINEL_42";

const grepMemorySummariesCase: E2ECase = {
  id: "03-grep-memory-summaries",
  description:
    "agent shells grep over ~/.deeplake/memory/summaries/ and the SQL fast-path returns the sentinel row",
  prompt:
    `Run exactly this bash command and show me its full output:\n` +
    `grep -r ${SENTINEL} ~/.deeplake/memory/summaries/`,
  async setup(ctx) {
    const memoryApi = new DeeplakeApi(
      ctx.creds.token,
      ctx.creds.apiUrl,
      ctx.creds.orgId,
      ctx.creds.workspaceId,
      ctx.creds.memoryTable,
    );
    // Insert a deterministic memory row with our sentinel in the message
    // body. Path embeds the session_id so cleanup sweeps it. Schema
    // matches what the capture hook would produce — minimal fields only.
    // Memory table schema (see DeeplakeApi.ensureTable() in src/deeplake-
    // api.ts): id, path, filename, summary, summary_embedding, author,
    // mime_type, size_bytes, project, description, agent, plugin_version,
    // creation_date, last_update_date. The `summary` column is TEXT, not
    // JSONB — seed plain markdown body.
    await memoryApi.ensureTable(ctx.creds.memoryTable);
    const path = `/summaries/e2e/${ctx.sessionId}.md`;
    const body = `## E2E grep sentinel\n\nMarker: ${SENTINEL}\n`;
    const now = new Date().toISOString();
    await memoryApi.query(
      `INSERT INTO "${ctx.creds.memoryTable}" ` +
      `(id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
      `VALUES (gen_random_uuid(), '${path}', '${ctx.sessionId}.md', '${body.replace(/'/g, "''")}', ` +
      `'e2e', 'text/markdown', ${Buffer.byteLength(body, "utf-8")}, 'e2e', 'grep-sentinel', '${ctx.agent}', ` +
      `'e2e-test', '${now}', '${now}')`,
    );
  },
  assertions: [
    // Stdout is the only reliable signal: the seeded sentinel either
    // makes it to the agent (intercept fired and returned the row) or
    // it doesn't (real-FS grep on the virtual mount returns nothing).
    // The intercept's log markers vary by compile path; the user-
    // visible result is what matters.
    {
      type: "stdout-contains",
      substring: SENTINEL,
      label: "agent received the sentinel row from the SQL fast-path",
    },
  ],
  // OpenClaw doesn't shell out to grep — its agent's search path is the
  // hivemind_search MCP tool. The equivalent assertion lives in
  // cases/08-openclaw-tools.ts (which invokes that tool directly).
  skipFor: ["openclaw"],
};

export default grepMemorySummariesCase;
