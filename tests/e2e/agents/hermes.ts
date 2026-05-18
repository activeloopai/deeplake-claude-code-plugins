/**
 * Hermes driver.
 *
 * Install: `hivemind hermes install` deposits the hermes bundle + the
 * hivemind-memory skill md + the MCP server into ~/.hermes/ and
 * ~/.hivemind/mcp/ respectively.
 *
 * Non-interactive run: `hermes -z <prompt> --provider google --model X --yolo`.
 * `-z` is hermes's headless one-shot flag. `--yolo` auto-approves tool
 * calls (hermes equivalent of `--force` / `--allow-dangerously-...`).
 */

import type { AgentDriver, RunOpts, RunResult } from "../types.js";
import { runProcess } from "./claude-code.js";
import { installOrThrow } from "./install-via-cli.js";

export const hermesDriver: AgentDriver = {
  id: "hermes",
  providerKey: null, // openrouter-routed; see precheck for the actual env requirement
  async precheck() {
    // Hermes via openrouter needs OPENROUTER_API_KEY. Hermes's own
    // RuntimeError-on-missing-provider-key is a multi-line Python
    // traceback; we mirror the check pre-spawn so the matrix output
    // stays clean.
    if (!process.env.OPENROUTER_API_KEY) {
      return {
        ready: false as const,
        reason: "OPENROUTER_API_KEY not set — hermes driver routes through OpenRouter",
      };
    }
    return { ready: true } as const;
  },
  async install(home, repoRoot) {
    await installOrThrow("hermes", home, repoRoot);
  },
  async run(prompt, opts: RunOpts): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: opts.home,
      HIVEMIND_DEBUG: "1",
    };
    if (process.env.OPENROUTER_API_KEY) {
      env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    }
    const args = [
      "-z",
      prompt,
      "--provider", "openrouter",
      "--model", "anthropic/claude-haiku-4-5",
      "--yolo",
    ];
    return runProcess("hermes", args, env, opts.timeoutMs ?? 90_000, opts.sessionId);
  },
};
