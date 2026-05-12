/**
 * Resolve the test workspace credentials.
 *
 * Two modes, evaluated in order:
 *
 * 1. `HIVEMIND_E2E_CREDS_JSON` env var contains a full credentials.json
 *    blob — used in CI where no human-logged-in operator exists. Highest
 *    priority. If set, this is taken at face value and no API lookup is
 *    performed.
 *
 * 2. Local mode: read the operator's real `~/.deeplake/credentials.json`,
 *    keep the token + orgId, but resolve a fresh workspaceId by NAME from
 *    the workspace named `HIVEMIND_E2E_WORKSPACE_NAME` (default
 *    `hivemind_e2e_test`) and return the derived creds. The real creds
 *    file is read-only here — we never call saveCredentials() — so a
 *    harness crash mid-run cannot leave the operator's workspace
 *    selection in an unexpected state.
 *
 * The point of mode 2 is to make `npm run e2e` "just work" for the
 * developer who already has hivemind logged in. No separate creds blob
 * to maintain; no manual "switch workspace, run tests, switch back"
 * dance; no risk of writing to the wrong workspace because the harness
 * forgot to switch back.
 *
 * If both modes fail, we throw with a clear message describing what's
 * missing — runner.ts converts that to exit code 2 (harness misconfig).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listWorkspaces } from "../../src/commands/auth.js";
import type { TestCredentials } from "./types.js";

const DEFAULT_WORKSPACE_NAME = "hivemind_e2e_test";

interface OperatorCredsFile {
  token?: unknown;
  orgId?: unknown;
  orgName?: unknown;
  workspaceId?: unknown;
  apiUrl?: unknown;
}

export async function resolveTestCreds(): Promise<TestCredentials> {
  const tableSuffix = process.env.HIVEMIND_E2E_TABLE_SUFFIX ?? "";
  const cleanSuffix = tableSuffix ? `_${tableSuffix.replace(/[^a-zA-Z0-9_]/g, "_")}` : "";
  const sessionsTable = `sessions${cleanSuffix}`;
  const memoryTable = `memory${cleanSuffix}`;

  // Mode 1: explicit creds blob (CI).
  const blob = process.env.HIVEMIND_E2E_CREDS_JSON;
  if (blob) {
    const parsed = parseCredsBlob(blob);
    return { ...parsed, sessionsTable, memoryTable };
  }

  // Mode 2: derive from operator's logged-in creds + named workspace lookup.
  const operatorCreds = readOperatorCreds();
  if (!operatorCreds) {
    throw new Error(
      "no test credentials available. Either:\n" +
      "  - set HIVEMIND_E2E_CREDS_JSON to the full credentials.json blob (CI mode), or\n" +
      "  - run `hivemind login` so ~/.deeplake/credentials.json exists, and ensure your\n" +
      "    org contains a workspace named `hivemind_e2e_test` (or set\n" +
      "    HIVEMIND_E2E_WORKSPACE_NAME to whatever the e2e workspace is called).",
    );
  }
  const workspaceName = process.env.HIVEMIND_E2E_WORKSPACE_NAME ?? DEFAULT_WORKSPACE_NAME;
  const workspaces = await listWorkspaces(operatorCreds.token, operatorCreds.apiUrl, operatorCreds.orgId);
  const target = workspaces.find((w) => w.name === workspaceName);
  if (!target) {
    const known = workspaces.map((w) => w.name).join(", ") || "(none)";
    throw new Error(
      `no workspace named "${workspaceName}" in org ${operatorCreds.orgName ?? operatorCreds.orgId}.\n` +
      `Known workspaces: ${known}.\n` +
      `Either create the workspace and re-run, or set HIVEMIND_E2E_WORKSPACE_NAME ` +
      `to point at an existing one.`,
    );
  }
  return {
    apiUrl: operatorCreds.apiUrl,
    token: operatorCreds.token,
    orgId: operatorCreds.orgId,
    orgName: operatorCreds.orgName,
    // The KEY substitution: real creds keep the operator's workspaceId;
    // this derived copy points at the named e2e workspace. The operator's
    // file on disk is untouched.
    workspaceId: target.id,
    sessionsTable,
    memoryTable,
  };
}

interface OperatorCreds {
  token: string;
  apiUrl: string;
  orgId: string;
  orgName?: string;
  workspaceId: string;
}

function readOperatorCreds(): OperatorCreds | null {
  const path = join(homedir(), ".deeplake", "credentials.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: OperatorCredsFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed.token !== "string" ||
    typeof parsed.orgId !== "string" ||
    typeof parsed.workspaceId !== "string"
  ) {
    return null;
  }
  return {
    token: parsed.token,
    apiUrl: typeof parsed.apiUrl === "string" && parsed.apiUrl.length > 0
      ? parsed.apiUrl
      : "https://api.deeplake.ai",
    orgId: parsed.orgId,
    orgName: typeof parsed.orgName === "string" ? parsed.orgName : undefined,
    workspaceId: parsed.workspaceId,
  };
}

function parseCredsBlob(blob: string): Omit<TestCredentials, "sessionsTable" | "memoryTable"> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blob);
  } catch (e) {
    throw new Error(
      `HIVEMIND_E2E_CREDS_JSON is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const required = (k: string): string => {
    const v = parsed[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`HIVEMIND_E2E_CREDS_JSON missing required string field "${k}"`);
    }
    return v;
  };
  return {
    apiUrl: required("apiUrl"),
    token: required("token"),
    orgId: required("orgId"),
    orgName: typeof parsed.orgName === "string" ? parsed.orgName : undefined,
    workspaceId: required("workspaceId"),
  };
}
