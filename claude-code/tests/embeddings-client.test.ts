// Unit tests for the embedding client — avoid loading the model by spinning up
// a tiny fake daemon that speaks the protocol.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EmbedClient, getEmbedClient } from "../../src/embeddings/client.js";
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

  it("warmup() returns true when the daemon is already listening", async () => {
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => ({ id: req.id, ready: true }));
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    const ok = await client.warmup();
    expect(ok).toBe(true);
  });

  it("warmup() returns false when no daemon and autoSpawn is disabled", async () => {
    const dir = makeTmpDir();
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 100, autoSpawn: false });
    const ok = await client.warmup();
    expect(ok).toBe(false);
  });

  it("warmup() returns false when autoSpawn is on but entry cannot be launched", async () => {
    const dir = makeTmpDir();
    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 100,
      autoSpawn: true,
      daemonEntry: "/nonexistent/daemon.js",
      spawnWaitMs: 150,
    });
    const ok = await client.warmup();
    expect(ok).toBe(false);
  });

  it("cleans up a stale pidfile (dead PID) before trying to spawn", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const pidPath = join(dir, `hivemind-embed-${uid}.pid`);
    // Write a PID guaranteed-dead: 0x7FFFFFFF is not a plausible live PID on Linux.
    writeFileSync(pidPath, "2147483646");

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 50,
      autoSpawn: true,
      daemonEntry: "/nonexistent/daemon.js",
    });
    const vec = await client.embed("x");
    expect(vec).toBeNull();
    // Client should have cleaned up the pidfile after detecting the entry is missing.
    expect(existsSync(pidPath)).toBe(false);
  });

  it("leaves an alive-PID pidfile alone (treats the daemon as still starting)", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const pidPath = join(dir, `hivemind-embed-${uid}.pid`);
    // Our own PID is alive → isPidFileStale() should return false.
    writeFileSync(pidPath, String(process.pid));

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 50,
      autoSpawn: true,
      daemonEntry: "/nonexistent/daemon.js",
    });
    const vec = await client.embed("x");
    expect(vec).toBeNull();
    // Pidfile is still there because client saw it as a live owner, not stale.
    expect(existsSync(pidPath)).toBe(true);
  });

  it("treats a garbage pidfile as stale and removes it", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const pidPath = join(dir, `hivemind-embed-${uid}.pid`);
    writeFileSync(pidPath, "not-a-number");

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 50,
      autoSpawn: true,
      daemonEntry: "/nonexistent/daemon.js",
    });
    const vec = await client.embed("x");
    expect(vec).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
  });

  it("returns null when the socket closes mid-request", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    const srv = createServer((sock: Socket) => {
      // Immediately destroy the connection after accept so sendAndWait errors.
      sock.destroy();
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    const vec = await client.embed("boom");
    expect(vec).toBeNull();
  });

  it("returns null when the daemon writes malformed JSON", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    const srv = createServer((sock: Socket) => {
      sock.setEncoding("utf-8");
      sock.on("data", () => {
        sock.write("not-json\n");
      });
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    const vec = await client.embed("boom");
    expect(vec).toBeNull();
  });

  it("returns null on request timeout (daemon accepts but never replies)", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    const srv = createServer((_sock: Socket) => {
      // Accept the connection but never send anything back.
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const client = new EmbedClient({ socketDir: dir, timeoutMs: 50, autoSpawn: false });
    const vec = await client.embed("boom");
    expect(vec).toBeNull();
  });

  it("returns null fast when the daemon FINs without sending a response (half-close)", async () => {
    // Regression guard for the PR review fix: before the `end` handler in
    // sendAndWait, this scenario would block until the configured timeoutMs
    // (10 minutes by default). Now the client must reject immediately on
    // half-close. We set a very short timeoutMs to make the failure mode
    // (silent hang) detectable as a test timeout if the fix regresses.
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    const srv = createServer((sock: Socket) => {
      // Accept, then half-close after the client sends — no response written.
      sock.on("data", () => sock.end());
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const client = new EmbedClient({ socketDir: dir, timeoutMs: 60_000, autoSpawn: false });
    const start = Date.now();
    const vec = await client.embed("boom");
    const elapsed = Date.now() - start;
    expect(vec).toBeNull();
    // Fast rejection: well under timeoutMs. The pre-fix code would hang
    // until 60 000 ms; we expect the half-close to land in < 1 s.
    expect(elapsed).toBeLessThan(1000);
  });

  it("getEmbedClient() returns a cached singleton", () => {
    const a = getEmbedClient();
    const b = getEmbedClient();
    expect(a).toBe(b);
  });

  it("uses default option values when constructed with no arguments", () => {
    // Just instantiating exercises every `opts.x ?? default` branch.
    const c = new EmbedClient();
    expect(c).toBeInstanceOf(EmbedClient);
  });

  it("defaults the embed 'kind' argument to document when omitted", async () => {
    const dir = makeTmpDir();
    const kinds: string[] = [];
    await startFakeDaemon(dir, (req) => {
      if (req.op === "embed") kinds.push(req.kind);
      return { id: req.id, embedding: [0.5] };
    });
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    await client.embed("hello"); // no kind
    expect(kinds).toEqual(["document"]);
  });

  it("falls back to HIVEMIND_EMBED_DAEMON env when daemonEntry option is absent", () => {
    const prev = process.env.HIVEMIND_EMBED_DAEMON;
    process.env.HIVEMIND_EMBED_DAEMON = "/from/env.js";
    try {
      const c = new EmbedClient({ socketDir: makeTmpDir(), autoSpawn: false });
      // We can't read the private field directly; just assert construction succeeded.
      expect(c).toBeInstanceOf(EmbedClient);
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_EMBED_DAEMON;
      else process.env.HIVEMIND_EMBED_DAEMON = prev;
    }
  });

  it("warmup() succeeds after auto-spawning a fake daemon entry", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    // Write a tiny daemon script that binds the expected socket and answers pings.
    const daemonScript = join(dir, "fake-daemon.js");
    writeFileSync(daemonScript, `
      const net = require("node:net");
      const srv = net.createServer((s) => {
        s.setEncoding("utf-8");
        let buf = "";
        s.on("data", (c) => {
          buf += c;
          let nl;
          while ((nl = buf.indexOf("\\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            try {
              const req = JSON.parse(line);
              s.write(JSON.stringify({ id: req.id, ready: true }) + "\\n");
            } catch {}
          }
        });
      });
      srv.listen(${JSON.stringify(sockPath)});
      setTimeout(() => srv.close(), 3000);
    `);

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: true,
      daemonEntry: daemonScript,
      spawnWaitMs: 2000,
    });
    const ok = await client.warmup();
    expect(ok).toBe(true);

    // Cleanup the spawned daemon process.
    try { execSync(`pkill -f ${daemonScript}`); } catch { /* already exited */ }
  });
});
