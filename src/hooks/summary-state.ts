/**
 * Sidecar state for periodic summary triggering.
 *
 * File: ~/.claude/hooks/summary-state/<session_id>.json
 *   { lastSummaryAt: epoch_ms, lastSummaryCount: number, totalCount: number }
 *
 * Never deleted (so --resume picks up where it left off).
 * All mutations go through withRmwLock so concurrent processes don't lose updates.
 */

import {
  readFileSync, writeFileSync, writeSync, mkdirSync, renameSync,
  existsSync, unlinkSync, openSync, closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SummaryState {
  lastSummaryAt: number;
  lastSummaryCount: number;
  totalCount: number;
}

const STATE_DIR = join(homedir(), ".claude", "hooks", "summary-state");
const YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));

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

export function withRmwLock<T>(sessionId: string, fn: () => T): T {
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
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(rmwLock); } catch { /* ignore */ }
  }
}

export function bumpTotalCount(sessionId: string): SummaryState {
  return withRmwLock(sessionId, () => {
    const now = Date.now();
    const existing = readState(sessionId);
    const next: SummaryState = existing
      ? { ...existing, totalCount: existing.totalCount + 1 }
      : { lastSummaryAt: now, lastSummaryCount: 0, totalCount: 1 };
    writeState(sessionId, next);
    return next;
  });
}

export function finalizeSummary(sessionId: string, jsonlLines: number): void {
  withRmwLock(sessionId, () => {
    const prev = readState(sessionId);
    writeState(sessionId, {
      lastSummaryAt: Date.now(),
      lastSummaryCount: jsonlLines,
      totalCount: Math.max(prev?.totalCount ?? 0, jsonlLines),
    });
  });
}

export interface TriggerConfig {
  everyNMessages: number;
  everyHours: number;
}

export function loadTriggerConfig(): TriggerConfig {
  const n = Number(process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS ?? "");
  const h = Number(process.env.HIVEMIND_SUMMARY_EVERY_HOURS ?? "");
  return {
    everyNMessages: Number.isInteger(n) && n > 0 ? n : 30,
    everyHours: Number.isFinite(h) && h > 0 ? h : 1,
  };
}

export function shouldTrigger(state: SummaryState, cfg: TriggerConfig, now = Date.now()): boolean {
  const msgsSince = state.totalCount - state.lastSummaryCount;
  if (msgsSince >= cfg.everyNMessages) return true;
  if (msgsSince > 0 && now - state.lastSummaryAt >= cfg.everyHours * 3600 * 1000) return true;
  return false;
}

export function tryAcquireLock(sessionId: string, maxAgeMs = 10 * 60 * 1000): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = lockPath(sessionId);
  if (existsSync(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs) return false;
    } catch { /* treat unreadable as stale */ }
    try { unlinkSync(p); } catch { return false; }
  }
  try {
    const fd = openSync(p, "wx");
    try { writeSync(fd, String(Date.now())); } finally { closeSync(fd); }
    return true;
  } catch (e: any) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

export function releaseLock(sessionId: string): void {
  try {
    unlinkSync(lockPath(sessionId));
  } catch { /* ignore */ }
}
