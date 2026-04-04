#!/usr/bin/env node

import { appendFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";

const MEMORY_DIR = process.env.DEEPLAKE_MEMORY_DIR ?? join(homedir(), ".deeplake", "memory");
const LOG = join(homedir(), ".deeplake", "hook-debug.log");
function log(msg: string) {
  appendFileSync(LOG, `${new Date().toISOString()} [pre] ${msg}\n`);
}

interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

function isMemorySearch(toolName: string, toolInput: Record<string, unknown>): string | null {
  const mp = MEMORY_DIR;
  const tilde = "~/.deeplake/memory";
  switch (toolName) {
    case "Grep": {
      const p = toolInput.path as string | undefined;
      if (p && (p.startsWith(mp) || p.startsWith(tilde))) {
        return (toolInput.pattern as string) ?? "";
      }
      break;
    }
    case "Read": {
      const fp = toolInput.file_path as string | undefined;
      if (fp && (fp.startsWith(mp) || fp.startsWith(tilde))) {
        return fp;
      }
      break;
    }
    case "Bash": {
      const cmd = toolInput.command as string | undefined;
      if (cmd && (cmd.includes(mp) || cmd.includes(tilde)) &&
          (cmd.includes("grep") || cmd.includes("cat") || cmd.includes("ls") || cmd.includes("find"))) {
        const grepMatch = cmd.match(/grep\s+(?:-[a-zA-Z]*\s+)*['"]?([^'">\s]+)/);
        return grepMatch?.[1] ?? "";
      }
      break;
    }
  }
  return null;
}

function searchMemory(query: string, limit = 20): { path: string; tool: string; snippet: string; timestamp: string }[] {
  if (!existsSync(MEMORY_DIR)) return [];
  const results: { path: string; tool: string; snippet: string; timestamp: string }[] = [];
  const q = query.toLowerCase();

  const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const lines = readFileSync(join(MEMORY_DIR, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const content = entry.tool_input ?? "";
        if (content.toLowerCase().includes(q) || (entry.tool_name ?? "").toLowerCase().includes(q)) {
          results.push({
            path: file,
            tool: entry.tool_name ?? "",
            snippet: content.slice(0, 500),
            timestamp: entry.timestamp ?? "",
          });
          if (results.length >= limit) return results;
        }
      } catch { /* skip */ }
    }
  }
  return results;
}

async function main(): Promise<void> {
  const input = await readStdin<PreToolUseInput>();

  const query = isMemorySearch(input.tool_name, input.tool_input);
  if (!query) return; // Not a memory search, let tool proceed normally

  log(`search intercepted: tool=${input.tool_name} query=${query}`);

  const results = searchMemory(query);
  log(`search found ${results.length} results`);

  if (results.length === 0) {
    console.log(JSON.stringify({ result: "No memories found matching: " + query }));
    process.exit(2);
  }

  const formatted = results
    .map((r, i) => `[${i + 1}] ${r.tool} at ${r.timestamp}\n${r.snippet}`)
    .join("\n\n");

  console.log(JSON.stringify({ result: formatted }));
  process.exit(2); // Exit 2 = hook handled the tool call
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
