#!/usr/bin/env node

// Long-lived embedding daemon. Holds the nomic model in RAM and serves
// embed requests over a per-user Unix socket. Exits after an idle window
// so it doesn't sit around consuming ~200 MB of RAM forever.

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { NomicEmbedder } from "./nomic.js";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  pidPathFor,
  socketPathFor,
  type DaemonRequest,
  type DaemonResponse,
  type EmbedRequest,
  type PingRequest,
} from "./protocol.js";
import { log as _log } from "../utils/debug.js";

const log = (m: string) => _log("embed-daemon", m);

function getUid(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid !== undefined ? String(uid) : (process.env.USER ?? "default");
}

export interface DaemonOptions {
  socketDir?: string;
  idleTimeoutMs?: number;
  dims?: number;
  dtype?: string;
  repo?: string;
}

export class EmbedDaemon {
  private server: Server | null = null;
  private embedder: NomicEmbedder;
  private socketPath: string;
  private pidPath: string;
  private idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(opts: DaemonOptions = {}) {
    const uid = getUid();
    const dir = opts.socketDir ?? "/tmp";
    this.socketPath = socketPathFor(uid, dir);
    this.pidPath = pidPathFor(uid, dir);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.embedder = new NomicEmbedder({ repo: opts.repo, dtype: opts.dtype, dims: opts.dims });
  }

  async start(): Promise<void> {
    mkdirSync(this.socketPath.replace(/\/[^/]+$/, ""), { recursive: true });
    // Overwrite pidfile FIRST — the client wrote its own (transient) pid as a
    // placeholder during spawn to avoid a race; now that the daemon is live,
    // replace it with ours so subsequent clients see the long-lived pid.
    writeFileSync(this.pidPath, String(process.pid), { mode: 0o600 });
    if (existsSync(this.socketPath)) {
      // Stale from a previous crash. unlink so bind() can succeed.
      try { unlinkSync(this.socketPath); } catch { /* best-effort */ }
    }

    // Warmup the model in the background so the first real request is fast.
    this.embedder.load().then(() => log("model ready")).catch(e => log(`load err: ${e.message}`));

    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      // Tighten umask before listen() so the socket file is created with
      // 0o600-equivalent permissions (rw for owner only). Without this,
      // listen() uses the process-default umask and there's a brief window
      // between bind and the chmodSync where another local user could
      // connect. Restore the previous umask immediately after.
      const prevUmask = process.umask(0o177);
      this.server!.listen(this.socketPath, () => {
        process.umask(prevUmask);
        try { chmodSync(this.socketPath, 0o600); } catch { /* best-effort */ }
        log(`listening on ${this.socketPath}`);
        resolve();
      });
    });

    this.resetIdleTimer();
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log(`idle timeout ${this.idleTimeoutMs}ms reached, shutting down`);
      this.shutdown();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  shutdown(): void {
    try { this.server?.close(); } catch { /* best-effort */ }
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath); } catch { /* best-effort */ }
    try { if (existsSync(this.pidPath)) unlinkSync(this.pidPath); } catch { /* best-effort */ }
    process.exit(0);
  }

  private handleConnection(sock: Socket): void {
    let buf = "";
    sock.setEncoding("utf-8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        this.handleLine(sock, line);
      }
    });
    sock.on("error", () => { /* client disconnect is normal */ });
  }

  private async handleLine(sock: Socket, line: string): Promise<void> {
    this.resetIdleTimer();
    let req: DaemonRequest;
    try {
      req = JSON.parse(line);
    } catch {
      // Don't silently drop — the client is keyed by id (or by first response
      // on the socket) and would otherwise block until its own timeoutMs.
      // Send a sentinel error response so the client fails fast instead.
      sock.write(JSON.stringify({ id: "unknown", error: "parse error" }) + "\n");
      return;
    }
    try {
      const resp = await this.dispatch(req);
      sock.write(JSON.stringify(resp) + "\n");
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      const resp: DaemonResponse = { id: req.id, error: err };
      sock.write(JSON.stringify(resp) + "\n");
    }
  }

  private async dispatch(req: DaemonRequest): Promise<DaemonResponse> {
    if (req.op === "ping") {
      const p = req as PingRequest;
      return { id: p.id, ready: true, model: this.embedder.repo, dims: this.embedder.dims };
    }
    if (req.op === "embed") {
      const e = req as EmbedRequest;
      const vec = await this.embedder.embed(e.text, e.kind);
      return { id: e.id, embedding: vec };
    }
    return { id: (req as { id: string }).id, error: "unknown op" };
  }
}

/* v8 ignore start — CLI entrypoint, only runs when file is node's argv[1] */
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
  || (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? ""));

if (invokedDirectly) {
  const dims = process.env.HIVEMIND_EMBED_DIMS ? Number(process.env.HIVEMIND_EMBED_DIMS) : undefined;
  const idleTimeoutMs = process.env.HIVEMIND_EMBED_IDLE_MS ? Number(process.env.HIVEMIND_EMBED_IDLE_MS) : undefined;
  const d = new EmbedDaemon({ dims, idleTimeoutMs });
  d.start().catch((e) => {
    log(`fatal: ${e.message}`);
    process.exit(1);
  });
}
/* v8 ignore stop */
