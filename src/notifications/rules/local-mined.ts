/**
 * Surfaces locally-mined skills to fresh, not-signed-in users — the
 * user-visible half of the "wow effect" pair. The not-logged-in branch of
 * session-start.ts already injects the count into `additionalContext` so
 * the MODEL sees it; this rule turns the same info into a `systemMessage`
 * so the USER sees it in their terminal too, exactly like the welcome
 * line shown right after `hivemind login`.
 *
 * Suppression: stays silent once creds are present (logged-in users see
 * the welcome rule instead) or when the manifest is absent / empty.
 *
 * Dedup: keyed on the integer count so the message re-fires the next time
 * the worker adds new skills (e.g. user re-runs mine-local after coding
 * in new projects).
 */

import type { Rule } from "../types.js";

export const localMinedRule: Rule = {
  id: "local-mined-surfaced",
  trigger: "session_start",
  evaluate({ creds, localSkillsCount }) {
    if (creds?.token) return null;
    if (typeof localSkillsCount !== "number" || localSkillsCount <= 0) return null;
    const noun = localSkillsCount === 1 ? "skill" : "skills";
    return {
      id: "local-mined-surfaced",
      severity: "info",
      title: `🎉 ${localSkillsCount} ${noun} mined from your local sessions`,
      body: `Run 'hivemind login' to share new mining results with your team.`,
      dedupKey: { count: localSkillsCount },
    };
  },
};
