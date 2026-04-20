/**
 * Canonical session JSONL path. Used by every capture hook (CC + Codex)
 * and by the placeholder / summary paths in session-start. Keeping it
 * in one place prevents the 4-tuple `{userName, orgName, workspaceId,
 * sessionId}` from ever being re-assembled in the wrong order.
 */
export function buildSessionPath(
  config: { userName: string; orgName: string; workspaceId: string },
  sessionId: string,
): string {
  const workspace = config.workspaceId ?? "default";
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${workspace}_${sessionId}.jsonl`;
}
