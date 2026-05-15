/**
 * Public API for the notifications framework.
 *
 * Two production code paths use this module:
 *   1. The hook entry point (e.g. src/hooks/session-notifications.ts) calls
 *      drainSessionStart() once per session start.
 *   2. Any code path can call enqueueNotification() at any time to push
 *      a notification onto the persistent queue, drained at the next session.
 *
 * Rule registration (registerRule) currently happens at module-load time
 * inside drainSessionStart's caller — see hooks/session-notifications.ts.
 * Rules are pure (no IO) so a cold registry-evaluation has zero side effects
 * if no rule fires.
 */

import type { Credentials } from "../commands/auth-creds.js";
import type { Agent, Notification, NotificationContext } from "./types.js";
import { evaluateRules } from "./rules/registry.js";
import { readQueue, writeQueue } from "./queue.js";
import { readState, writeState, alreadyShown, markShown, tryClaim } from "./state.js";
import { renderNotifications } from "./format.js";
import { emit } from "./delivery/index.js";
import { fetchBackendNotifications } from "./sources/backend.js";
import { fetchLocalUsageNotifications } from "./sources/local-usage.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("notifications", msg);

export type { Notification, Rule, Trigger, Severity, NotificationContext, NotificationsState, NotificationsQueue, Agent } from "./types.js";
export { registerRule, listRules, _resetRulesForTest } from "./rules/registry.js";
export { enqueueNotification } from "./queue.js";

export interface DrainOptions {
  agent: Agent;
  creds: Credentials | null;
  /** Claude Code session_id from the hook stdin. Used as the dedupKey
   *  basis for the per-session savings recap so the same session's two
   *  parallel hook invocations dedupe to one emission. */
  sessionId?: string;
}

/**
 * Evaluate all session_start rules + drain the queue, dedup, render, deliver,
 * and persist updated state.
 *
 * Concurrency note: the SessionStart hook is registered in BOTH
 * ~/.claude/settings.json and the marketplace hooks.json, so two node
 * processes can race this function. State dedup (`alreadyShown`) protects
 * against duplicate emission ONLY if one process completes its write
 * before the other reads — not guaranteed. We additionally call
 * `tryClaim()` per notification: an atomic O_CREAT|O_EXCL on a claim file
 * for each (id, dedupKey) pair. First process wins, second skips.
 *
 * Failures are caught and logged — never thrown. A broken notifications
 * pipeline must not abort the SessionStart hook process (the existing
 * memory/hivemind block emit must still happen from the sibling hook).
 */
export async function drainSessionStart(opts: DrainOptions): Promise<void> {
  try {
    const state = readState();
    const queue = readQueue();
    const ctx: NotificationContext = { agent: opts.agent, creds: opts.creds, state };

    const fromRules = evaluateRules("session_start", ctx);
    const fromQueue = queue.queue;
    // Backend fetch is fail-soft (returns [] on error/timeout) — its
    // failure must not abort the rules + queue path.
    const fromBackend = await fetchBackendNotifications(opts.creds);
    // Local-usage source: synchronous, reads ~/.deeplake/usage-stats.jsonl
    // to render the cumulative savings recap. Returns [] when sessionId
    // is missing OR there's no memory-search activity to claim.
    const fromLocalUsage = fetchLocalUsageNotifications(opts.sessionId, opts.creds?.userName);
    const all: Notification[] = [...fromRules, ...fromQueue, ...fromBackend, ...fromLocalUsage];

    const fresh = all.filter(n => !alreadyShown(state, n));
    if (fresh.length === 0) {
      // Still drain queue items that were already shown so they don't pile up.
      if (queue.queue.length > 0) writeQueue({ queue: [] });
      return;
    }

    // Per-notification atomic claim — prevents two concurrent SessionStart
    // hook invocations (settings.json + marketplace hooks.json both fire)
    // from emitting the same notification twice. See state.ts:tryClaim.
    const claimed = fresh.filter(n => tryClaim(n));
    if (claimed.length === 0) {
      if (queue.queue.length > 0) writeQueue({ queue: [] });
      log(`all ${fresh.length} notification(s) claimed by another process`);
      return;
    }

    const rendered = renderNotifications(claimed);
    emit(opts.agent, rendered);

    let nextState = state;
    for (const n of claimed) nextState = markShown(nextState, n);
    writeState(nextState);

    // Queue is fully drained whether or not its items were dedup-skipped:
    // they've been read once. If a producer needs to re-enqueue, it re-pushes.
    if (queue.queue.length > 0) writeQueue({ queue: [] });

    log(`delivered ${claimed.length} notification(s) to ${opts.agent}`);
  } catch (e: any) {
    log(`drainSessionStart failed: ${e?.message ?? String(e)}`);
  }
}
