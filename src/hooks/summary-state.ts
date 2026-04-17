/**
 * Sidecar state for periodic summary triggering.
 *
 * File: ~/.claude/hooks/summary-state/<session_id>.json
 *   { lastSummaryAt: epoch_ms, lastSummaryCount: number, totalCount: number }
 *
 * - capture.ts increments `totalCount` on each event.
 * - wiki-worker.ts updates `lastSummaryAt` and `lastSummaryCount` on success.
 * - Never deleted (so --resume picks up where it left off).
 *
 * Concurrency: tempfile + rename for atomic writes. A rare worker/capture race
 * can drop a single increment — acceptable at threshold ~150.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SummaryState {
  lastSummaryAt: number;
  lastSummaryCount: number;
  totalCount: number;
}

const STATE_DIR = join(homedir(), ".claude", "hooks", "summary-state");

export function statePath(sessionId: string): string {
  return join(STATE_DIR, `${sessionId}.json`);
}

export function lockPath(sessionId: string): string {
  return join(STATE_DIR, `${sessionId}.lock`);
}

export function readState(sessionId: string): SummaryState | null {
  const p = statePath(sessionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SummaryState;
  } catch {
    return null;
  }
}

export function writeState(sessionId: string, state: SummaryState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = statePath(sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}

export function bumpTotalCount(sessionId: string): SummaryState {
  mkdirSync(STATE_DIR, { recursive: true });
  const rmwLock = statePath(sessionId) + ".rmw";
  const deadline = Date.now() + 2000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(rmwLock, "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        try { unlinkSync(rmwLock); } catch { /* ignore */ }
        continue;
      }
    }
  }
  try {
    const now = Date.now();
    const existing = readState(sessionId);
    const next: SummaryState = existing
      ? { ...existing, totalCount: existing.totalCount + 1 }
      : { lastSummaryAt: now, lastSummaryCount: 0, totalCount: 1 };
    writeState(sessionId, next);
    return next;
  } finally {
    closeSync(fd);
    try { unlinkSync(rmwLock); } catch { /* ignore */ }
  }
}

export interface TriggerConfig {
  everyNMessages: number;
  everyHours: number;
}

export function loadTriggerConfig(): TriggerConfig {
  const n = Number(process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS ?? "");
  const h = Number(process.env.HIVEMIND_SUMMARY_EVERY_HOURS ?? "");
  return {
    everyNMessages: Number.isInteger(n) && n > 0 ? n : 150,
    everyHours: Number.isFinite(h) && h > 0 ? h : 4,
  };
}

export function shouldTrigger(state: SummaryState, cfg: TriggerConfig, now = Date.now()): boolean {
  const msgsSince = state.totalCount - state.lastSummaryCount;
  if (msgsSince >= cfg.everyNMessages) return true;
  if (msgsSince > 0 && now - state.lastSummaryAt >= cfg.everyHours * 3600 * 1000) return true;
  return false;
}

/** Best-effort lock: if the lockfile exists and is recent, another worker is running. */
export function tryAcquireLock(sessionId: string, maxAgeMs = 10 * 60 * 1000): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = lockPath(sessionId);
  if (existsSync(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs) return false;
    } catch { /* fall through and overwrite stale lock */ }
  }
  writeFileSync(p, String(Date.now()));
  return true;
}

export function releaseLock(sessionId: string): void {
  try {
    unlinkSync(lockPath(sessionId));
  } catch { /* ignore */ }
}
