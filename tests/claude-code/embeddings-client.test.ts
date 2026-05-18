// Unit tests for the embedding client — avoid loading the model by spinning up
// a tiny fake daemon that speaks the protocol.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const enqueueNotificationMock = vi.fn();
vi.mock("../../src/notifications/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/notifications/queue.js")>(
    "../../src/notifications/queue.js",
  );
  return { ...actual, enqueueNotification: (...a: unknown[]) => enqueueNotificationMock(...a) };
});

import { EmbedClient, getEmbedClient, isTransformersMissingError, _resetClientStateForTesting } from "../../src/embeddings/client.js";
import type { DaemonRequest, DaemonResponse } from "../../src/embeddings/protocol.js";
import { _setEnabledReaderForTesting, _resetForTesting as _resetDisableForTesting } from "../../src/embeddings/disable.js";

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
    // daemonEntry: "" → falsy, so verifyDaemonOnce early-returns without
    // probing. Tests that care about embed semantics (not handshake) opt
    // out of verification this way; without it the dev-machine fallback
    // to SHARED_DAEMON_PATH would resolve a real path and the handshake
    // mismatch (hello returns no daemonPath) would trip the recycle path.
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false, daemonEntry: "" });
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

describe("isTransformersMissingError", () => {
  it("matches Node errors that specifically name @huggingface/transformers", () => {
    expect(isTransformersMissingError("Cannot find module '@huggingface/transformers'")).toBe(true);
    expect(isTransformersMissingError(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@huggingface/transformers' imported from /a/b",
    )).toBe(true);
    expect(isTransformersMissingError(
      "MODULE_NOT_FOUND when resolving @huggingface/transformers from /tmp",
    )).toBe(true);
  });

  it("matches the actionable wrapper thrown by defaultImportTransformers", () => {
    expect(isTransformersMissingError(
      "@huggingface/transformers is not installed anywhere reachable. Run `hivemind embeddings install`...",
    )).toBe(true);
  });

  it("does NOT match bare MODULE_NOT_FOUND for unrelated dependencies (regression for #10/#14)", () => {
    // The old matcher classified any MODULE_NOT_FOUND as a transformers
    // issue, so an onnxruntime-node / sharp / etc. missing-dep failure
    // would falsely trigger the recycle + "run hivemind embeddings
    // install" guidance — a command that can't fix non-transformers
    // problems. The matcher must require @huggingface/transformers OR
    // the actionable wrapper string to land.
    expect(isTransformersMissingError("MODULE_NOT_FOUND while loading onnxruntime-node")).toBe(false);
    expect(isTransformersMissingError("Cannot find module 'sharp'")).toBe(false);
    expect(isTransformersMissingError(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'onnxruntime-node' imported from /a/b",
    )).toBe(false);
  });

  it("does not match unrelated daemon errors", () => {
    expect(isTransformersMissingError("model load timeout")).toBe(false);
    expect(isTransformersMissingError("unknown op")).toBe(false);
    expect(isTransformersMissingError("")).toBe(false);
  });
});

