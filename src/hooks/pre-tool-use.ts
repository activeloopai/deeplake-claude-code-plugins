#!/usr/bin/env node
/**
 * PreToolUse hook — intercepts tool calls targeting the Deeplake virtual filesystem.
 *
 * For safe commands touching DEEPLAKE_MEMORY_PATH:
 *   - Structured tools (Read, Write, Edit, Glob, Grep): execute via DeeplakeFS directly
 *   - Bash tool: run through just-bash + DeeplakeFS if command uses only safe builtins
 *   Returns result to Claude and blocks the real tool (exit 2).
 *
 * For unsafe Bash (python, node, etc.) or paths outside memory: exit 0,
 * let the real tool run normally (or show CLI install prompt).
 *
 * Bootstrap cache: SessionStart writes ~/.deeplake/.cache/bootstrap-{sessionId}.json
 * so this hook avoids a DB round-trip on every tool call.
 *
 * Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bash } from "just-bash";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFS } from "../shell/deeplake-fs.js";

const DEBUG = process.env.DEEPLAKE_DEBUG === "1";
const CACHE_DIR = join(homedir(), ".deeplake", ".cache");
const LOG = join(homedir(), ".deeplake", "hook-debug.log");

function log(msg: string) {
  if (!DEBUG) return;
  appendFileSync(LOG, `${new Date().toISOString()} [pre] ${msg}\n`);
}

// ── Safe-command detection (allowlist) ───────────────────────────────────────
// Only commands whose every pipeline stage starts with one of these builtins
// can run inside just-bash. Anything else needs real bash + FUSE.
const SAFE_BUILTINS = new Set([
  "cat", "ls", "echo", "grep", "find", "wc", "head", "tail", "sort",
  "uniq", "cut", "mkdir", "rm", "cp", "mv", "touch", "pwd", "printf",
  "tr", "basename", "dirname", "date", "test", "[", "true", "false",
  "sed", "awk", "read", "export", "cd",
]);

function isSafeForJustBash(cmd: string): boolean {
  // Split on pipe, semicolon, &&, || to get individual command stages
  const stages = cmd.split(/\||;|&&|\|\|/);
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken)) return false;
  }
  return true;
}

// ── Shell escaping ────────────────────────────────────────────────────────────
/**
 * POSIX single-quote shell escape. Wraps the argument in single quotes and
 * escapes any embedded single quotes so no shell metacharacter can escape.
 * Safe for use in execSync() command strings.
 */
