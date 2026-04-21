import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeeplakeFs, guessMime } from "../../src/shell/deeplake-fs.js";
import { extractDescription } from "../../src/hooks/upload-summary.js";

// ── Mock client (same pattern as deeplake-fs.test.ts) ────────────────────────
type Row = {
  id: string; path: string; filename: string;
  summary: string; mime_type: string; size_bytes: number;
  project: string; description: string; creation_date: string; last_update_date: string;
};

function makeClient(seed: Record<string, Buffer> = {}) {
  const rows: Row[] = Object.entries(seed).map(([path, content]) => ({
    id: `seed-${path}`,
    path,
    filename: path.split("/").pop()!,
    summary: content.toString("utf-8"),
    mime_type: guessMime(path.split("/").pop()!),
    size_bytes: content.length,
    project: "",
    description: "",
    creation_date: "",
    last_update_date: "",
  }));

  const client = {
    applyStorageCreds: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT path, size_bytes, mime_type")) {
        return rows.map(r => ({ path: r.path, size_bytes: r.size_bytes, mime_type: r.mime_type }));
      }
      if (sql.includes("SELECT summary FROM")) {
        const match = sql.match(/path = '([^']+)'/);
        const row = match ? rows.find(r => r.path === match[1]) : undefined;
        return row ? [{ summary: row.summary }] : [];
      }
      if (sql.includes("SELECT path, project, description, summary, creation_date")) {
        return rows
          .filter(r => r.path.startsWith("/summaries/"))
          .map(r => ({
            path: r.path, project: r.project, description: r.description, summary: r.summary,
            creation_date: r.creation_date, last_update_date: r.last_update_date,
          }));
      }
      if (sql.includes("<#>") || sql.includes("LIKE")) return [];
      if (sql.match(/DELETE.*WHERE path = '([^']+)'/)) {
        const match = sql.match(/path = '([^']+)'/);
        if (match) { const idx = rows.findIndex(r => r.path === match[1]); if (idx >= 0) rows.splice(idx, 1); }
        return [];
      }
      if (sql.includes("DELETE") && sql.includes("IN (")) {
        const match = sql.match(/IN \(([^)]+)\)/);
        if (match) {
          const paths = match[1].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
          for (const p of paths) { const idx = rows.findIndex(r => r.path === p); if (idx >= 0) rows.splice(idx, 1); }
        }
        return [];
      }
      if (sql.startsWith("UPDATE")) {
        const match = sql.match(/WHERE path = '([^']+)'/);
        if (match) {
          const row = rows.find(r => r.path === match[1]);
          if (row) {
            const ludMatch = sql.match(/last_update_date = '([^']+)'/);
            if (ludMatch) row.last_update_date = ludMatch[1];
            const cdMatch = sql.match(/creation_date = '([^']+)'/);
            if (cdMatch) row.creation_date = cdMatch[1];
            if (sql.includes("summary = summary ||")) {
              const appendMatch = sql.match(/summary \|\| E'((?:[^']|'')*)'/);
              if (appendMatch) {
                const appendText = appendMatch[1].replace(/''/g, "'");
                row.summary += appendText;
                row.size_bytes = Buffer.byteLength(row.summary, "utf-8");
              }
            } else {
              const textMatch = sql.match(/summary = E'((?:[^']|'')*)'/);
              if (textMatch) {
                row.summary = textMatch[1].replace(/''/g, "'");
                row.size_bytes = Buffer.byteLength(row.summary, "utf-8");
              }
            }
            const projMatch = sql.match(/project = '([^']*)'/);
            if (projMatch) row.project = projMatch[1];
            const descMatch = sql.match(/description = '([^']*)'/);
            if (descMatch) row.description = descMatch[1];
          }
        }
        return [];
      }
      if (sql.startsWith("INSERT")) {
        const valuesMatch = sql.match(/VALUES \((.+)\)$/s);
        if (valuesMatch) {
          const pathMatch = sql.match(/VALUES \('[^']+', '([^']+)'/);
          if (pathMatch) {
            const path = pathMatch[1];
            const colsPart = sql.match(/\(([^)]+)\)\s+VALUES/)?.[1] ?? "";
            const colsList = colsPart.split(",").map(c => c.trim());
            const valsStr = valuesMatch[1];
            const allVals: string[] = [];
            let i = 0;
            while (i < valsStr.length) {
              if (valsStr[i] === "'" || (valsStr.slice(i, i + 2) === "E'")) {
                const start = valsStr[i] === "E" ? i + 2 : i + 1;
                let end = start;
                while (end < valsStr.length) {
                  if (valsStr[end] === "'" && valsStr[end + 1] !== "'") break;
                  if (valsStr[end] === "'" && valsStr[end + 1] === "'") end++;
                  end++;
                }
                allVals.push(valsStr.slice(start, end).replace(/''/g, "'"));
                i = end + 1;
              } else if (/\d/.test(valsStr[i])) {
                const m = valsStr.slice(i).match(/^(\d+)/);
                if (m) { allVals.push(m[1]); i += m[1].length; } else i++;
              } else { i++; }
            }
            const colMap: Record<string, string> = {};
            for (let c = 0; c < colsList.length; c++) colMap[colsList[c]] = allVals[c] ?? "";
            const summary = colMap["summary"] ?? "";
            const idx = rows.findIndex(r => r.path === path);
            if (idx >= 0) rows.splice(idx, 1);
            rows.push({
              id: colMap["id"] ?? "", path, filename: path.split("/").pop()!,
              summary, mime_type: "text/plain", size_bytes: Buffer.byteLength(summary, "utf-8"),
              project: colMap["project"] ?? "", description: colMap["description"] ?? "",
              creation_date: colMap["creation_date"] ?? "", last_update_date: colMap["last_update_date"] ?? "",
            });
          }
        }
        return [];
      }
      return [];
    }),
    listTables: vi.fn().mockResolvedValue(["test"]),
    ensureTable: vi.fn().mockResolvedValue(undefined),
    _rows: rows,
  };
  return client;
}

