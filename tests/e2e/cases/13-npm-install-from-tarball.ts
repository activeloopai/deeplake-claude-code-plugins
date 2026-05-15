/**
 * npm-pack → npm-install-g flow.
 *
 * The harness's other install-shape case (09) drives `hivemind <agent>
 * install` against a tmp HOME using the BUILT bundle in the repo. That
 * skips a class of regressions one layer above: the `npm install -g
 * @deeplake/hivemind` step itself. Specifically:
 *
 *   - package.json `files` array doesn't include something the runtime
 *     needs (`bundle/`, `openclaw/dist/`, `pi/extension-source/`, …)
 *   - The bin field doesn't resolve correctly after a global install
 *   - A postinstall script (if added in future) crashes during install
 *
 * This case exercises the real pack-and-install path:
 *
 *   1. `npm pack` the current repo → produces `deeplake-hivemind-X.tgz`.
 *   2. `npm install -g <tarball> --prefix <tmpHome>/.npm-test` so the
 *      install lands in an isolated prefix and the operator's real
 *      global npm tree stays untouched.
 *   3. Assert: `<tmpHome>/.npm-test/bin/hivemind --version` runs cleanly
 *      and prints the expected version string.
 *
 * Skipped on all agents except claude-code as an arbitrary single-runner
 * — the test is npm-shape, not agent-shape; running it per agent would
 * just be a 6× re-run of the same global check. Picking claude-code
 * because its driver does an install no-op (the prefix install is its
 * actual install flow).
 *
 * `installOnly: true` — no agent spawn, no LLM cost. Cost is one `npm
 * pack` (~2-5s) plus one `npm install -g <tarball>` (~10-30s). Run only
 * occasionally; no recurring API spend.
 */

import { mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { E2ECase } from "../types.js";

const npmInstallFromTarballCase: E2ECase = {
  id: "13-npm-install-from-tarball",
  description:
    "npm-pack the local repo + npm install -g <tarball> against a tmp prefix → hivemind --version runs cleanly",
  prompt: "[install-only — npm pack / install -g]",
  installOnly: true,
  async setup(ctx) {
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
    const packDir = join(ctx.home, ".pack");
    mkdirSync(packDir, { recursive: true });
    // npm pack writes to cwd; cd into packDir so the tarball lands there.
    execFileSync("npm", ["pack", repoRoot, "--pack-destination", packDir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_loglevel: "error" },
    });
  },
  assertions: [
    {
      type: "custom",
      label: "tarball exists after npm pack",
      check: async ({ ctx }) => {
        const packDir = join(ctx.home, ".pack");
        const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length === 0) return `no .tgz produced in ${packDir}`;
        return null;
      },
    },
    {
      type: "custom",
      label: "npm install -g <tarball> against tmp prefix succeeds and the hivemind binary runs",
      check: async ({ ctx }) => {
        const packDir = join(ctx.home, ".pack");
        const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length === 0) return null; // already failed in the prior assertion
        const tarball = join(packDir, tarballs[0]);
        const prefix = join(ctx.home, ".npm-test");
        const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
        const expectedVersion = JSON.parse(
          readFileSync(join(repoRoot, "package.json"), "utf-8"),
        ).version as string;
        try {
          execFileSync(
            "npm",
            ["install", "-g", tarball, "--prefix", prefix, "--no-fund", "--no-audit", "--ignore-scripts"],
            {
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, npm_config_loglevel: "error" },
              timeout: 120_000,
            },
          );
        } catch (e: unknown) {
          const err = e as { stderr?: Buffer; message?: string };
          return `npm install -g failed: ${err.stderr?.toString().slice(-400) ?? err.message ?? String(e)}`;
        }
        const binPath = join(prefix, "bin", "hivemind");
        if (!existsSync(binPath)) return `${binPath} missing after install -g; the bin field didn't resolve into the prefix`;
        let versionOut: string;
        try {
          versionOut = execFileSync(binPath, ["--version"], {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          }).toString();
        } catch (e: unknown) {
          const err = e as { stderr?: Buffer; message?: string };
          return `${binPath} --version failed to run: ${err.stderr?.toString().slice(-400) ?? err.message ?? String(e)}`;
        }
        if (!versionOut.includes(expectedVersion)) {
          return `${binPath} --version printed ${JSON.stringify(versionOut.trim())} — expected to include ${JSON.stringify(expectedVersion)}`;
        }
        return null;
      },
    },
  ],
  // npm-pack is agent-agnostic — run only once via the claude-code slot;
  // the other five agents get a skip with a "deliberate one-runner" note.
  skipFor: ["codex", "cursor-agent", "hermes", "pi", "openclaw"],
};

export default npmInstallFromTarballCase;