function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// ── Deeplake CLI detection ────────────────────────────────────────────────────
function isDeeplakeCLIInstalled(): boolean {
  try {
    execSync("which deeplake", { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return [
      "/usr/local/bin/deeplake",
      "/usr/bin/deeplake",
      join(homedir(), ".local", "bin", "deeplake"),
      join(homedir(), ".deeplake", "bin", "deeplake"),
    ].some(existsSync);
  }
}

/**
 * Rewrite any `grep` calls in a command to use `deeplake search` for BM25.
 * Only rewrites greps that target the memory path — other greps are left alone.
 *
 * e.g. grep -r "foo" ~/.deeplake/memory
 *   →  deeplake search "foo" ~/.deeplake/memory
 */
function rewriteGrepToBM25(cmd: string, memoryPath: string): string {
  // Match: grep [flags] <pattern> <path-containing-memoryPath>
  return cmd.replace(
    /\bgrep\s+((?:-\S+\s+)*)(['"]?)([^'"|\s]+)\2\s+(\S*(?:\.deeplake\/memory|deeplake\/memory)\S*)/g,
    (_match, _flags, _q, pattern, path) =>
      `deeplake search ${shellEscape(pattern)} ${shellEscape(path)}`,
  );
}

// ── Memory path detection ─────────────────────────────────────────────────────
interface MemoryTarget {
  tool: string;
  /** Resolved path or command string */
  value: string;
  /** Bash command contains external binaries just-bash can't handle */
  unsafe?: boolean;
}

function detectMemoryTarget(
  toolName: string,
  input: Record<string, unknown>,
  memoryPath: string,
): MemoryTarget | null {
  const tilde = "~/.deeplake/memory";
  const touches = (p?: string) =>
    !!p && (p.startsWith(memoryPath) || p.includes(tilde));

  switch (toolName) {
    case "Read": {
      const p = input["file_path"] as string | undefined;
      if (touches(p)) return { tool: "Read", value: p! };
      break;
    }
    case "Write": {
      const p = input["file_path"] as string | undefined;
      if (touches(p)) return { tool: "Write", value: p! };
      break;
    }
    case "Edit": {
      const p = input["file_path"] as string | undefined;
      if (touches(p)) return { tool: "Edit", value: p! };
      break;
    }
    case "Glob": {
      const p = input["pattern"] as string | undefined;
      if (touches(p)) return { tool: "Glob", value: p! };
      break;
    }
    case "Grep": {
      const p = input["path"] as string | undefined;
      if (touches(p)) return { tool: "Grep", value: p! };
      break;
    }
    case "Bash": {
      const cmd = input["command"] as string | undefined;
      if (!cmd) break;
      if (!touches(cmd)) break;
      // Return target regardless of safety — unsafe case handled in main()
      return { tool: "Bash", value: cmd, unsafe: !isSafeForJustBash(cmd) };
    }
  }
  return null;
}

// ── Structured tool execution via DeeplakeFs ──────────────────────────────────
async function execStructuredTool(
  toolName: string,
  input: Record<string, unknown>,
  fs: DeeplakeFs,
): Promise<string> {
  switch (toolName) {
    case "Read": {
      const p = input["file_path"] as string;
      return await fs.readFile(p);
    }
    case "Write": {
      const p = input["file_path"] as string;
      const content = (input["content"] as string) ?? "";
      await fs.writeFile(p, content);
      await fs.flush();
      return `Successfully wrote to ${p}`;
    }
    case "Edit": {
      const p = input["file_path"] as string;
      const oldStr = (input["old_string"] as string) ?? "";
      const newStr = (input["new_string"] as string) ?? "";
      const existing = await fs.readFile(p);
      if (!existing.includes(oldStr)) throw new Error(`old_string not found in ${p}`);
      await fs.writeFile(p, existing.replace(oldStr, newStr));
      await fs.flush();
      return `Successfully edited ${p}`;
    }
    case "Glob": {
      const pattern = (input["pattern"] as string) ?? "*";
      // Use getAllPaths and filter by glob-like pattern (convert * and ** to regex)
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".+")
        .replace(/\*/g, "[^/]+");
      const re = new RegExp(`^${regexStr}$`);
      const matches = fs.getAllPaths().filter(p => re.test(p));
      return matches.join("\n");
    }
    case "Grep": {
      // Delegate to just-bash grep via Bash exec on the same FS
      const bash = new Bash({ fs, cwd: "/" });
      const pattern = (input["pattern"] as string) ?? "";
      const path = (input["path"] as string) ?? "/";
      const flags = (input["flags"] as string) ?? "";
      const cmd = `grep -r ${flags} ${JSON.stringify(pattern)} ${JSON.stringify(path)}`;
      const result = await bash.exec(cmd);
      return result.stdout || result.stderr;
    }
    default:
      throw new Error(`Unhandled tool: ${toolName}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

async function main(): Promise<void> {
  const input = await readStdin<PreToolUseInput>();
  log(`tool=${input.tool_name} input=${JSON.stringify(input.tool_input).slice(0, 150)}`);

  const config = loadConfig();
  if (!config) return; // no creds, let tool proceed

  const memoryPath = process.env["DEEPLAKE_MEMORY_PATH"] ?? config.memoryPath;
  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";

  const target = detectMemoryTarget(input.tool_name, input.tool_input, memoryPath);
  if (!target) return; // not targeting memory, or unsafe bash — exit 0

  log(`intercepting ${target.tool}: ${target.value.slice(0, 100)}`);

  try {
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);

    // Use bootstrap cache written by SessionStart to avoid a DB round-trip here.
    const cachePath = join(CACHE_DIR, `bootstrap-${input.session_id}.json`);
    let cachedRows: Record<string, unknown>[] | undefined;
    if (existsSync(cachePath)) {
      try {
        const { rows, ts } = JSON.parse(readFileSync(cachePath, "utf-8")) as { rows: Record<string, unknown>[]; ts: number };
        if (Date.now() - ts < 60_000) cachedRows = rows; // 60s TTL
      } catch { /* stale or corrupt cache — fall through to DB */ }
    }
    const fs = await DeeplakeFS.create(api, table, "/", cachedRows);

    let result: string;

    if (target.tool === "Bash" && target.unsafe) {
      if (isDeeplakeCLIInstalled()) {
        // CLI is installed (FUSE mount available) — forward to real bash.
        // Rewrite any grep calls to use deeplake search (BM25) instead.
        const rewritten = rewriteGrepToBM25(target.value, memoryPath);
        if (rewritten !== target.value) {
          log(`grep rewritten to deeplake search: ${rewritten.slice(0, 100)}`);
        }
        // If grep was rewritten, run the modified command and return result.
        // Otherwise exit 0 and let real bash + FUSE handle everything natively.
        if (rewritten !== target.value) {
          const { execSync: run } = await import("node:child_process");
          const out = run(rewritten, { encoding: "utf-8", timeout: 30_000 });
          console.log(JSON.stringify({ result: out }));
          process.exit(2);
          return;
        }
        // No grep rewrite needed — let real bash run via FUSE (exit 0)
        log(`forwarding to real bash + FUSE`);
        return;
      }

      // CLI not installed — prompt the agent to install it.
      result = [
        `⚠️  This command requires advanced filesystem support not available in the lightweight plugin.`,
        ``,
        `The command contains external binaries (python, node, etc.) that need a real FUSE mount`,
        `to access the Deeplake virtual filesystem at: ${memoryPath}`,
        ``,
        `To enable full FUSE + WASM support, install the Deeplake CLI:`,
        ``,
        `  curl -fsSL https://deeplake.ai/install.sh | bash`,
        ``,
        `Then mount the filesystem:`,
        ``,
        `  deeplake mount ${memoryPath}`,
        ``,
        `Alternatively, rewrite the command using only basic tools (cat, ls, grep, find, wc,`,
        `head, tail, sort, uniq) which are supported natively by this lightweight plugin.`,
      ].join("\n");
      log(`unsafe bash blocked — CLI not installed, showed install prompt`);
      console.log(JSON.stringify({ result }));
      process.exit(2);
      return;
    } else if (target.tool === "Bash") {
      const bash = new Bash({
        fs,
        cwd: "/",
        customCommands: [],
        env: { HOME: memoryPath },
      });
      // Normalize tilde references so just-bash resolves them correctly
      const cmd = target.value.replace(/~\/.deeplake\/memory/g, memoryPath);
      const out = await bash.exec(cmd);
      result = out.stdout + (out.stderr ? `\nstderr: ${out.stderr}` : "");
      log(`bash done exitCode=${out.exitCode} stdout=${out.stdout.slice(0, 100)}`);
    } else {
      result = await execStructuredTool(target.tool, input.tool_input, fs);
      log(`${target.tool} done result=${result.slice(0, 100)}`);
    }

    console.log(JSON.stringify({ result }));
    process.exit(2); // block real tool — Claude uses our result
  } catch (e) {
    // On any error let the real tool run rather than silently failing
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  }
}

main().catch((e) => { log(`fatal: ${e instanceof Error ? e.message : String(e)}`); process.exit(0); });
