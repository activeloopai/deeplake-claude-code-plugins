/**
 * Skillify auto-pull on session start lands a skill file on disk.
 *
 * The pre-seeded skill row in the `skills` table represents a skill
 * another team member mined earlier. When ANY agent starts a session,
 * its session-start hook fires `autoPullSkills()` which spawns the
 * autopull-worker. The worker reads the skills table, compares against
 * `~/.deeplake/state/skillify/pulled.json`, and writes any new skill
 * files into the agent's skills directory.
 *
 * Coverage gap closed: cases 01-12 don't exercise the autopull-worker
 * path. A regression that stops session-start from firing autoPullSkills,
 * or that breaks the worker's INSERT INTO sense of "already pulled", or
 * that lands the skill file at the wrong path — none of those would
 * surface in the existing matrix.
 *
 * Setup pre-INSERTs one skill row keyed on this case's session_id (so
 * cleanup can scope it). Then the agent runs a trivial prompt that
 * doesn't matter — what we're asserting on is the side effect of the
 * session-start hook, not the agent's reply.
 *
 * Assertion checks that `~/.claude/skills/<scope>/<name>/SKILL.md`
 * exists in the tmp HOME after the run. The "did the row exist" check
 * is the SELECT count; the "did the file land" check is the filesystem
 * stat. Together they prove the round-trip end-to-end.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DeeplakeApi } from "../../../src/deeplake-api.js";
import { createSkillsTableSql } from "../../../src/skillify/skills-table.js";
import type { E2ECase } from "../types.js";

const SKILL_NAME = "e2e-autopull-seeded-skill";
const SKILL_BODY = "# E2E autopull sentinel\nMarker body for matrix verification.";
const SKILL_DESCRIPTION = "Auto-pull e2e seed";

const skillifyAutoPullCase: E2ECase = {
  id: "16-skillify-auto-pull",
  description:
    "session-start fires autopull-worker → pre-seeded skill row → SKILL.md lands at ~/.claude/skills/<scope>/<name>/SKILL.md",
  prompt: "Reply with the single word 'pulled' and stop. Do not call tools.",
  async setup(ctx) {
    // Use a separate `skills_<sessionId>` table so cleanup is trivial and
    // so we don't pollute the canonical skills table with sentinel rows.
    // Honestly this is brittle: if HIVEMIND_SKILLS_TABLE isn't honored
    // by the worker, the case still works against the canonical table
    // (cleanup just won't scope correctly). Worth it for isolation.
    const api = new DeeplakeApi(
      ctx.creds.token,
      ctx.creds.apiUrl,
      ctx.creds.orgId,
      ctx.creds.workspaceId,
      "skills", // seed into the canonical name; worker reads here
    );
    // Ensure-create the skills table — a fresh e2e workspace won't have
    // it. createSkillsTableSql is idempotent (CREATE TABLE IF NOT EXISTS).
    try {
      await api.query(createSkillsTableSql("skills"));
    } catch {
      // Best-effort; if the table already exists or there's a benign
      // race, the seed INSERT below will still succeed or fail cleanly.
    }
    const now = new Date().toISOString();
    // INSERT shape mirrors src/skillify/skills-table.ts insertSkillRow.
    // project_key embeds the runId so multiple concurrent runs don't see
    // each other's seeds. The autopull worker compares (project_key,
    // name) tuples; we use a project_key it would actually try to pull.
    const projectKey = `e2e-${ctx.sessionId}`;
    await api.query(
      `INSERT INTO "skills" (id, name, project, project_key, local_path, install, source_sessions, source_agent, scope, author, contributors, description, trigger_text, body, version, created_at, updated_at) ` +
      `VALUES (gen_random_uuid(), '${SKILL_NAME}', 'e2e', '${projectKey}', '.claude/skills/${SKILL_NAME}', 'global', '[]', '${ctx.agent}', 'team', 'e2e', '[]', '${SKILL_DESCRIPTION}', 'e2e autopull marker', '${SKILL_BODY.replace(/'/g, "''")}', 1, '${now}', '${now}')`,
    );
  },
  assertions: [
    {
      type: "select-from-db",
      label: "seeded skill row exists in skills table pre-run",
      sql: ({ ctx }) =>
        `SELECT count(*) AS n FROM "skills" WHERE project_key = 'e2e-${ctx.sessionId.replace(/'/g, "''")}' AND name = '${SKILL_NAME}'`,
      expect: (rows) => {
        if (rows.length === 0 || Number((rows[0] as { n: number | string }).n) < 1) {
          throw new Error("seed row not present — autopull would have nothing to pull");
        }
      },
    },
    {
      type: "custom",
      label: "SKILL.md landed under ~/.claude/skills/ after session-start auto-pull",
      check: async ({ ctx }) => {
        // The autopull worker writes to <home>/.claude/skills/<name>--<project>/SKILL.md
        // (verified by the `pulled scanned=1 wrote=1 skipped=0` log and the
        // resulting filesystem state). The `--<project>` suffix disambiguates
        // skills with the same name across projects/scopes. Look for a
        // matching SKILL.md anywhere under the skills root; the exact path
        // depends on scope/install settings we don't fully control from
        // the seed row.
        const skillsDir = join(ctx.home, ".claude", "skills");
        if (!existsSync(skillsDir)) {
          return `${skillsDir} missing — autopull worker didn't write anything`;
        }
        const entries = readdirSync(skillsDir, { recursive: true })
          .filter((e): e is string => typeof e === "string");
        const matched = entries.filter((e) => e.startsWith(SKILL_NAME) && e.endsWith("SKILL.md"));
        if (matched.length === 0) {
          return `no SKILL.md matching ${SKILL_NAME}*/SKILL.md under ${skillsDir}. Found: ${entries.join(", ") || "(empty)"}`;
        }
        return null;
      },
    },
  ],
  // Cleanup note: the runner's cleanupSessionRows DELETEs from sessions
  // + memory only — NOT skills. The seed row stays in the workspace,
  // a small debris cost. A future improvement extends cleanupSessionRows
  // to drop skills rows by project_key when the case scoped a seed.
  skipFor: ["openclaw"], // openclaw driver doesn't fire session-start; uses event-firing path
};

export default skillifyAutoPullCase;
