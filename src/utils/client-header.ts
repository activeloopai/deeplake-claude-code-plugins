/**
 * X-Deeplake-Client header helper.
 *
 * The deeplake-api backend reads X-Deeplake-Client to attribute traffic by
 * client family (distinguishes hivemind traffic from activeloop-cli /
 * device-code-flow traffic). Every outbound request to deeplake-api carries
 * this header.
 *
 * Static "hivemind" — no version dimension. The version part used to be
 * baked in via esbuild's `define: { __HIVEMIND_VERSION__: ... }`, but
 * keeping every per-bundle build step in sync was a recurring source of
 * bugs (cursor / hermes / mcp / unified CLI all shipped with the literal
 * unsubstituted at one point), and the backend doesn't actively use the
 * version dimension. If version-level attribution becomes useful again,
 * re-introduce the define on every build step that ships a bundle hitting
 * deeplake-api.
 */
export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";

/** Returns "hivemind" — the value for the X-Deeplake-Client header. */
export function deeplakeClientValue(): string {
  return "hivemind";
}

/** Returns { "X-Deeplake-Client": "hivemind" } for spreading into a headers object. */
export function deeplakeClientHeader(): Record<string, string> {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}
