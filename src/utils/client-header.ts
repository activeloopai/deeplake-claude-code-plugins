/**
 * X-Deeplake-Client header helper.
 *
 * The deeplake-api backend reads X-Deeplake-Client to attribute traffic
 * (analytics source + engagement metrics). Every outbound request to
 * deeplake-api should carry this header; without it, hivemind traffic
 * looks indistinguishable from the activeloop-cli / device-code flow.
 *
 * __HIVEMIND_VERSION__ is a build-time constant injected by esbuild
 * (see esbuild.config.mjs). In dev (tsx, vitest) the constant is not
 * defined, so we fall back to "dev".
 */
declare const __HIVEMIND_VERSION__: string;

function pluginVersion(): string {
  try {
    if (typeof __HIVEMIND_VERSION__ === "string" && __HIVEMIND_VERSION__) {
      return __HIVEMIND_VERSION__;
    }
  } catch { /* reference error in unbundled dev → fall through */ }
  return "dev";
}

export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";

/** Returns "hivemind/<version>" — the value for the X-Deeplake-Client header. */
export function deeplakeClientValue(): string {
  return `hivemind/${pluginVersion()}`;
}

/** Returns { "X-Deeplake-Client": "hivemind/<version>" } for spreading into a headers object. */
export function deeplakeClientHeader(): Record<string, string> {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}
