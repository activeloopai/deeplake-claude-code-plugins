/**
 * Pi driver.
 *
 * Install: `hivemind pi install` copies pi/extension-source/hivemind.ts
 * into ~/.pi/agent/extensions/ and writes AGENTS.md so pi picks it up.
 * Pi compiles the .ts extension at session start; no precompiled bundle.
 *
 * Non-interactive run: `pi --print --provider google --model X <prompt>`.
 */

import type { AgentDriver, RunOpts, RunResult } from "../types.js";
import { runProcess } from "./claude-code.js";
import { installOrThrow } from "./install-via-cli.js";

export const piDriver: AgentDriver = {
  id: "pi",
  // Provider key field is descriptive: pi can use whatever provider its
  // env supports. We route through OpenRouter when OPENROUTER_API_KEY is
  // set — one key unlocks many models without per-provider account setup.
  providerKey: null,
  async precheck() {
    // Pi via openrouter needs OPENROUTER_API_KEY. The CLI itself exits
    // with "No API key found for openrouter" if missing; the precheck
    // mirrors that check pre-spawn so the matrix doesn't waste a slot
    // discovering it case-by-case.
    if (!process.env.OPENROUTER_API_KEY) {
      return {
        ready: false as const,
        reason: "OPENROUTER_API_KEY not set — pi driver routes through OpenRouter (one key, many models)",
      };
    }
    return { ready: true } as const;
  },
  async install(home, repoRoot) {
    await installOrThrow("pi", home, repoRoot);
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
      "--print",
      "--provider", "openrouter",
      // anthropic/claude-haiku-4-5 is a cheap universal model on OpenRouter.
      // Switching to another provider's model is a one-line driver edit.
      "--model", "anthropic/claude-haiku-4-5",
      prompt,
    ];
    return runProcess("pi", args, env, opts.timeoutMs ?? 90_000, opts.sessionId);
  },
};
