/**
 * Scope-promotion policy for cross-author MERGE (issue #118).
 *
 * When the editor of a MERGE is not the original author of the skill, the
 * row written to the `skills` table needs its `scope` widened so future
 * readers can see the entry is co-owned. Two narrower constraints captured
 * here:
 *
 *   1. The promotion is one-directional `me -> team`. A session already
 *      running with `cfg.scope = "team"` keeps team scope on cross-author
 *      edits — there's nothing wider to promote to.
 *   2. KEEP and same-author MERGE never promote — only true cross-author
 *      MERGE does. Otherwise a same-author edit on a `scope = "me"` skill
 *      would silently broadcast.
 *
 * Extracted as a pure helper so it stays unit-testable. The worker just
 * threads cfg + verdict + result into these two functions.
 */

export type Scope = "me" | "team";

export function isCrossAuthorMergeVerdict(args: {
  verdict: "KEEP" | "MERGE" | "SKIP";
  resultAuthor: string | undefined;
  userName: string;
}): boolean {
  return (
    args.verdict === "MERGE" &&
    args.resultAuthor !== undefined &&
    args.resultAuthor !== args.userName
  );
}

export function resolveRecordScope(args: {
  configScope: Scope;
  isCrossAuthorMerge: boolean;
}): Scope {
  return args.isCrossAuthorMerge && args.configScope === "me"
    ? "team"
    : args.configScope;
}
