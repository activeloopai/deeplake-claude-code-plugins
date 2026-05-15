import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for src/cli/install-mcp-shared.ts. The shared MCP server installer
 * is invoked by Tier B consumers (Hermes, future Cline/Roo/Kilo wiring).
 * It owns one disk path: ~/.hivemind/mcp/.
 */

let tmpRoot: string;
let tmpHome: string;
let tmpPkg: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `hm-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpHome = join(tmpRoot, "home");
  tmpPkg = join(tmpRoot, "pkg");
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(join(tmpPkg, "mcp", "bundle"), { recursive: true });
  writeFileSync(join(tmpPkg, "mcp", "bundle", "server.js"), "// fake server");
  writeFileSync(join(tmpPkg, "package.json"), JSON.stringify({ version: "5.5.5" }));

  vi.stubEnv("HOME", tmpHome);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importMcpShared(): Promise<typeof import("../../src/cli/install-mcp-shared.js")> {
  vi.resetModules();
  vi.doMock("../../src/cli/util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
    return { ...actual, pkgRoot: () => tmpPkg };
  });
  return await import("../../src/cli/install-mcp-shared.js");
}

describe("ensureMcpServerInstalled", () => {
  it("creates ~/.hivemind/mcp/server.js and stamps the version", async () => {
    const { ensureMcpServerInstalled, MCP_SERVER_PATH, HIVEMIND_DIR } = await importMcpShared();
    ensureMcpServerInstalled();

    expect(MCP_SERVER_PATH).toBe(join(tmpHome, ".hivemind", "mcp", "server.js"));
    expect(existsSync(MCP_SERVER_PATH)).toBe(true);
    expect(readFileSync(join(HIVEMIND_DIR, ".hivemind_version"), "utf-8")).toBe("5.5.5");
  });

  it("is idempotent — re-install over an existing copy leaves a working server.js", async () => {
    const { ensureMcpServerInstalled, MCP_SERVER_PATH } = await importMcpShared();
    ensureMcpServerInstalled();
    // Mutate to detect overwrite.
    writeFileSync(MCP_SERVER_PATH, "stale-content");
    ensureMcpServerInstalled();
    expect(readFileSync(MCP_SERVER_PATH, "utf-8")).toBe("// fake server");
  });

  it("throws with a clear 'run npm run build' hint when the source bundle is missing", async () => {
    rmSync(join(tmpPkg, "mcp", "bundle"), { recursive: true, force: true });
    const { ensureMcpServerInstalled } = await importMcpShared();
    expect(() => ensureMcpServerInstalled()).toThrow(/MCP server bundle missing/);
    expect(() => ensureMcpServerInstalled()).toThrow(/npm run build/);
  });
});

describe("buildMcpServerEntry", () => {
  it("returns a stdio-transport entry pointing at MCP_SERVER_PATH", async () => {
    const { buildMcpServerEntry, MCP_SERVER_PATH } = await importMcpShared();
    expect(buildMcpServerEntry()).toEqual({
      command: "node",
      args: [MCP_SERVER_PATH],
    });
  });
});
