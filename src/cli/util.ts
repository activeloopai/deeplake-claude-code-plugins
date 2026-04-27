import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const HOME = homedir();

export function pkgRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function ensureDir(path: string, mode: number = 0o755): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
}

export function copyDir(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true, force: true, dereference: false });
}

export function symlinkForce(target: string, link: string): void {
  ensureDir(dirname(link));
  if (existsSync(link) || isLink(link)) unlinkSync(link);
  symlinkSync(target, link);
}

export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export function readJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

export function writeJson(path: string, obj: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function writeVersionStamp(dir: string, version: string): void {
  ensureDir(dir);
  writeFileSync(join(dir, ".hivemind_version"), version);
}

export function readVersionStamp(dir: string): string | null {
  const p = join(dir, ".hivemind_version");
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf-8").trim(); } catch { return null; }
}

export type PlatformId = "claude" | "codex" | "claw" | "cursor" | "hermes" | "pi";

export interface DetectedPlatform {
  id: PlatformId;
  markerDir: string;
}

// Hivemind's value is bidirectional shared memory — every supported agent
// must capture (write) AND recall (read). Cline / Roo Code / Kilo Code were
// dropped because their public API (src/exports/cline.d.ts) is control-only
// (startNewTask / sendMessage / pressPrimary/SecondaryButton). No event
// subscription, no listener, no observation API. Auto-capture would require
// a fragile filesystem watcher on Cline's task storage. See the project
// memory for the investigation that arrived at this decision.
const PLATFORM_MARKERS: DetectedPlatform[] = [
  { id: "claude", markerDir: join(HOME, ".claude") },
  { id: "codex", markerDir: join(HOME, ".codex") },
  { id: "claw", markerDir: join(HOME, ".openclaw") },
  { id: "cursor", markerDir: join(HOME, ".cursor") },
  { id: "hermes", markerDir: join(HOME, ".hermes") },
  // pi (badlogic/pi-mono coding-agent) — config at ~/.pi/agent/. pi exposes
  // a rich extension event API (session_start / input / tool_call /
  // tool_result / message_end / session_shutdown / etc.) — Tier 1 capable.
  { id: "pi", markerDir: join(HOME, ".pi") },
];

export function detectPlatforms(): DetectedPlatform[] {
  return PLATFORM_MARKERS.filter(p => existsSync(p.markerDir));
}

export function allPlatformIds(): PlatformId[] {
  return PLATFORM_MARKERS.map(p => p.id);
}

export function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(msg + "\n");
}