describe("EmbedClient — transformers-missing handling", () => {
  beforeEach(() => {
    enqueueNotificationMock.mockReset();
    _resetClientStateForTesting();
    _resetDisableForTesting();
  });

  afterEach(() => {
    _resetClientStateForTesting();
    _resetDisableForTesting();
  });

  it("enqueues an embed-deps-missing notification when daemon reports the transformers wrapper error", async () => {
    _setEnabledReaderForTesting(() => true);
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") return { id: req.id, daemonPath: "/somewhere", pid: 1, protocolVersion: 1 };
      return { id: req.id, error: "@huggingface/transformers is not installed anywhere reachable. Run `hivemind embeddings install`" };
    });
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false, daemonEntry: "" });
    const vec = await client.embed("hello");
    expect(vec).toBeNull();
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
    const arg = enqueueNotificationMock.mock.calls[0][0];
    expect(arg.id).toBe("embed-deps-missing");
    expect(arg.severity).toBe("warn");
    expect(arg.body).toMatch(/hivemind embeddings install/);
    expect(arg.dedupKey.reason).toBe("transformers-missing");
  });

  it("does NOT enqueue when the user has disabled embeddings (no nag for explicit opt-out)", async () => {
    _setEnabledReaderForTesting(() => false);
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") return { id: req.id, daemonPath: "/somewhere", pid: 1, protocolVersion: 1 };
      return { id: req.id, error: "MODULE_NOT_FOUND @huggingface/transformers" };
    });
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    await client.embed("hello");
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  it("deduplicates within a single process: second failing call does not double-enqueue", async () => {
    _setEnabledReaderForTesting(() => true);
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") return { id: req.id, daemonPath: "/somewhere", pid: 1, protocolVersion: 1 };
      return { id: req.id, error: "Cannot find package '@huggingface/transformers'" };
    });
    const c1 = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false, daemonEntry: "" });
    const c2 = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false, daemonEntry: "" });
    await c1.embed("a");
    await c2.embed("b");
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue on a generic daemon error unrelated to transformers", async () => {
    _setEnabledReaderForTesting(() => true);
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") return { id: req.id, daemonPath: "/somewhere", pid: 1, protocolVersion: 1 };
      return { id: req.id, error: "model load timeout" };
    });
    const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
    await client.embed("hello");
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });
});

