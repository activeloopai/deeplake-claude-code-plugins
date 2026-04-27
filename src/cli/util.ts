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

export type PlatformId = "claude" | "codex" | "claw" | "cursor" | "hermes" | "pi" | "cline" | "roo" | "kilo";

export interface DetectedPlatform {
  id: PlatformId;
  markerDir: string;
}

const PLATFORM_MARKERS: DetectedPlatform[] = [
  { id: "claude", markerDir: join(HOME, ".claude") },
  { id: "codex", markerDir: join(HOME, ".codex") },
  { id: "claw", markerDir: join(HOME, ".openclaw") },
  { id: "cursor", markerDir: join(HOME, ".cursor") },
  { id: "hermes", markerDir: join(HOME, ".hermes") },
  // pi (badlogic/pi-mono coding-agent) — config at ~/.pi/agent/
  { id: "pi", markerDir: join(HOME, ".pi") },
  // Cline (saoudrizwan.claude-dev VS Code extension) — settings under VS Code's globalStorage
  { id: "cline", markerDir: join(HOME, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev") },
  // Roo Code (rooveterinaryinc.roo-cline VS Code extension)
  { id: "roo", markerDir: join(HOME, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline") },
  // Kilo Code — config at ~/.kilocode/
  { id: "kilo", markerDir: join(HOME, ".kilocode") },
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
