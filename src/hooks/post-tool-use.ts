#!/usr/bin/env node

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { extractMemoryOp } from "../path-match.js";
import { DeeplakeApi } from "../deeplake-api.js";

interface PostToolUseInput {
  session_id: string;
  transcript_path: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
}

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseInput>();
  const config = loadConfig();
  if (!config) return;

  const match = extractMemoryOp(input.tool_name, input.tool_input, config.memoryPath);
  if (!match) return;

  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);

  let content = "";
  switch (match.op) {
    case "write":
      content = (input.tool_input.content as string) ?? "";
      break;
    case "edit":
      content = (input.tool_input.new_string as string) ?? "";
      break;
    case "bash":
      content = (input.tool_input.command as string) ?? "";
      break;
    default:
      // read/list/search — log the access, no content to sync
      break;
  }

  await api.logOp(input.session_id, match.path, match.op, content);
}

main().catch(() => process.exit(0));
