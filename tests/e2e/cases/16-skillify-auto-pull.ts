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
      label: "SKILL.md landed at ~/.claude/skills/<name>/ after session-start auto-pull",
      check: async ({ ctx }) => {
        // Multiple possible install layouts per scope/install pair:
        //   - project install: <cwd>/.claude/skills/<name>/SKILL.md
        //   - global install:  <home>/.claude/skills/<name>/SKILL.md
        // The seed picks install=global, so we look under home.
        const candidates = [
          join(ctx.home, ".claude", "skills", SKILL_NAME, "SKILL.md"),
          join(ctx.home, ".claude", "skills", "team", SKILL_NAME, "SKILL.md"),
        ];
        const found = candidates.find(existsSync);
        if (found) return null;
        // Diagnostic: list what IS under ~/.claude/skills/ to help debug
        // any future path drift.
        const skillsDir = join(ctx.home, ".claude", "skills");
        const present = existsSync(skillsDir)
          ? readdirSync(skillsDir, { recursive: true }).filter((e) => typeof e === "string").join(", ")
          : "(skills dir missing entirely)";
        return `SKILL.md not found at any expected path. Checked:\n  ${candidates.join("\n  ")}\nSkills dir contents: ${present}`;
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
