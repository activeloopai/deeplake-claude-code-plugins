/**
 * Local usage source — renders the "Hivemind has saved you ~Zk tokens"
 * notification at every session start, based on cumulative memory-search
 * activity recorded in `~/.deeplake/usage-stats.jsonl`.
 *
 * Formula (kept deliberately plain — see plan + docs/FAQ for derivation):
 *
 *   Y = sum(memorySearchBytes across all records) / 4         tokens
 *   X = 1.7 · Y                              tokens (counterfactual w/o hivemind)
 *   Z = X − Y = 0.7 · Y                      tokens saved
 *
 * The 1.7× multiplier is the published LoCoMo benchmark ratio
 * (deeplake.ai/hivemind — 1,008 vs 1,700 tokens / Q, Claude Haiku via
 * `claude -p`, hybrid lexical + semantic retrieval). The 4-bytes/token
 * conversion is the standard BPE rule-of-thumb; we signal approximation
 * with `~` in the rendered headline.
 *
 * Cadence: every session, NOT weekly. dedupKey = `{session: sessionId}`
 * so the two parallel SessionStart hook registrations (settings.json +
 * marketplace hooks.json) dedupe to a single emission per real session,
 * but each NEW session re-fires with updated numbers.
 *
 * Skip conditions (silently — empty list returned):
 *   - no records at all (first install)
 *   - `Y_total == 0` (records exist but no memory was searched)
 *   - sessionId is missing (can't form a stable dedupKey)
 *
 * Failure mode: any read or parse error falls back to "no notifications"
 * — the SessionStart hook continues unaffected.
 */

import type { Notification } from "../types.js";
import { countUserGeneratedSkills, readUsageRecords, sumMetric } from "../usage-tracker.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("notifications-local-usage", msg);

/** Industry rule-of-thumb conversion for BPE tokenizers (Claude/GPT). */
const BYTES_PER_TOKEN = 4;

/** Published LoCoMo benchmark ratio: claude -p with hivemind uses 1/1.7 of
 *  the tokens vs without hivemind on the same QA task. We use this ratio
 *  to estimate the "would-have-spent" tokens for context that hivemind
 *  actually delivered. See plan + docs/FAQ. */
const SAVINGS_MULTIPLIER = 1.7;

/** Minimum cumulative session count before the savings recap is shown.
 *  Below this, the number reads as a rounding error and the banner is
 *  premature ("Hivemind has saved you ~200 tokens"). With Activeloop's
 *  typical 100-1000 sessions/day usage, 100 fires within a day or two
 *  of real use — late enough that the displayed savings number is
 *  substantive, soon enough that users don't wait weeks.
 *
 *  Overridable via `HIVEMIND_NOTIFICATIONS_MIN_SESSIONS` env var for
 *  testing + power-user tuning. Non-integer / non-positive values fall
 *  back to the production default. */
function minSessionsForRecap(): number {
  const raw = process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return 100;
}

/** 1234 → "1.2k", 12345 → "12.3k", 1234567 → "1.2M". Caller prepends `~`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * Synchronously compute the savings recap notification (if any) for a
 * SessionStart drain. Pure — reads the local stats file, no network, no
 * writes. Returns [] when there's nothing meaningful to claim.
 */
export function fetchLocalUsageNotifications(sessionId: string | undefined, userName: string | undefined): Notification[] {
  if (!sessionId) {
    // Without a stable per-session dedupKey, we can't safely dedupe across
    // the two parallel hook registrations — better to render nothing.
    return [];
  }

  let records;
  try {
    records = readUsageRecords();
  } catch (e: any) {
    log(`readUsageRecords threw: ${e?.message ?? String(e)}`);
    return [];
  }

  if (records.length === 0) {
    log("no usage records yet — skipping recap");
    return [];
  }

  const minSessions = minSessionsForRecap();
  if (records.length < minSessions) {
    log(`only ${records.length} sessions, threshold is ${minSessions} — skipping recap`);
    return [];
  }

  const memorySearchBytes = sumMetric(records, "memorySearchBytes");
  if (memorySearchBytes <= 0) {
    log("memorySearchBytes total is 0 — skipping recap");
    return [];
  }

  // X − Y = Z where Y = bytes/4, X = 1.7Y, so Z = 0.7Y.
  const yTokens = memorySearchBytes / BYTES_PER_TOKEN;
  const zTokens = (SAVINGS_MULTIPLIER - 1) * yTokens;

  const sessionCount = records.length;
  const memorySearches = sumMetric(records, "memorySearchCount");
  // Skills the user has generated across all their projects — purely local
  // count from ~/.deeplake/state/skillify/<projectKey>.json. Omitted from
  // the body when 0 to avoid a "0 skills generated" indictment on fresh
  // installs (same rationale as skipping the whole recap when Y is 0).
  const skillsGenerated = countUserGeneratedSkills(userName);

  const title = `Hivemind has saved you ~${formatTokens(zTokens)} tokens`;
  const segments = [
    `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`,
    `${memorySearches} memory ${memorySearches === 1 ? "search" : "searches"}`,
  ];
  if (skillsGenerated > 0) {
    segments.push(`${skillsGenerated} ${skillsGenerated === 1 ? "skill" : "skills"} generated`);
  }
  const body = `   ${segments.join(" · ")}`;

  return [
    {
      id: "local-usage:savings-recap",
      severity: "info",
      title,
      body,
      // dedupKey on sessionId: same session's parallel hook fires dedupe;
      // new sessions get fresh numbers.
      dedupKey: { session: sessionId },
    },
  ];
}
