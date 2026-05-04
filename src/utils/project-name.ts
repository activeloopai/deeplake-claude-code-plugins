export function resolveProjectName(cwd: string = process.cwd()): string {
  return cwd.split("/").pop() || "unknown";
}
