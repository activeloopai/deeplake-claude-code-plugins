/**
 * X-Deeplake-Client header helper.
 *
 * The deeplake-api backend reads X-Deeplake-Client to attribute traffic
 * (analytics source + engagement metrics). Every outbound request to
 * deeplake-api should carry this header; without it, hivemind traffic
 * looks indistinguishable from the activeloop-cli / device-code flow.
 *
 * __HIVEMIND_VERSION__ is replaced at build/test time:
 *   - production bundles: esbuild.config.mjs sets it to the real package.json version
 *   - vitest:             vitest.config.ts sets it to "dev"
 * Source code therefore reads it directly, no runtime guard needed.
 */
declare const __HIVEMIND_VERSION__: string;

export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";

/** Returns "hivemind/<version>" — the value for the X-Deeplake-Client header. */
export function deeplakeClientValue(): string {
  return `hivemind/${__HIVEMIND_VERSION__}`;
}

/** Returns { "X-Deeplake-Client": "hivemind/<version>" } for spreading into a headers object. */
export function deeplakeClientHeader(): Record<string, string> {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}