async function makeFs(seed: Record<string, string | Buffer> = {}, mount = "/") {
  const bufSeed: Record<string, Buffer> = {};
  for (const [k, v] of Object.entries(seed)) bufSeed[k] = typeof v === "string" ? Buffer.from(v, "utf-8") : v;
  const client = makeClient(bufSeed);
  const fs = await DeeplakeFs.create(client as never, "test", mount);
  return { fs, client };
}

// ── Simulate createPlaceholder (mirrors session-start.ts logic) ──────────────
async function createPlaceholder(
  fs: DeeplakeFs, sessionId: string, cwd: string,
  userName: string, orgName: string, workspaceId: string,
) {
  try { await fs.mkdir("/summaries"); } catch { /* exists */ }
  try { await fs.mkdir(`/summaries/${userName}`); } catch { /* exists */ }
  try { await fs.mkdir("/sessions"); } catch { /* exists */ }

  const summaryPath = `/summaries/${userName}/${sessionId}.md`;
  const summaryExists = await fs.exists(summaryPath);

  if (!summaryExists) {
    const now = new Date().toISOString();
    const projectName = cwd.split("/").pop() ?? "unknown";
    const sessionSource = `/sessions/${userName}/${userName}_${orgName}_${workspaceId}_${sessionId}.jsonl`;
    await fs.writeFileWithMeta(summaryPath, [
      `# Session ${sessionId}`,
      `- **Source**: ${sessionSource}`,
      `- **Started**: ${now}`,
      `- **Project**: ${projectName}`,
      `- **Status**: in-progress`,
      "",
    ].join("\n"), {
      project: projectName,
      description: "in progress",
      creationDate: now,
      lastUpdateDate: now,
    });
    await fs.flush();
  }
}

// ── Simulate session-end summary upload (mirrors upload.mjs logic) ───────────
async function uploadSummary(
  fs: DeeplakeFs, client: ReturnType<typeof makeClient>,
  sessionId: string, userName: string, summaryContent: string, projectName: string,
) {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;
  await fs.writeFileWithMeta(summaryPath, summaryContent, {
    project: projectName,
    description: extractDescription(summaryContent),
    lastUpdateDate: new Date().toISOString(),
  });
  await fs.flush();
}

