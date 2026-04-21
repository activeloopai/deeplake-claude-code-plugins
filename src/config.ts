import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

export interface Config {
  token: string;
  orgId: string;
  orgName: string;
  userName: string;
  workspaceId: string;
  apiUrl: string;
  tableName: string;
  sessionsTableName: string;
  graphNodesTableName: string;
  graphEdgesTableName: string;
  factsTableName: string;
  entitiesTableName: string;
  factEntityLinksTableName: string;
  memoryPath: string;
}

interface Credentials {
  token: string;
  orgId: string;
  orgName?: string;
  userName?: string;
  workspaceId?: string;
  apiUrl?: string;
}

export function loadConfig(): Config | null {
  const home = homedir();
  const credPath = join(home, ".deeplake", "credentials.json");

  let creds: Credentials | null = null;
  if (existsSync(credPath)) {
    try {
      creds = JSON.parse(readFileSync(credPath, "utf-8"));
    } catch {
      return null;
    }
  }

  // Backwards-compat: fall back to DEEPLAKE_* env vars after HIVEMIND_*. Warn once if used.
  const env = process.env;
  if (!env.HIVEMIND_TOKEN && env.DEEPLAKE_TOKEN) {
    process.stderr.write("[hivemind] DEEPLAKE_* env vars are deprecated; use HIVEMIND_* instead\n");
  }
  const token = env.HIVEMIND_TOKEN ?? env.DEEPLAKE_TOKEN ?? creds?.token;
  const orgId = env.HIVEMIND_ORG_ID ?? env.DEEPLAKE_ORG_ID ?? creds?.orgId;
  if (!token || !orgId) return null;

  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: env.HIVEMIND_WORKSPACE_ID ?? env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: env.HIVEMIND_API_URL ?? env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: env.HIVEMIND_TABLE ?? env.DEEPLAKE_TABLE ?? "memory",
    sessionsTableName: env.HIVEMIND_SESSIONS_TABLE ?? env.DEEPLAKE_SESSIONS_TABLE ?? "sessions",
    graphNodesTableName: env.HIVEMIND_GRAPH_NODES_TABLE ?? env.DEEPLAKE_GRAPH_NODES_TABLE ?? "graph_nodes",
    graphEdgesTableName: env.HIVEMIND_GRAPH_EDGES_TABLE ?? env.DEEPLAKE_GRAPH_EDGES_TABLE ?? "graph_edges",
    factsTableName: env.HIVEMIND_FACTS_TABLE ?? env.DEEPLAKE_FACTS_TABLE ?? "memory_facts",
    entitiesTableName: env.HIVEMIND_ENTITIES_TABLE ?? env.DEEPLAKE_ENTITIES_TABLE ?? "memory_entities",
    factEntityLinksTableName: env.HIVEMIND_FACT_ENTITY_LINKS_TABLE ?? env.DEEPLAKE_FACT_ENTITY_LINKS_TABLE ?? "fact_entity_links",
    memoryPath: env.HIVEMIND_MEMORY_PATH ?? env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory"),
  };
}
