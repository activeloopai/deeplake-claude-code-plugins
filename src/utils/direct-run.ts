import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(entry);
  } catch {
    return false;
  }
}
