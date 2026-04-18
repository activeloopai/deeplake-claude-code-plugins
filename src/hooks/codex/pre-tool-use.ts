#!/usr/bin/env node

/**
 * Codex PreToolUse hook — intercepts Bash commands targeting ~/.deeplake/memory/.
 *
 * Strategy: "block + inject"
 * Codex does not parse JSON hook output here, so the CLI wrapper still maps:
 * - action=pass  -> exit 0, no output
 * - action=guide -> stdout guidance, exit 0
 * - action=block -> stderr content, exit 2
 *
 * The source logic is exported so tests can exercise it directly without
 * spawning the bundled script in a subprocess.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlLike } from "../../utils/sql.js";
import { parseBashGrep, handleGrepDirect } from "../grep-direct.js";
import {
  findVirtualPaths,
  listVirtualPathRows,
  readVirtualPathContent,
} from "../virtual-table-query.js";
import { log as _log } from "../../utils/debug.js";
import { isDirectRun } from "../../utils/direct-run.js";

const log = (msg: string) => _log("codex-pre", msg);

const MEMORY_PATH = join(homedir(), ".deeplake", "memory");
const TILDE_PATH = "~/.deeplake/memory";
const HOME_VAR_PATH = "$HOME/.deeplake/memory";

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const SHELL_BUNDLE = existsSync(join(__bundleDir, "shell", "deeplake-shell.js"))
  ? join(__bundleDir, "shell", "deeplake-shell.js")
  : join(__bundleDir, "..", "shell", "deeplake-shell.js");

const SAFE_BUILTINS = new Set([
  "cat", "ls", "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod",
  "stat", "readlink", "du", "tree", "file",
  "grep", "egrep", "fgrep", "rg", "sed", "awk", "cut", "tr", "sort", "uniq",
  "wc", "head", "tail", "tac", "rev", "nl", "fold", "expand", "unexpand",
  "paste", "join", "comm", "column", "diff", "strings", "split",
  "find", "xargs", "which",
  "jq", "yq", "xan", "base64", "od",
  "tar", "gzip", "gunzip", "zcat",
  "md5sum", "sha1sum", "sha256sum",
  "echo", "printf", "tee",
  "pwd", "cd", "basename", "dirname", "env", "printenv", "hostname", "whoami",
  "date", "seq", "expr", "sleep", "timeout", "time", "true", "false", "test",
  "alias", "unalias", "history", "help", "clear",
  "for", "while", "do", "done", "if", "then", "else", "fi", "case", "esac",
]);

export interface CodexPreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: { command: string };
  cwd: string;
  hook_event_name: string;
  model: string;
  turn_id?: string;
}

export interface CodexPreToolDecision {
  action: "pass" | "guide" | "block";
  output?: string;
  rewrittenCommand?: string;
}

export function isSafe(cmd: string): boolean {
  if (/\$\(|`|<\(/.test(cmd)) return false;
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, "\"\"");
  const stages = stripped.split(/\||;|&&|\|\||\n/);
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken)) return false;
  }
  return true;
}

export function touchesMemory(cmd: string): boolean {
  return cmd.includes(MEMORY_PATH) || cmd.includes(TILDE_PATH) || cmd.includes(HOME_VAR_PATH);
}

export function rewritePaths(cmd: string): string {
  return cmd
    .replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/")
    .replace(/~\/.deeplake\/memory\/?/g, "/")
    .replace(/\$HOME\/.deeplake\/memory\/?/g, "/")
    .replace(/"\$HOME\/.deeplake\/memory\/?"/g, "\"/\"");
}

export function buildUnsupportedGuidance(): string {
  return "This command is not supported for ~/.deeplake/memory/ operations. " +
    "Only bash builtins are available: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find, etc. " +
    "Do NOT use python, python3, node, curl, or other interpreters. " +
    "Rewrite your command using only bash tools and retry.";
}

export function runVirtualShell(cmd: string, shellBundle = SHELL_BUNDLE, logFn: (msg: string) => void = log): string {
  try {
    return execFileSync("node", [shellBundle, "-c", cmd], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    logFn(`virtual shell failed: ${e.message}`);
    return "";
  }
}

function buildIndexContent(rows: Record<string, unknown>[]): string {
  const lines = ["# Memory Index", "", `${rows.length} sessions:`, ""];
  for (const row of rows) {
    const path = row["path"] as string;
    const project = row["project"] as string || "";
    const description = (row["description"] as string || "").slice(0, 120);
    const date = (row["creation_date"] as string || "").slice(0, 10);
    lines.push(`- [${path}](${path}) ${date} ${project ? `[${project}]` : ""} ${description}`);
  }
  return lines.join("\n");
}

interface CodexPreToolDeps {
  config?: ReturnType<typeof loadConfig>;
  createApi?: (table: string, config: NonNullable<ReturnType<typeof loadConfig>>) => DeeplakeApi;
  readVirtualPathContentFn?: typeof readVirtualPathContent;
  listVirtualPathRowsFn?: typeof listVirtualPathRows;
  findVirtualPathsFn?: typeof findVirtualPaths;
  handleGrepDirectFn?: typeof handleGrepDirect;
  runVirtualShellFn?: typeof runVirtualShell;
  shellBundle?: string;
  logFn?: (msg: string) => void;
}

export async function processCodexPreToolUse(
  input: CodexPreToolUseInput,
  deps: CodexPreToolDeps = {},
): Promise<CodexPreToolDecision> {
  const {
    config = loadConfig(),
    createApi = (table, activeConfig) => new DeeplakeApi(
      activeConfig.token,
      activeConfig.apiUrl,
      activeConfig.orgId,
      activeConfig.workspaceId,
      table,
    ),
    readVirtualPathContentFn = readVirtualPathContent,
    listVirtualPathRowsFn = listVirtualPathRows,
    findVirtualPathsFn = findVirtualPaths,
    handleGrepDirectFn = handleGrepDirect,
    runVirtualShellFn = runVirtualShell,
    shellBundle = SHELL_BUNDLE,
    logFn = log,
  } = deps;

  const cmd = input.tool_input?.command ?? "";
  logFn(`hook fired: cmd=${cmd}`);

  if (!touchesMemory(cmd)) return { action: "pass" };

  const rewritten = rewritePaths(cmd);
  if (!isSafe(rewritten)) {
    const guidance = buildUnsupportedGuidance();
    logFn(`unsupported command, returning guidance: ${rewritten}`);
    return {
      action: "guide",
      output: guidance,
      rewrittenCommand: rewritten,
    };
  }

  if (config) {
    const table = process.env["HIVEMIND_TABLE"] ?? "memory";
    const sessionsTable = process.env["HIVEMIND_SESSIONS_TABLE"] ?? "sessions";
    const api = createApi(table, config);

    try {
      let virtualPath: string | null = null;
      let lineLimit = 0;
      let fromEnd = false;

      const catCmd = rewritten.replace(/\s+2>\S+/g, "").trim();
      const catPipeHead = catCmd.match(/^cat\s+(\S+?)\s*(?:\|[^|]*)*\|\s*head\s+(?:-n?\s*)?(-?\d+)\s*$/);
      if (catPipeHead) {
        virtualPath = catPipeHead[1];
        lineLimit = Math.abs(parseInt(catPipeHead[2], 10));
      }
      if (!virtualPath) {
        const catMatch = catCmd.match(/^cat\s+(\S+)\s*$/);
        if (catMatch) virtualPath = catMatch[1];
      }
      if (!virtualPath) {
        const headMatch = rewritten.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/)
          ?? rewritten.match(/^head\s+(\S+)\s*$/);
        if (headMatch) {
          if (headMatch[2]) {
            virtualPath = headMatch[2];
            lineLimit = Math.abs(parseInt(headMatch[1], 10));
          } else {
            virtualPath = headMatch[1];
            lineLimit = 10;
          }
        }
      }
      if (!virtualPath) {
        const tailMatch = rewritten.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/)
          ?? rewritten.match(/^tail\s+(\S+)\s*$/);
        if (tailMatch) {
          fromEnd = true;
          if (tailMatch[2]) {
            virtualPath = tailMatch[2];
            lineLimit = Math.abs(parseInt(tailMatch[1], 10));
          } else {
            virtualPath = tailMatch[1];
            lineLimit = 10;
          }
        }
      }
      if (!virtualPath) {
        const wcMatch = rewritten.match(/^wc\s+-l\s+(\S+)\s*$/);
        if (wcMatch) {
          virtualPath = wcMatch[1];
          lineLimit = -1;
        }
      }

      if (virtualPath && !virtualPath.endsWith("/")) {
        logFn(`direct read: ${virtualPath}`);
        let content = await readVirtualPathContentFn(api, table, sessionsTable, virtualPath);
        if (content === null && virtualPath === "/index.md") {
          const idxRows = await api.query(
            `SELECT path, project, description, creation_date FROM "${table}" WHERE path LIKE '/summaries/%' ORDER BY creation_date DESC`
          );
          content = buildIndexContent(idxRows);
        }

        if (content !== null) {
          if (lineLimit === -1) {
            return { action: "block", output: `${content.split("\n").length} ${virtualPath}`, rewrittenCommand: rewritten };
          }
          if (lineLimit > 0) {
            const lines = content.split("\n");
            content = fromEnd
              ? lines.slice(-lineLimit).join("\n")
              : lines.slice(0, lineLimit).join("\n");
          }
          return { action: "block", output: content, rewrittenCommand: rewritten };
        }
      }

      const lsMatch = rewritten.match(/^ls\s+(?:-[a-zA-Z]+\s+)*(\S+)?\s*$/);
      if (lsMatch) {
        const dir = (lsMatch[1] ?? "/").replace(/\/+$/, "") || "/";
        const isLong = /\s-[a-zA-Z]*l/.test(rewritten);
        logFn(`direct ls: ${dir}`);
        const rows = await listVirtualPathRowsFn(api, table, sessionsTable, dir);
        const entries = new Map<string, { isDir: boolean; size: number }>();
        const prefix = dir === "/" ? "/" : `${dir}/`;
        for (const row of rows) {
          const path = row["path"] as string;
          if (!path.startsWith(prefix) && dir !== "/") continue;
          const rest = dir === "/" ? path.slice(1) : path.slice(prefix.length);
          const slash = rest.indexOf("/");
          const name = slash === -1 ? rest : rest.slice(0, slash);
          if (!name) continue;
          const existing = entries.get(name);
          if (slash !== -1) {
            if (!existing) entries.set(name, { isDir: true, size: 0 });
          } else {
            entries.set(name, { isDir: false, size: (row["size_bytes"] as number) ?? 0 });
          }
        }

        if (entries.size > 0) {
          const lines: string[] = [];
          for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (isLong) {
              const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
              const size = info.isDir ? "0" : String(info.size).padStart(6);
              lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
            } else {
              lines.push(name + (info.isDir ? "/" : ""));
            }
          }
          return { action: "block", output: lines.join("\n"), rewrittenCommand: rewritten };
        }

        return {
          action: "block",
          output: `ls: cannot access '${dir}': No such file or directory`,
          rewrittenCommand: rewritten,
        };
      }

      const findMatch = rewritten.match(/^find\s+(\S+)\s+(?:-type\s+\S+\s+)?-name\s+'([^']+)'/);
      if (findMatch) {
        const dir = findMatch[1].replace(/\/+$/, "") || "/";
        const namePattern = sqlLike(findMatch[2]).replace(/\*/g, "%").replace(/\?/g, "_");
        logFn(`direct find: ${dir} -name '${findMatch[2]}'`);
        const paths = await findVirtualPathsFn(api, table, sessionsTable, dir, namePattern);
        let result = paths.join("\n") || "";
        if (/\|\s*wc\s+-l\s*$/.test(rewritten)) result = String(paths.length);
        return {
          action: "block",
          output: result || "(no matches)",
          rewrittenCommand: rewritten,
        };
      }

      const grepParams = parseBashGrep(rewritten);
      if (grepParams) {
        logFn(`direct grep: pattern=${grepParams.pattern} path=${grepParams.targetPath}`);
        const result = await handleGrepDirectFn(api, table, sessionsTable, grepParams);
        if (result !== null) {
          return { action: "block", output: result, rewrittenCommand: rewritten };
        }
      }
    } catch (e: any) {
      logFn(`direct query failed, falling back to shell: ${e.message}`);
    }
  }

  logFn(`intercepted → running via virtual shell: ${rewritten}`);
  const result = runVirtualShellFn(rewritten, shellBundle, logFn);
  return {
    action: "block",
    output: result || "[Deeplake Memory] Command returned empty or the file does not exist in cloud storage.",
    rewrittenCommand: rewritten,
  };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<CodexPreToolUseInput>();
  const decision = await processCodexPreToolUse(input);

  if (decision.action === "pass") return;
  if (decision.action === "guide") {
    if (decision.output) process.stdout.write(decision.output);
    process.exit(0);
  }
  if (decision.output) process.stderr.write(decision.output);
  process.exit(2);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
