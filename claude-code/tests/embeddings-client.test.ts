// Unit tests for the embedding client — avoid loading the model by spinning up
// a tiny fake daemon that speaks the protocol.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedClient } from "../../src/embeddings/client.js";
import type { DaemonRequest, DaemonResponse } from "../../src/embeddings/protocol.js";

let servers: Server[] = [];
let tmpDirs: string[] = [];

afterEach(() => {
  for (const s of servers) try { s.close(); } catch { /* */ }
  servers = [];
  for (const d of tmpDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  tmpDirs = [];
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hvm-embed-test-"));
  tmpDirs.push(d);
  return d;
}

async function startFakeDaemon(dir: string, handler: (req: DaemonRequest) => DaemonResponse): Promise<Server> {
  const uid = String(process.getuid?.() ?? "test");
  const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
  const srv = createServer((sock: Socket) => {
    let buf = "";
    sock.setEncoding("utf-8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line) as DaemonRequest;
        const resp = handler(req);
        sock.write(JSON.stringify(resp) + "\n");
      }
    });
    sock.on("error", () => { /* */ });
  });
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
  return srv;
}

describe("EmbedClient", () => {
  it("returns the embedding vector when the daemon responds", async () => {
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => {
      if (req.op === "embed") return { id: req.id, embedding: [0.1, 0.2, 0.3] };
      return { id: req.id, ready: true };
    });
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    const vec = await client.embed("hello", "document");
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns null when the daemon returns an error", async () => {
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => ({ id: req.id, error: "boom" }));
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    const vec = await client.embed("hello");
    expect(vec).toBeNull();
  });

  it("returns null when no daemon is running and autoSpawn is disabled", async () => {
    const dir = makeTmpDir();
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 100, autoSpawn: false });
    const vec = await client.embed("hello");
    expect(vec).toBeNull();
  });

  it("does not create a duplicate pidfile under concurrent first-call race", async () => {
    const dir = makeTmpDir();
    const client1 = new EmbedClient({
      socketDir: dir,
      timeoutMs: 50,
      autoSpawn: true,
      daemonEntry: "/nonexistent/daemon.js", // guarantee spawn can't succeed
    });
    const client2 = new EmbedClient({
      socketDir: dir,
      timeoutMs: 50,
      autoSpawn: true,
      daemonEntry: "/nonexistent/daemon.js",
    });
    // Both clients see no socket, both try spawnDaemon. O_EXCL guarantees only
    // one actually tries to spawn. Both return null because no daemon comes up.
    const [a, b] = await Promise.all([
      client1.embed("one"),
      client2.embed("two"),
    ]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    // pidfile should have been cleaned up when spawn couldn't find the entry.
    const uid = String(process.getuid?.() ?? "test");
    expect(existsSync(join(dir, `hivemind-embed-${uid}.pid`))).toBe(false);
  });

  it("round-trips multiple requests on the same client without leaking sockets", async () => {
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => ({ id: req.id, embedding: [Math.random()] }));
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    const results = await Promise.all([
      client.embed("a"),
      client.embed("b"),
      client.embed("c"),
    ]);
    expect(results.every((r) => r !== null && r.length === 1)).toBe(true);
  });
});
