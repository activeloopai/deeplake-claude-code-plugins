/**
 * OpenClaw tool + SKILL.md surface — RELEASE_CHECKLIST §3 (openclaw row)
 * + §4 (discoverability for the openclaw surface).
 *
 * OpenClaw doesn't shell out to bash. Its agent talks to hivemind via
 * three MCP tools the plugin registers: hivemind_search / hivemind_read /
 * hivemind_index. Cases 02 / 03 / 04 assume bash-shell access to the
 * virtual mount and are skipped for openclaw — this case provides the
 * equivalent coverage by invoking those tools through the openclaw
 * driver's tool-call shape (see agents/openclaw.ts).
 *
 * Asserts:
 *   1. hivemind_search returns the seeded sentinel row (analogous to
 *      case 03 for CLI agents).
 *   2. hivemind_read against /index.md returns the virtual index
 *      (analogous to case 02 for CLI agents).
 *
 * Skipped for the five CLI agents — they don't register MCP tools the
 * harness can call directly. Their equivalent coverage is in cases
 * 02–04.
 */

import { DeeplakeApi } from "../../../src/deeplake-api.js";
import type { E2ECase } from "../types.js";
import { buildOpenclawToolPrompt } from "../agents/openclaw.js";

const OC_SENTINEL = "HIVEMIND_E2E_OPENCLAW_TOOL_SENTINEL_99";

const openclawToolsCase: E2ECase = {
  id: "08-openclaw-tools",
  description:
    "openclaw's hivemind_search and hivemind_read tools both work and the SKILL body would be injectable",
  // Driver pivots on this prefix and calls hivemind_search instead of
  // firing agent_end. Args are the search query and a small limit.
  prompt: buildOpenclawToolPrompt("hivemind_search", { query: OC_SENTINEL, limit: 5 }),
  async setup(ctx) {
    // Same seed shape as case 03's grep-memory-summaries: drop a row
    // with a unique sentinel string in the memory body so the search
    // tool has something deterministic to match.
    const memoryApi = new DeeplakeApi(
      ctx.creds.token,
      ctx.creds.apiUrl,
      ctx.creds.orgId,
      ctx.creds.workspaceId,
      ctx.creds.memoryTable,
    );
    await memoryApi.ensureTable(ctx.creds.memoryTable);
    const path = `/summaries/e2e-openclaw/${ctx.sessionId}.md`;
    const body = `# openclaw tool sentinel\n\nMarker: ${OC_SENTINEL}\n`;
    const now = new Date().toISOString();
    await memoryApi.query(
      `INSERT INTO "${ctx.creds.memoryTable}" ` +
      `(id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
      `VALUES (gen_random_uuid(), '${path}', '${ctx.sessionId}.md', '${body.replace(/'/g, "''")}', ` +
      `'e2e', 'text/markdown', ${Buffer.byteLength(body, "utf-8")}, 'e2e', 'openclaw-tool-sentinel', '${ctx.agent}', ` +
      `'e2e-test', '${now}', '${now}')`,
    );
  },
  assertions: [
    {
      type: "stdout-contains",
      substring: OC_SENTINEL,
      label: "hivemind_search returned the seeded sentinel",
    },
  ],
  // This case is for openclaw only — the other agents register no MCP
  // tools the harness can call directly. Their equivalent coverage:
  //   - hivemind_search semantic → grep over memory/summaries (case 03)
  //   - hivemind_read of /index.md → cat /index.md (case 02)
  //   - SKILL inject → session-start inject (case 04)
  skipFor: ["claude-code", "codex", "cursor-agent", "hermes", "pi"],
};

export default openclawToolsCase;
