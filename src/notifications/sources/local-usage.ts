/**
 * Savings recap source — renders the "Hivemind has saved you/your team ~Zk
 * tokens" notification at every session start. Two modes:
 *
 *   - Online: when GET /me/hivemind-stats returns data, the banner aggregates
 *     across every org the caller belongs to (cross-machine, multi-user).
 *     Personal contribution is shown as a secondary line. Threshold:
 *     `user.memory_recall_count >= MIN_PERSONAL_RECALLS` so a brand-new joiner
 *     doesn't see "your team saved 5M tokens" before they've used hivemind
 *     themselves.
 *
 *   - Offline: when the endpoint is unreachable / unauthenticated / empty,
 *     fall back to `~/.deeplake/usage-stats.jsonl` (per-machine, all-time).
 *     Threshold: `records.length >= MIN_LOCAL_RECORDS` so the displayed
 *     number is substantive rather than rounding-error.
 *
 * Formula (both modes — see plan + docs/FAQ for derivation):
 *
 *   Y = memorySearchBytes / 4               tokens (what hivemind delivered)
 *   X = 1.7 · Y                             tokens (counterfactual w/o hivemind)
 *   Z = X − Y = 0.7 · Y                     tokens saved
 *
 * The 1.7× multiplier is the published LoCoMo benchmark ratio
 * (deeplake.ai/hivemind — 1,008 vs 1,700 tokens / Q, Claude Haiku via
 * `claude -p`, hybrid lexical + semantic retrieval). The 4-bytes/token
 * conversion is the BPE rule-of-thumb; `~` in the rendered headline
 * signals approximation.
 *
 * Cadence: every session. dedupKey = `{session: sessionId}` so the two
 * parallel SessionStart hook registrations (settings.json + marketplace
 * hooks.json) dedupe to a single emission per real session, but each NEW
 * session re-fires with updated numbers.
 *
 * Failure mode: any read or parse error falls back to "no notifications" —
 * the SessionStart hook continues unaffected.
 */

import type { Credentials } from "../../commands/auth-creds.js";
import type { Notification } from "../types.js";
import { fetchOrgStats, type OrgStats } from "./org-stats.js";
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

/** Online-mode threshold: minimum personal memory-recall events before the
 *  team-wide banner fires. Below this, the "you contributed ~X saved" line
 *  reads as zero/trivial, and the team-savings headline lands as marketing
 *  rather than a community report. 5 recalls = the user has personally
 *  triggered hivemind a handful of times. */
const MIN_PERSONAL_RECALLS = 5;

/** Offline-mode threshold (default): minimum local records with memory
 *  activity before falling-back banner fires. The unit is records-with-
 *  memory-activity (strict subset of total sessions), so 20 maps to a
 *  day or two of real use for moderate users. */
function minLocalRecordsForRecap(): number {
  const raw = process.env.HIVEMIND_NOTIFICATIONS_MIN_SESSIONS;
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return 20;
}

/** 1234 → "1.2k", 12345 → "12.3k", 1234567 → "1.2M". Caller prepends `~`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/** Plain integer commafier: 42000 → "42,000". Used in the body line. */
function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function bytesToSavedTokens(bytes: number): number {
  const y = bytes / BYTES_PER_TOKEN;
  return (SAVINGS_MULTIPLIER - 1) * y;
}

/**
 * Compute the savings recap notification (if any) for a SessionStart drain.
 * Fetches org stats first; if the server reports the caller has met the
 * personal-recall threshold, renders the team-wide banner. Otherwise
 * falls back to the local jsonl recap.
 *
 * Async (unlike the previous synchronous version) because the server call
 * is now part of the source. The fetch is fail-soft (returns null on
 * any error/timeout) and the offline branch is identical to the prior
 * behavior — so the failure surface didn't grow.
 */
export async function fetchLocalUsageNotifications(
  sessionId: string | undefined,
  creds: Credentials | null | undefined,
): Promise<Notification[]> {
  if (!sessionId) {
    // Without a stable per-session dedupKey, we can't safely dedupe across
    // the two parallel hook registrations — better to render nothing.
    return [];
  }

  const userName = creds?.userName;
  // Try server-side org/user aggregate first. Returns null on
  // unauthenticated / unreachable / malformed.
  const orgStats = await fetchOrgStats(creds ?? null);
  if (orgStats && orgStats.user.memoryRecallCount >= MIN_PERSONAL_RECALLS) {
    return renderOnlineRecap(sessionId, orgStats, userName);
  }
  if (orgStats) {
    log(`server stats present but personal recalls ${orgStats.user.memoryRecallCount} < ${MIN_PERSONAL_RECALLS} — falling through to local`);
  }
  return renderOfflineRecap(sessionId, userName);
}

/** "Hivemind has saved your team ~5.2M tokens / 42,000 memory recalls
 *  across 187 sessions · you contributed ~140k saved" */
function renderOnlineRecap(
  sessionId: string,
  s: OrgStats,
  userName: string | undefined,
): Notification[] {
  const zOrg = bytesToSavedTokens(s.org.memorySearchBytes);
  const zUser = bytesToSavedTokens(s.user.memorySearchBytes);

  const title = `Hivemind has saved your team ~${formatTokens(zOrg)} tokens`;
  const segments = [
    `${formatCount(s.org.memoryRecallCount)} memory ${s.org.memoryRecallCount === 1 ? "recall" : "recalls"}`,
    `across ${formatCount(s.org.sessionsCount)} ${s.org.sessionsCount === 1 ? "session" : "sessions"}`,
    `you contributed ~${formatTokens(zUser)} saved`,
  ];
  // Skills the user has generated across all their projects — purely local
  // count. Append when non-zero to keep the cross-machine banner connected
  // to the user's own machine without leaking that this is a hybrid render.
  const skillsGenerated = countUserGeneratedSkills(userName);
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
      // Bump dedupKey shape so a switch from offline → online (or vice
      // versa) on the same session doesn't suppress the new mode's
      // emission via stale state from the prior session.
      dedupKey: { session: sessionId, mode: "online" },
    },
  ];
}

/** Local-only fallback: "Hivemind has saved you ~12.9k tokens / 14 sessions ·
 *  63 memory searches · 2 skills generated" */
function renderOfflineRecap(
  sessionId: string,
  userName: string | undefined,
): Notification[] {
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

  const minRecords = minLocalRecordsForRecap();
  if (records.length < minRecords) {
    log(`only ${records.length} records, threshold is ${minRecords} — skipping recap`);
    return [];
  }

  const memorySearchBytes = sumMetric(records, "memorySearchBytes");
  if (memorySearchBytes <= 0) {
    log("memorySearchBytes total is 0 — skipping recap");
    return [];
  }

  const zTokens = bytesToSavedTokens(memorySearchBytes);
  const sessionCount = records.length;
  const memorySearches = sumMetric(records, "memorySearchCount");
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
      dedupKey: { session: sessionId, mode: "offline" },
    },
  ];
}
