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
 *   DEEPLAKE_TOKEN, DEEPLAKE_ORG_ID        — required
 *   DEEPLAKE_WORKSPACE_ID                  — default: "default"
 *   DEEPLAKE_API_URL                       — default: https://api.deeplake.ai
 *   DEEPLAKE_TABLE                         — default: "memory"
 *   DEEPLAKE_MOUNT                         — virtual mount point, default: "/memory"
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
  const config = loadConfig();
  if (!config) {
    process.stderr.write(
      "Deeplake credentials not found.\n" +
      "Set DEEPLAKE_TOKEN + DEEPLAKE_ORG_ID in environment, or create ~/.deeplake/credentials.json\n"
    );
    process.exit(1);
  }

  // Shell defaults to "memory" regardless of DEEPLAKE_MEMORY_TABLE (used by hooks).
  // Override explicitly with DEEPLAKE_TABLE if needed.
  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
  const mount = process.env["DEEPLAKE_MOUNT"] ?? "/";

  const client = new DeeplakeApi(
    config.token, config.apiUrl, config.orgId, config.workspaceId, table
  );

  process.stderr.write(`Mounting deeplake://${config.workspaceId}/${table} at ${mount} ...\n`);

  const fs = await DeeplakeFs.create(client, table, mount);
  const fileCount = fs.getAllPaths().filter(p => !!p).length;
  process.stderr.write(`Ready. ${fileCount} files loaded.\n`);

  const bash = new Bash({
    fs,
    cwd: mount,
    customCommands: [createGrepCommand(client, fs, table)],
    env: {
      HOME: mount,
      DEEPLAKE_TABLE: table,
      DEEPLAKE_MOUNT: mount,
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
