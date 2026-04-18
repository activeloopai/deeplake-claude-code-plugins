export type DeeplakeTableScope = "memory" | "sessions" | "both";

export function normalizeVirtualPath(path: string): string {
  if (!path) return "/";
  const clean = path.replace(/\/+$/, "");
  return clean || "/";
}

export function getDeeplakeTableScope(path: string): DeeplakeTableScope {
  const target = normalizeVirtualPath(path);
  if (target === "/") return "both";
  if (target === "/sessions" || target.startsWith("/sessions/")) return "sessions";
  return "memory";
}

export function scopeIncludesMemory(scope: DeeplakeTableScope): boolean {
  return scope === "memory" || scope === "both";
}

export function scopeIncludesSessions(scope: DeeplakeTableScope): boolean {
  return scope === "sessions" || scope === "both";
}

export function isSessionVirtualPath(path: string): boolean {
  return getDeeplakeTableScope(path) === "sessions";
}