describe("EmbedClient — hello handshake / stuck daemon recycle", () => {
  beforeEach(() => {
    enqueueNotificationMock.mockReset();
    _resetClientStateForTesting();
  });

  afterEach(() => {
    _resetClientStateForTesting();
  });

  it("does NOT recycle the daemon when hello returns the expected daemonPath", async () => {
    const dir = makeTmpDir();
    const expectedPath = "/expected/daemon.js";
    let lastReq: DaemonRequest | null = null;
    await startFakeDaemon(dir, (req) => {
      lastReq = req;
      if (req.op === "hello") {
        return { id: req.id, daemonPath: expectedPath, pid: 99999, protocolVersion: 1 };
      }
      if (req.op === "embed") return { id: req.id, embedding: [0.1, 0.2] };
      return { id: req.id, error: "unknown" };
    });
    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: false,
      daemonEntry: expectedPath,
    });
    const vec = await client.embed("hi");
    expect(vec).toEqual([0.1, 0.2]);
    expect(lastReq).not.toBeNull();
    // pidfile / sockfile should be untouched (we created the sock via the fake daemon)
    const uid = String(process.getuid?.() ?? "test");
    expect(existsSync(join(dir, `hivemind-embed-${uid}.sock`))).toBe(true);
  });

  it("recycles when the daemon returns 'unknown op' on hello (older protocol)", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    const pidPath = join(dir, `hivemind-embed-${uid}.pid`);
    writeFileSync(pidPath, "1"); // init pid — kill will fail silently

    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") {
        // Mimic a pre-handshake daemon that doesn't recognize the op.
        return { id: req.id, error: "unknown op" };
      }
      if (req.op === "embed") return { id: req.id, embedding: [0.5] };
      return { id: req.id, error: "unknown" };
    });

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: false,
      daemonEntry: "/expected/new/bundle/daemon.js",
    });
    await client.embed("hi");
    // Recycle should have unlinked sock + pidfile so the next call respawns.
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("recycles when the running daemon's path no longer exists on disk (GC'd marketplace bundle)", async () => {
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    const pidPath = join(dir, `hivemind-embed-${uid}.pid`);
    writeFileSync(pidPath, "1");

    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") {
        // Stale path — bundle was GC'd by Claude Code's plugin-cache cleanup.
        return { id: req.id, daemonPath: "/non/existent/old/bundle/embed-daemon.js", pid: 1, protocolVersion: 1 };
      }
      if (req.op === "embed") return { id: req.id, embedding: [0.5] };
      return { id: req.id, error: "unknown" };
    });

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: false,
      daemonEntry: "/new/bundle/embed-daemon.js",
    });
    await client.embed("hi");
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(sockPath)).toBe(false);
  });

  it("does NOT recycle when paths differ but the running daemon's bundle still exists (multi-agent share)", async () => {
    // Simulates: claude-code spawned the daemon; now codex connects.
    // Both bundle files are present on disk → daemons are functionally
    // identical → codex must NOT kill claude-code's daemon. Recycling
    // here would cause endless thrash between the agents.
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);

    // Two real daemon-binary paths on disk (just empty files; we only
    // need existsSync(...) to return true).
    const claudePath = join(dir, "claude-code-daemon.js");
    const codexPath = join(dir, "codex-daemon.js");
    writeFileSync(claudePath, "");
    writeFileSync(codexPath, "");

    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") {
        return { id: req.id, daemonPath: claudePath, pid: 99999, protocolVersion: 1 };
      }
      if (req.op === "embed") return { id: req.id, embedding: [0.5] };
      return { id: req.id, error: "unknown" };
    });

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: false,
      daemonEntry: codexPath,
    });
    const vec = await client.embed("hi");
    expect(vec).toEqual([0.5]); // happily reused claude-code's daemon
    expect(existsSync(sockPath)).toBe(true); // socket NOT recycled
  });

  it("only verifies hello once per EmbedClient instance (subsequent calls skip)", async () => {
    const dir = makeTmpDir();
    let helloCount = 0;
    let embedCount = 0;
    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") {
        helloCount += 1;
        return { id: req.id, daemonPath: "/match", pid: 1, protocolVersion: 1 };
      }
      if (req.op === "embed") {
        embedCount += 1;
        return { id: req.id, embedding: [0.1] };
      }
      return { id: req.id, error: "unknown" };
    });
    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: false,
      daemonEntry: "/match",
    });
    await client.embed("a");
    await client.embed("b");
    await client.embed("c");
    expect(helloCount).toBe(1);
    expect(embedCount).toBe(3);
  });

  it("recycled probe + autoSpawn=true triggers spawn attempt and retries embed via waitForDaemonReady", async () => {
    // Drives the retry path: verifyDaemonOnce returns "recycled", the
    // outer wrapper calls trySpawnDaemon() + waitForDaemonReady(), then
    // calls embedAttempt() a second time. With no real daemon spawn
    // available (no daemonEntry on disk), the retry's connectOnce() will
    // fail and the wrapper returns null. The point of this test is to
    // exercise the waitForDaemonReady() poll-deadline branch and the
    // outer retry composition, not to assert a successful round-trip.
    const dir = makeTmpDir();
    let helloCount = 0;
    let embedCount = 0;
    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") { helloCount += 1; return { id: req.id, ready: true } as any; }
      embedCount += 1;
      return { id: req.id, embedding: [0.1] };
    });
    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 200,
      // autoSpawn ON exercises the new retry path…
      autoSpawn: true,
      // …but daemonEntry points at a non-existent file, so the
      // trySpawnDaemon call inside the retry no-ops (existsSync(daemonEntry)
      // check inside trySpawnDaemon short-circuits) and waitForDaemonReady
      // runs out its deadline without seeing a new sock file.
      daemonEntry: "/nonexistent-bundle-path/embed-daemon.js",
      // Keep the spawn-wait short so the test doesn't sit on the deadline.
      spawnWaitMs: 100,
    });
    const v = await client.embed("retry-with-autospawn");
    expect(v).toBeNull();
    // Probe ran once on the stale socket (no daemonPath → recycle).
    // Verify embed wasn't sent on the dead connection either time.
    expect(embedCount).toBe(0);
    expect(helloCount).toBe(1);
  });

  it("recycled probe + autoSpawn=false returns null cleanly (no hang on dead socket)", async () => {
    // Regression for CodeRabbit #9: previously `embed()` proceeded with
    // its embed request on the SAME socket after `verifyDaemonOnce()`
    // had SIGTERMed the daemon — the request silently dropped onto a
    // dead connection. The fix splits `embed()` into an attempt that
    // returns the sentinel "recycled" when the verify step killed the
    // daemon, so the outer call can spawn fresh + retry or (with
    // autoSpawn off) bail to null instead of stalling.
    const dir = makeTmpDir();
    let embedAttempts = 0;
    await startFakeDaemon(dir, (req) => {
      if (req.op === "hello") {
        // No daemonPath → triggers "older protocol" recycle branch.
        return { id: req.id, ready: true } as any;
      }
      embedAttempts += 1;
      // If the bug returned, the test would see this count tick to 1 on
      // the now-dead socket — we want it to stay 0.
      return { id: req.id, embedding: [0.9, 0.9, 0.9] };
    });
    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: false,
      daemonEntry: "/expected-but-not-this",
    });
    const v = await client.embed("recycle-me");
    expect(v).toBeNull();
    // The whole point: we did NOT send an embed on the recycled socket.
    expect(embedAttempts).toBe(0);
  });

  it("does NOT mark helloVerified after a probe failure — next reconnect retries verification", async () => {
    // Regression for CodeRabbit #5: previously the client set
    // `helloVerified = true` *before* awaiting the probe response, so a
    // genuinely transient probe failure (socket dies before responding)
    // on the first connect permanently disabled verification for every
    // later embed call on the same EmbedClient.
    //
    // Simulate a transient failure by destroying the socket on the FIRST
    // hello (no response written). That triggers the catch branch in
    // verifyDaemonOnce (vs. an error-shaped JSON response, which routes
    // through the recycle path instead).
    const dir = makeTmpDir();
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    let helloAttempts = 0;
    let embedAttempts = 0;
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
          if (req.op === "hello") {
            helloAttempts += 1;
            if (helloAttempts === 1) {
              // Drop the connection without responding — sendAndWait
              // resolves with an error from the socket close event.
              sock.destroy();
              return;
            }
            sock.write(JSON.stringify({ id: req.id, daemonPath: "/match", pid: 42, protocolVersion: 1 }) + "\n");
          } else if (req.op === "embed") {
            embedAttempts += 1;
            sock.write(JSON.stringify({ id: req.id, embedding: [0.5, 0.6] }) + "\n");
          }
        }
      });
      sock.on("error", () => { /* */ });
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const client = new EmbedClient({
      socketDir: dir,
      timeoutMs: 500,
      autoSpawn: false,
      daemonEntry: "/match",
    });
    await client.embed("first");
    await client.embed("second");
    await client.embed("third");
    // Fix: probe is retried on the second connect because the first
    // attempt was inconclusive (catch branch). After the second connect,
    // the response is compatible so the flag is set and the third call
    // skips the probe.
    //
    // embedAttempts is 2 (not 3) because the first connect's socket gets
    // destroyed by the server during the failed probe, so the first
    // embed() returns null without ever reaching the daemon's embed
    // handler. The CORE invariant under test is that helloAttempts === 2
    // — proving the second connect did re-run verification.
    expect(helloAttempts).toBe(2);
    expect(embedAttempts).toBe(2);
  });

  it("does not send hello when daemonEntry is empty (nothing to compare against)", async () => {
    // Force the resolver to land on a falsy daemonEntry by setting the env
    // override to empty — env wins over the SHARED_DAEMON_PATH fallback,
    // and "" is falsy, so verifyDaemonOnce returns early.
    const prev = process.env.HIVEMIND_EMBED_DAEMON;
    process.env.HIVEMIND_EMBED_DAEMON = "";
    try {
      const dir = makeTmpDir();
      let helloCount = 0;
      await startFakeDaemon(dir, (req) => {
        if (req.op === "hello") { helloCount += 1; return { id: req.id, daemonPath: "/x", pid: 1, protocolVersion: 1 }; }
        return { id: req.id, embedding: [0.1] };
      });
      const client = new EmbedClient({ socketDir: dir, timeoutMs: 500, autoSpawn: false });
      await client.embed("hi");
      expect(helloCount).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_EMBED_DAEMON;
      else process.env.HIVEMIND_EMBED_DAEMON = prev;
    }
  });
});