// ── Build wiki prompt PROJECT field (mirrors session-end.ts logic) ───────────
function buildWikiProjectField(cwd: string): string {
  return cwd.split("/").pop() || "unknown";
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("session summary — no global paths", () => {
  const globalPaths = [
    "/home/testuser/projects/deeplake-claude-code-plugins",
    "/Users/testuser/Git/deeplake-claude-code-plugins",
    "/home/ci/workspace/my-project",
    "/var/data/repos/my-project",
    "/tmp/workspace/my-project",
  ];

  for (const [i, globalPath] of globalPaths.entries()) {
    const sessionId = `session-${i + 1}-${crypto.randomUUID().slice(0, 8)}`;
    const userName = `user${i}`;
    const orgName = `org${i}`;
    const workspaceId = "default";

    it(`session ${i + 1}: placeholder has no global path (${globalPath})`, async () => {
      const { fs, client } = await makeFs({});
      await createPlaceholder(fs, sessionId, globalPath, userName, orgName, workspaceId);

      const row = client._rows.find(r => r.path.endsWith(`/${sessionId}.md`) && r.path.startsWith("/summaries/"));
      expect(row).toBeDefined();
      const content = row!.summary;

      // Must NOT contain the global path
      expect(content).not.toContain(globalPath);

      // Must contain the project name (last segment only)
      const projectName = globalPath.replace(/\\/g, "/").split("/").pop()!;
      expect(content).toContain(`- **Project**: ${projectName}`);

      // Must contain Source referencing the session JSONL
      expect(content).toContain(`- **Source**: /sessions/${userName}/${userName}_${orgName}_${workspaceId}_${sessionId}.jsonl`);

      // Must have the standard structure
      expect(content).toContain(`# Session ${sessionId}`);
      expect(content).toContain("- **Started**:");
      expect(content).toContain("- **Status**: in-progress");
    });
  }
});

describe("session summary — Source field structure", () => {
  it("Source points to correct JSONL path with user/org/workspace", async () => {
    const { fs, client } = await makeFs({});
    const sessionId = "abc-123-def";
    await createPlaceholder(fs, sessionId, "/some/deep/path/my-repo", "alice", "acme-corp", "prod");

    const content = client._rows.find(r => r.path.endsWith(`/${sessionId}.md`) && r.path.startsWith("/summaries/"))!.summary;
    expect(content).toContain("- **Source**: /sessions/alice/alice_acme-corp_prod_abc-123-def.jsonl");
  });
});

describe("session summary — wiki prompt uses project name not global path", () => {
  it("buildWikiProjectField returns last path segment", () => {
    expect(buildWikiProjectField("/home/testuser/projects/deeplake-claude-code-plugins")).toBe("deeplake-claude-code-plugins");
    expect(buildWikiProjectField("/Users/testuser/Git/my-project")).toBe("my-project");
    expect(buildWikiProjectField("")).toBe("unknown");
    expect(buildWikiProjectField("/single")).toBe("single");
  });
});

describe("session summary — resumed sessions update last_update_date", () => {
  it("overwriting summary updates last_update_date and description", async () => {
    const { fs, client } = await makeFs({});
    const sessionId = "resume-test-001";
    const cwd = "/home/user/projects/my-app";

    // Step 1: create initial placeholder (session-start)
    await createPlaceholder(fs, sessionId, cwd, "testuser", "testorg", "default");
    await fs.flush();

    const rowAfterStart = client._rows.find(r => r.path.endsWith(`/${sessionId}.md`) && r.path.startsWith("/summaries/"))!;
    const initialDate = rowAfterStart.last_update_date;
    expect(rowAfterStart.description).toBe("in progress");
    expect(rowAfterStart.project).toBe("my-app");

    // Small delay to get a different timestamp
    await new Promise(r => setTimeout(r, 50));

    // Step 2: simulate session-end uploading a completed summary
    const completedSummary = [
      `# Session ${sessionId}`,
      `- **Source**: /sessions/testuser/testuser_testorg_default_${sessionId}.jsonl`,
      `- **Started**: 2026-04-07T10:00:00.000Z`,
      `- **Ended**: 2026-04-07T11:00:00.000Z`,
      `- **Project**: my-app`,
      `- **JSONL offset**: 42`,
      "",
      "## What Happened",
      "Fixed authentication bug in the login flow. Added retry logic for token refresh.",
      "",
      "## Key Facts",
      "- Auth tokens now refresh automatically",
    ].join("\n");

    await uploadSummary(fs, client, sessionId, "testuser", completedSummary, "my-app");

    const rowAfterEnd = client._rows.find(r => r.path.endsWith(`/${sessionId}.md`) && r.path.startsWith("/summaries/"))!;
    // last_update_date must have changed
    expect(rowAfterEnd.last_update_date).not.toBe(initialDate);
    // description must be extracted from What Happened section
    expect(rowAfterEnd.description).toBe("Auth tokens now refresh automatically");
    // content must be the full summary
    expect(rowAfterEnd.summary).toContain("## What Happened");
    expect(rowAfterEnd.summary).toContain("## Key Facts");
    // No global path
    expect(rowAfterEnd.summary).not.toContain("/home/user/projects/my-app");
    expect(rowAfterEnd.summary).toContain("- **Project**: my-app");
  });

  it("resumed session (second follow-up) updates again", async () => {
    const { fs, client } = await makeFs({});
    const sessionId = "resume-test-002";

    // Round 1: placeholder
    await createPlaceholder(fs, sessionId, "/opt/repos/backend", "dev", "corp", "staging");
    await fs.flush();
    const date1 = client._rows.find(r => r.path.endsWith(`/${sessionId}.md`) && r.path.startsWith("/summaries/"))!.last_update_date;

    await new Promise(r => setTimeout(r, 50));

    // Round 2: first summary
    await uploadSummary(fs, client, sessionId, "dev", [
      `# Session ${sessionId}`,
      `- **Source**: /sessions/dev/dev_corp_staging_${sessionId}.jsonl`,
      `- **Project**: backend`,
      `- **JSONL offset**: 20`,
      "",
      "## What Happened",
      "Initial API endpoint scaffolding.",
    ].join("\n"), "backend");

    const date2 = client._rows.find(r => r.path.endsWith(`/${sessionId}.md`) && r.path.startsWith("/summaries/"))!.last_update_date;
    expect(date2).not.toBe(date1);

    await new Promise(r => setTimeout(r, 50));

    // Round 3: resumed session with more content
    await uploadSummary(fs, client, sessionId, "dev", [
      `# Session ${sessionId}`,
      `- **Source**: /sessions/dev/dev_corp_staging_${sessionId}.jsonl`,
      `- **Project**: backend`,
      `- **JSONL offset**: 45`,
      "",
      "## What Happened",
      "Initial API endpoint scaffolding. Added auth middleware and rate limiting.",
    ].join("\n"), "backend");

    const rowFinal = client._rows.find(r => r.path.endsWith(`/${sessionId}.md`) && r.path.startsWith("/summaries/"))!;
    const date3 = rowFinal.last_update_date;
    expect(date3).not.toBe(date2);
    expect(rowFinal.summary).toContain("rate limiting");
    expect(rowFinal.description).toContain("auth middleware");
  });
});

describe("session summary — virtual index uses project name", () => {
  it("index.md shows project name not global path for all 5 sessions", async () => {
    const sessions = [
      { id: "s1", cwd: "/home/alice/code/frontend", userName: "alice", orgName: "acme", ws: "default" },
      { id: "s2", cwd: "/Users/bob/Git/backend-api", userName: "bob", orgName: "acme", ws: "default" },
      { id: "s3", cwd: "/opt/ci/workspace/data-pipeline", userName: "ci-bot", orgName: "acme", ws: "prod" },
      { id: "s4", cwd: "/var/repos/mobile-app", userName: "carol", orgName: "startup", ws: "default" },
      { id: "s5", cwd: "/home/dave/projects/infra-tools", userName: "dave", orgName: "startup", ws: "staging" },
    ];

    const { fs, client } = await makeFs({});

    for (const s of sessions) {
      await createPlaceholder(fs, s.id, s.cwd, s.userName, s.orgName, s.ws);
    }

    // Read virtual index
    const index = await fs.readFile("/index.md");

    // Must contain project names (last path segments)
    expect(index).toContain("frontend");
    expect(index).toContain("backend-api");
    expect(index).toContain("data-pipeline");
    expect(index).toContain("mobile-app");
    expect(index).toContain("infra-tools");

    // Must NOT contain any global paths
    for (const s of sessions) {
      expect(index).not.toContain(s.cwd);
    }

    // All sessions listed
    for (const s of sessions) {
      expect(index).toContain(s.id);
    }
  });
});
