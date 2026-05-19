/**
 * Notification framework types. Trigger-agnostic by design — SessionStart is
 * the first delivery channel but the same Notification shape can be enqueued
 * from any code path (e.g. capture pipeline emitting a "summarization due"
 * nudge) and drained at the next available hook.
 */

import type { Credentials } from "../commands/auth-creds.js";

export type Severity = "info" | "warn" | "error";

export type Trigger = "session_start" | "ad_hoc";

export interface Notification {
  /** Stable identifier — e.g. "welcome", "summarization-due". */
  id: string;
  /** Default "info" if omitted by the rule. */
  severity?: Severity;
  /** Single line, ≤80 chars. */
  title: string;
  /** 1-3 plain-text lines, agent-readable. */
  body: string;
  /**
   * Identity used by dedup state. Two notifications with the same `id` but
   * different `dedupKey` will both fire (e.g. version-upgrade-0.7.5 today vs
   * version-upgrade-0.7.6 tomorrow). State stores `{ id → JSON.stringify(dedupKey) }`.
   */
  dedupKey: Record<string, unknown>;
  /**
   * When true, the drain shows the notification but does NOT record it in
   * `state.shown`. Use for self-clearing error notifications where the
   * enqueue itself is the rate limit — e.g. a 402 from the SDK keeps
   * enqueuing while the error persists, and once it's resolved no fresh
   * enqueue happens. State.shown would block the second-session refire.
   *
   * Default (omitted/false) keeps the existing dedup-across-sessions
   * behavior used by welcome, savings recap, backend pushes, etc.
   */
  transient?: boolean;
}

export interface NotificationContext {
  agent: Agent;
  creds: Credentials | null;
  /** What dedup state already records as shown. Read-only inside rules. */
  state: NotificationsState;
  /**
   * Count of skills already mined locally by `hivemind skillify mine-local`.
   * Filled in by the hook entry point before drain (rules stay pure). Null
   * when the manifest is absent or malformed; 0 when present but empty.
   */
  localSkillsCount?: number | null;
}

export interface Rule {
  id: string;
  trigger: Trigger;
  /** Return null to skip, or a Notification to fire. Must be pure (no IO). */
  evaluate(ctx: NotificationContext): Notification | null;
}

// Today the framework only delivers to Claude Code. Other agents (Codex,
// Cursor, Hermes, Pi, openclaw) will be added one at a time as we wire
// real per-agent adapters — the union grows + a new file lands in
// src/notifications/delivery/. AGENT_CHANNELS.md preserves the research
// on each agent's harness behavior as a forward reference.
export type Agent = "claude-code";

export interface NotificationsState {
  /** id → { dedupKey JSON, ISO timestamp shown }. */
  shown: Record<string, { dedupKey: string; shownAt: string }>;
}

export interface NotificationsQueue {
  queue: Notification[];
}
