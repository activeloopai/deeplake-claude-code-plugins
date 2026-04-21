#!/usr/bin/env node
/**
 * deeplake-shell — interactive virtual filesystem shell backed by Deeplake.
 *
 * Usage:
 *   # Interactive REPL
 *   npm run shell
 *
 *   # One-shot command
 *   npm run shell -- -c "ls /memory"
 *   npm run shell -- -c "echo 'hello world' > /memory/hello.txt && cat /memory/hello.txt"
 *
 * Environment / credentials (any of):
 *   HIVEMIND_TOKEN, HIVEMIND_ORG_ID        — required
 *   HIVEMIND_WORKSPACE_ID                  — default: "default"
 *   HIVEMIND_API_URL                       — default: https://api.deeplake.ai
 *   HIVEMIND_TABLE                         — default: "memory"
 *   HIVEMIND_MOUNT                         — virtual root path, default: "/memory"
 *
 * Or create ~/.deeplake/credentials.json:
 *   { "token": "...", "orgId": "...", "workspaceId": "default" }
 */

import { createInterface } from "node:readline";
import { Bash } from "just-bash";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "./deeplake-fs.js";
import { createGrepCommand } from "./grep-interceptor.js";

async function main(): Promise<void> {
  const isOneShot = process.argv.includes("-c");

  // One-shot mode is what the pre-tool-use hook invokes via `node shell-bundle -c "..."`
  // to execute compound bash commands. Claude Code's Bash tool merges the child's
  // stderr into the tool_result string Claude sees, so any `[deeplake-sql]` trace
  // written to stderr here pollutes the model's view of the command output.
  // Silence trace env vars regardless of how the caller set them.
  if (isOneShot) {
    delete process.env["HIVEMIND_TRACE_SQL"];
    delete process.env["DEEPLAKE_TRACE_SQL"];
    delete process.env["HIVEMIND_DEBUG"];
    delete process.env["DEEPLAKE_DEBUG"];
  }

  const config = loadConfig();
  if (!config) {
    process.stderr.write(
      "Deeplake credentials not found.\n" +
      "Set HIVEMIND_TOKEN + HIVEMIND_ORG_ID in environment, or create ~/.deeplake/credentials.json\n"
    );
    process.exit(1);
  }

  const table = process.env["HIVEMIND_TABLE"] ?? "memory";
  const sessionsTable = process.env["HIVEMIND_SESSIONS_TABLE"] ?? "sessions";
  const mount = process.env["HIVEMIND_MOUNT"] ?? "/";

  const client = new DeeplakeApi(
    config.token, config.apiUrl, config.orgId, config.workspaceId, table
  );

  if (!isOneShot) {
    process.stderr.write(`Connecting to deeplake://${config.workspaceId}/${table} ...\n`);
  }

  const fs = await DeeplakeFs.create(client, table, mount, sessionsTable);

  if (!isOneShot) {
    const fileCount = fs.getAllPaths().filter(p => !!p).length;
    process.stderr.write(`Ready. ${fileCount} files loaded.\n`);
  }

  const bash = new Bash({
    fs,
    cwd: mount,
    customCommands: [createGrepCommand(client, fs, table, sessionsTable)],
    env: {
      HOME: mount,
      HIVEMIND_TABLE: table,
      HIVEMIND_MOUNT: mount,
    },
  });

  // ── one-shot mode: npm run shell -- -c "..." ──────────────────────────────
  const cIdx = process.argv.indexOf("-c");
  if (cIdx !== -1 && process.argv[cIdx + 1]) {
    const result = await bash.exec(process.argv[cIdx + 1]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    await fs.flush();
    process.exit(result.exitCode);
  }

  // ── interactive REPL ──────────────────────────────────────────────────────
  process.stdout.write(`deeplake-shell (${mount})  — type 'exit' to quit\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: `ds:${mount}$ `,
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const cmd = line.trim();
    if (!cmd) { rl.prompt(); return; }
    if (cmd === "exit" || cmd === "quit") {
      await fs.flush();
      process.exit(0);
    }

    const result = await bash.exec(cmd);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    rl.prompt();
  });

  rl.on("close", async () => {
    await fs.flush();
    process.exit(0);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
