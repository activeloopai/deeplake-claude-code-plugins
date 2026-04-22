import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock NomicEmbedder so the daemon doesn't pull in @huggingface/transformers.
// The daemon talks to the embedder via two methods only: load() and embed().
// The `embedMode` global lets an individual test flip behavior: "ok" returns
// a vector, "throw" makes embed() reject — drives the dispatch-error branch.
(globalThis as any).__embedMode = "ok";

vi.mock("../../src/embeddings/nomic.js", () => {
  class MockNomicEmbedder {
    repo: string;
    dims: number;
    dtype: string;
    constructor(opts: any = {}) {
      this.repo = opts.repo ?? "mock-repo";
      this.dims = opts.dims ?? 768;
      this.dtype = opts.dtype ?? "q8";
    }
    async load() { /* no-op */ }
    async embed(_text: string, _kind?: string) {
      if ((globalThis as any).__embedMode === "throw") {
        throw new Error("forced embed failure");
      }
      return [0.1, 0.2, 0.3];
    }
    async embedBatch(texts: string[], _kind?: string) {
      return texts.map(() => [0.1, 0.2, 0.3]);
    }
  }
  return { NomicEmbedder: MockNomicEmbedder };
});

import { EmbedDaemon } from "../../src/embeddings/daemon.js";

function sendLine(socketPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    const to = setTimeout(() => { sock.destroy(); reject(new Error("timeout")); }, 2000);
    sock.setEncoding("utf-8");
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(to);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    sock.on("error", (e) => { clearTimeout(to); reject(e); });
  });
}

describe("EmbedDaemon", () => {
  let dir: string;
  let daemon: EmbedDaemon | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hvm-daemon-test-"));
  });

  afterEach(() => {
    try { daemon?.shutdown(); } catch { /* shutdown calls process.exit, ignore */ }
    daemon = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    (globalThis as any).__embedMode = "ok";
  });

  it("answers a ping with the model + dims metadata", async () => {
    // process.exit inside shutdown would terminate the test runner; stub it.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000, dims: 128 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const sock = join(dir, `hivemind-embed-${uid}.sock`);
    const resp = await sendLine(sock, { op: "ping", id: "p1" });
    expect(resp.id).toBe("p1");
    expect(resp.ready).toBe(true);
    expect(resp.dims).toBe(128);

    exitSpy.mockRestore();
  });

  it("answers an embed request with the vector from the mocked embedder", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const sock = join(dir, `hivemind-embed-${uid}.sock`);
    const resp = await sendLine(sock, { op: "embed", id: "e1", kind: "document", text: "hello" });
    expect(resp.id).toBe("e1");
    expect(resp.embedding).toEqual([0.1, 0.2, 0.3]);

    exitSpy.mockRestore();
  });

  it("returns { error } for unknown ops", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const sock = join(dir, `hivemind-embed-${uid}.sock`);
    const resp = await sendLine(sock, { op: "bogus", id: "x" });
    expect(resp.error).toContain("unknown op");

    exitSpy.mockRestore();
  });

  it("writes a pidfile with the daemon's own PID on startup", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const pidPath = join(dir, `hivemind-embed-${uid}.pid`);
    const { readFileSync } = await import("node:fs");
    const pid = Number(readFileSync(pidPath, "utf-8").trim());
    expect(pid).toBe(process.pid);

    exitSpy.mockRestore();
  });

  it("unlinks a stale socket on startup before re-binding", async () => {
    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    // Pre-create a stale file at the socket path.
    writeFileSync(sockPath, "stale");
    expect(existsSync(sockPath)).toBe(true);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();
    // Now it's a live Unix socket; stat would say it's a socket not a regular file.
    expect(existsSync(sockPath)).toBe(true);

    exitSpy.mockRestore();
  });

  it("idle timer triggers shutdown after the configured window", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 50 });
    await daemon.start();
    await new Promise(r => setTimeout(r, 120));
    // shutdown called via process.exit stub (spyed above) — our exit count > 0.
    expect(exitSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("returns { error } when the embedder throws during an embed request", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    (globalThis as any).__embedMode = "throw";
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const sock = join(dir, `hivemind-embed-${uid}.sock`);
    const resp = await sendLine(sock, { op: "embed", id: "e2", kind: "document", text: "hi" });
    expect(resp.id).toBe("e2");
    expect(resp.error).toContain("forced embed failure");

    exitSpy.mockRestore();
  });

  it("constructs with default options (no opts object passed)", () => {
    // Exercise the constructor's `opts = {}` default + every `??` fallback.
    const d = new EmbedDaemon();
    expect(d).toBeInstanceOf(EmbedDaemon);
  });

  it("skips empty lines between valid requests", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    await new Promise<void>((resolve, reject) => {
      const sock = connect(sockPath);
      sock.setEncoding("utf-8");
      let buf = "";
      sock.on("connect", () => {
        // Send blank lines first — they hit the `line.length === 0` branch.
        sock.write("\n\n");
        sock.write(JSON.stringify({ op: "ping", id: "z" }) + "\n");
      });
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const resp = JSON.parse(buf.slice(0, nl));
          expect(resp.id).toBe("z");
          sock.end();
          resolve();
        }
      });
      sock.on("error", reject);
    });
    exitSpy.mockRestore();
  });

  it("survives a client that disconnects abruptly mid-session", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    await new Promise<void>((resolve) => {
      const sock = connect(sockPath);
      sock.on("error", () => { /* swallow — we intentionally destroy below */ });
      sock.on("connect", () => {
        // Destroying a freshly connected socket should make the server's
        // read side emit either `end` or `error` — either way the daemon
        // should survive and keep serving. We test the survival below.
        sock.destroy();
        resolve();
      });
    });
    // Follow-up ping should still work — the daemon didn't crash.
    const sockPathStr = join(dir, `hivemind-embed-${uid}.sock`);
    const resp = await sendLine(sockPathStr, { op: "ping", id: "after" });
    expect(resp.id).toBe("after");
    exitSpy.mockRestore();
  });

  it("handles malformed JSON lines without crashing the daemon", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    daemon = new EmbedDaemon({ socketDir: dir, idleTimeoutMs: 60_000 });
    await daemon.start();

    const uid = String(process.getuid?.() ?? "test");
    const sockPath = join(dir, `hivemind-embed-${uid}.sock`);
    // Write a bad line then a good one on the same connection.
    await new Promise<void>((resolve, reject) => {
      const sock = connect(sockPath);
      sock.setEncoding("utf-8");
      let buf = "";
      sock.on("connect", () => {
        sock.write("not-json\n");
        sock.write(JSON.stringify({ op: "ping", id: "ok" }) + "\n");
      });
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const resp = JSON.parse(buf.slice(0, nl));
          expect(resp.id).toBe("ok");
          sock.end();
          resolve();
        }
      });
      sock.on("error", reject);
    });
    exitSpy.mockRestore();
  });
});
