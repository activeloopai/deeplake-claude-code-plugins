import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

/**
 * Bundle-level anti-regression.
 *
 * Every per-agent esbuild block must replace the `__HIVEMIND_VERSION__`
 * placeholder via `define`. Without it, bundled code that interpolates the
 * constant (e.g. `deeplakeClientValue()` for the X-Deeplake-Client header)
 * crashes at runtime with "__HIVEMIND_VERSION__ is not defined" on the very
 * first Deeplake API call. The cursor and hermes blocks were missing the
 * define on first ship; this guard prevents the same drop-out from happening
 * again, including for any new agent we wire up later.
 */

const ROOT = resolve(__dirname, "..", "..");

function listBundleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listBundleFiles(full));
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const BUNDLE_DIRS = [
  ["claude-code", resolve(ROOT, "claude-code", "bundle")],
  ["codex", resolve(ROOT, "codex", "bundle")],
  ["cursor", resolve(ROOT, "cursor", "bundle")],
  ["hermes", resolve(ROOT, "hermes", "bundle")],
];

for (const [label, dir] of BUNDLE_DIRS) {
  describe(`${label} bundle: __HIVEMIND_VERSION__ inlined`, () => {
    const files = listBundleFiles(dir);

    it("at least one .js file shipped", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      it(`${rel} has the version constant substituted`, () => {
        const src = readFileSync(file, "utf-8");
        expect(src).not.toMatch(/__HIVEMIND_VERSION__/);
      });
    }
  });
}
