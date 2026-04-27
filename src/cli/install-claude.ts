import { execFileSync } from "node:child_process";
import { log } from "./util.js";

// Claude Code's plugin loader is a managed surface: it owns the cache layout,
// the plugin registry, hook wiring, command discovery, and version updates.
// Rather than reimplement that, this installer delegates to the `claude`
// CLI and lets Claude Code drive the install through its supported flow:
//   claude plugin marketplace add activeloopai/hivemind
//   claude plugin install hivemind
//   claude plugin enable hivemind@hivemind
//
// Side effect: requires `claude` on PATH at install time and network access
// to fetch the marketplace from GitHub. Both are reasonable assumptions for
// anyone running `npx @activeloop/hivemind claude install` — they already
// have Claude Code installed and the marketplace flow is the canonical way
// to ship plugins to Claude Code users.

const MARKETPLACE_NAME = "hivemind";
const MARKETPLACE_SOURCE = "activeloopai/hivemind";
const PLUGIN_KEY = "hivemind@hivemind";

interface ClaudeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runClaude(args: string[]): ClaudeResult {
  try {
    const stdout = execFileSync("claude", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message ?? "",
    };
  }
}

function requireClaudeCli(): void {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "Claude Code CLI ('claude') not found on PATH. " +
      "Install Claude Code first: https://claude.com/claude-code",
    );
  }
}

function marketplaceAlreadyAdded(): boolean {
  const r = runClaude(["plugin", "marketplace", "list"]);
  if (!r.ok) return false;
  return new RegExp(`(^|\\s)${MARKETPLACE_NAME}(\\s|$)`, "m").test(r.stdout);
}

function pluginAlreadyInstalled(): boolean {
  const r = runClaude(["plugin", "list"]);
  if (!r.ok) return false;
  return r.stdout.includes(PLUGIN_KEY);
}

export function installClaude(): void {
  requireClaudeCli();

  if (!marketplaceAlreadyAdded()) {
    const add = runClaude(["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
    if (!add.ok) {
      throw new Error(
        `Failed to add marketplace '${MARKETPLACE_SOURCE}': ${add.stderr.slice(0, 200)}`,
      );
    }
  }

  if (!pluginAlreadyInstalled()) {
    const inst = runClaude(["plugin", "install", "hivemind"]);
    if (!inst.ok) {
      throw new Error(
        `Failed to install hivemind plugin: ${inst.stderr.slice(0, 200)}`,
      );
    }
  }

  // enable is idempotent in claude CLI — safe to run unconditionally
  runClaude(["plugin", "enable", PLUGIN_KEY]);

  log(`  Claude Code    installed via marketplace ${MARKETPLACE_SOURCE}`);
}

export function uninstallClaude(): void {
  try {
    requireClaudeCli();
  } catch {
    log("  Claude Code    skip uninstall — claude CLI not on PATH");
    return;
  }
  runClaude(["plugin", "disable", PLUGIN_KEY]);
  runClaude(["plugin", "uninstall", PLUGIN_KEY]);
  log("  Claude Code    plugin uninstalled");
}
