/**
 * `hivemind install` (no --only flag) auto-detects every assistant on
 * the machine and wires them all.
 *
 * Case 09 covers per-agent install side effects. This case is one
 * layer up: the unified entry point that USERS actually run from the
 * README quickstart. Regressions to detectPlatforms() or to the
 * orchestration of multi-agent installs land here.
 *
 * Setup creates fake-but-detectable marker dirs for each agent under
 * the tmp HOME so detectPlatforms picks them up: ~/.codex, ~/.cursor,
 * ~/.hermes, ~/.pi, ~/.openclaw plus ~/.claude (for the claude-code
 * detect). Then runs `hivemind install --skip-auth`.
 *
 * Assertion walks the post-install layout and confirms each detected
 * agent got its hivemind artifact landed at the expected path. The
 * specific paths per agent follow the same map as `scripts/verify-
 * install.sh` (which is the long-form version of this check).
 *
 * Skipped on five agents — same single-runner pattern as case 13. The
 * unified install is agent-agnostic; running it per agent is just a
 * 6× redundant exercise of the same orchestrator.
 *
 * installOnly: true — no agent spawn, no LLM cost.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { E2ECase } from "../types.js";

const unifiedInstallCase: E2ECase = {
  id: "14-unified-install",
  description:
    "`hivemind install` (no --only) auto-detects every assistant in tmp HOME and lands each one's hivemind artifact",
  prompt: "[install-only — unified `hivemind install`]",
  installOnly: true,
  async setup(ctx) {
    // detectPlatforms looks for the presence of agent-specific dirs
    // under HOME. Seeding empty dirs is enough to flip detection on.
    for (const dir of [".claude", ".codex", ".cursor", ".hermes", ".pi", ".openclaw"]) {
      mkdirSync(join(ctx.home, dir), { recursive: true });
    }
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
    const cliBundle = join(repoRoot, "bundle", "cli.js");
    try {
      execFileSync(process.execPath, [cliBundle, "install", "--skip-auth"], {
        env: { ...process.env, HOME: ctx.home },
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (e: unknown) {
      const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
      // Don't throw in setup — the assertion can give a better diff. Surface
      // the error via a marker file the assertion reads back.
      const errText = err.stderr?.toString() ?? err.stdout?.toString() ?? err.message ?? String(e);
      // Use console.error so the failure has a visible trail in stdout.
      console.error(`[14-unified-install setup] hivemind install threw:\n${errText.slice(-600)}`);
    }
  },
  assertions: [
    {
      type: "custom",
      label: "every detected agent has its hivemind artifact landed under tmp HOME",
      check: async ({ ctx }) => {
        // Per-agent expected artifacts after `hivemind install`. Pulled
        // from scripts/verify-install.sh; the canonical map. If an
        // agent's install path changes upstream, update both this list
        // and scripts/verify-install.sh together.
        const expectations: Array<{ agent: string; path: string }> = [
          // claude-code: marketplace plugin install lands settings; we
          // accept either the settings.json or the marketplace cache
          // metadata, since the marketplace install needs a real `claude`
          // CLI and may not work fully in tmp HOME. The cleanup helper
          // ensures at minimum the file exists post-install.
          { agent: "claude-code", path: join(ctx.home, ".claude", "settings.json") },
          { agent: "codex",       path: join(ctx.home, ".codex", "hivemind", "bundle", "session-start.js") },
          { agent: "cursor",      path: join(ctx.home, ".cursor", "hivemind", "bundle", "session-start.js") },
          { agent: "hermes",      path: join(ctx.home, ".hermes", "skills", "hivemind-memory", "SKILL.md") },
          { agent: "pi",          path: join(ctx.home, ".pi", "agent", "extensions", "hivemind.ts") },
          { agent: "openclaw",    path: join(ctx.home, ".openclaw", "extensions", "hivemind", "dist", "index.js") },
        ];
        const missing: string[] = [];
        for (const { agent, path } of expectations) {
          if (!existsSync(path)) missing.push(`${agent}: ${path}`);
        }
        if (missing.length === 0) return null;
        return `${missing.length} of ${expectations.length} agents did NOT land their install artifact:\n  ${missing.join("\n  ")}`;
      },
    },
  ],
  // Run only via the claude-code slot — same rationale as case 13.
  skipFor: ["codex", "cursor-agent", "hermes", "pi", "openclaw"],
};

export default unifiedInstallCase;
