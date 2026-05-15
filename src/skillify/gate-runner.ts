/**
 * Run the gate prompt through the originating agent's own CLI.
 *
 * Each agent ships its own headless CLI; we use the same one its
 * wiki-worker uses for summary generation, so a user who only has
 * codex / cursor / hermes installed never needs `claude` in PATH.
 *
 * Per-agent invocation:
 *   claude_code → `claude -p <prompt> --no-session-persistence --model haiku --permission-mode bypassPermissions`
 *   codex       → `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`
 *   cursor      → `cursor-agent --print --model <model> --force --output-format text <prompt>`
 *   hermes      → `hermes -z <prompt> --provider <provider> -m <model> --yolo --ignore-user-config`
 *
 * The worker passes a verdict-write path inside the prompt; the runner
 * captures stdout regardless so the worker's stdout-fallback path still
 * works on agents whose models don't reliably use the Write tool.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Agent = "claude_code" | "codex" | "cursor" | "hermes" | "pi";

export interface GateRunOptions {
  agent: Agent;
  prompt: string;
  /** Override the binary path. If absent, the runner finds it in PATH or uses a fallback. */
  bin?: string;
  /** cursor only — model passed to --model */
  cursorModel?: string;
  /** hermes only — provider passed to --provider */
  hermesProvider?: string;
  /** hermes only — model passed to -m */
  hermesModel?: string;
  /** pi only — provider passed to --provider (default "google") */
  piProvider?: string;
  /** pi only — model passed to --model (default "gemini-2.5-flash") */
  piModel?: string;
  /** Max wall-clock for the CLI call; default 120s. */
  timeoutMs?: number;
}

export interface GateRunResult {
  stdout: string;
  stderr: string;
  /** true if the CLI exited non-zero. stdout/stderr are still populated when possible. */
  errored: boolean;
  errorMessage?: string;
}

/** Locate the binary for an agent. Tries `which`, then falls back to a sensible default path. */
export function findAgentBin(agent: Agent): string {
  // Use execFileSync (no shell) instead of execSync — `agent` is a typed
  // string literal here so injection isn't currently possible, but
  // hard-coding the no-shell variant prevents future callers from
  // accidentally introducing one. The names passed to `which` are also
  // hard-coded constants in this switch.
  const which = (name: string): string | null => {
    try {
      const out = execFileSync("which", [name], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim() || null;
    } catch { return null; }
  };
  switch (agent) {
    case "claude_code":
      return which("claude") ?? join(homedir(), ".claude", "local", "claude");
    case "codex":
      return which("codex") ?? "/usr/local/bin/codex";
    case "cursor":
      return which("cursor-agent") ?? "/usr/local/bin/cursor-agent";
    case "hermes":
      return which("hermes") ?? join(homedir(), ".local", "bin", "hermes");
    case "pi":
      return which("pi") ?? join(homedir(), ".local", "bin", "pi");
  }
}

function buildArgs(agent: Agent, prompt: string, opts: GateRunOptions): string[] {
  switch (agent) {
    case "claude_code":
      return [
        "-p", prompt,
        "--no-session-persistence",
        "--model", "haiku",
        "--permission-mode", "bypassPermissions",
      ];
    case "codex":
      return [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
      ];
    case "cursor":
      return [
        "--print",
        "--model", opts.cursorModel ?? process.env.HIVEMIND_CURSOR_MODEL ?? "auto",
        "--force",
        "--output-format", "text",
        prompt,
      ];
    case "hermes":
      return [
        "-z", prompt,
        "--provider", opts.hermesProvider ?? process.env.HIVEMIND_HERMES_PROVIDER ?? "openrouter",
        "-m", opts.hermesModel ?? process.env.HIVEMIND_HERMES_MODEL ?? "anthropic/claude-haiku-4-5",
        "--yolo",
        "--ignore-user-config",
      ];
    case "pi":
      return [
        "--print",
        "--provider", opts.piProvider ?? process.env.HIVEMIND_PI_PROVIDER ?? "google",
        "--model", opts.piModel ?? process.env.HIVEMIND_PI_MODEL ?? "gemini-2.5-flash",
        prompt,
      ];
  }
}

export function runGate(opts: GateRunOptions): GateRunResult {
  const bin = opts.bin ?? findAgentBin(opts.agent);
  if (!existsSync(bin)) {
    return {
      stdout: "", stderr: "",
      errored: true,
      errorMessage: `agent binary not found at ${bin} (agent=${opts.agent})`,
    };
  }
  const args = buildArgs(opts.agent, opts.prompt, opts);
  try {
    const result = execFileSync(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" },
    });
    return { stdout: result.toString("utf-8"), stderr: "", errored: false };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString("utf-8") ?? "",
      stderr: e.stderr?.toString("utf-8") ?? "",
      errored: true,
      errorMessage: `${opts.agent} CLI failed: ${e.status ?? e.code ?? e.message}`,
    };
  }
}
