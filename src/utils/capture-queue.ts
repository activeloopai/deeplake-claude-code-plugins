/**
 * Local capture queue — appends session events to a local JSONL file
 * instead of making HTTP calls. Events are flushed to cloud at session end.
 *
 * Queue file: ~/.deeplake/capture/<sessionId>.jsonl
 * One line per event, each line is a JSON object.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const QUEUE_DIR = join(homedir(), ".deeplake", "capture");

/** Ensure the queue directory exists. */
function ensureDir(): void {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

/** Get the queue file path for a session. */
export function queuePath(sessionId: string): string {
  return join(QUEUE_DIR, `${sessionId}.jsonl`);
}

/** Append a single event to the session's local queue. Pure filesystem, no network. */
export function appendEvent(sessionId: string, event: Record<string, unknown>): void {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  appendFileSync(queuePath(sessionId), line);
}

/** Read all events from a session's local queue. Returns empty array if no file. */
export function readEvents(sessionId: string): Record<string, unknown>[] {
  const path = queuePath(sessionId);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map(line => JSON.parse(line));
}

/** Read raw JSONL content from a session's local queue. */
export function readRawJsonl(sessionId: string): string {
  const path = queuePath(sessionId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8").trim();
}

/** Delete the queue file after successful flush. */
export function deleteQueue(sessionId: string): void {
  const path = queuePath(sessionId);
  try { unlinkSync(path); } catch { /* ignore */ }
}

/** Return the queue directory path (for cleanup/listing). */
export function getQueueDir(): string {
  return QUEUE_DIR;
}
