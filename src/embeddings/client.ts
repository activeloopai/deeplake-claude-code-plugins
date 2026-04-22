// Thin client used by hooks to request embeddings from the daemon.
// Self-heals: if the socket is missing, the first caller spawns the daemon
// under an O_EXCL pidfile lock so concurrent callers don't spawn duplicates.

import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  pidPathFor,
  socketPathFor,
  type DaemonResponse,
  type EmbedKind,
  type EmbedRequest,
} from "./protocol.js";
import { log as _log } from "../utils/debug.js";

const log = (m: string) => _log("embed-client", m);

function getUid(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid !== undefined ? String(uid) : (process.env.USER ?? "default");
}

export interface ClientOptions {
  socketDir?: string;
  timeoutMs?: number;
  daemonEntry?: string; // path to bundled embed-daemon.js
  autoSpawn?: boolean;
  spawnWaitMs?: number;
}

export class EmbedClient {
  private socketPath: string;
  private pidPath: string;
  private timeoutMs: number;
  private daemonEntry: string | undefined;
  private autoSpawn: boolean;
  private spawnWaitMs: number;
  private nextId = 0;

  constructor(opts: ClientOptions = {}) {
    const uid = getUid();
    const dir = opts.socketDir ?? "/tmp";
    this.socketPath = socketPathFor(uid, dir);
    this.pidPath = pidPathFor(uid, dir);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.daemonEntry = opts.daemonEntry ?? process.env.HIVEMIND_EMBED_DAEMON;
    this.autoSpawn = opts.autoSpawn ?? true;
    this.spawnWaitMs = opts.spawnWaitMs ?? 5000;
  }

  /**
   * Returns an embedding vector, or null on timeout/failure. Hooks MUST treat
   * null as "skip embedding column" — never block the write path on us.
   *
   * Fire-and-forget spawn on miss: if the daemon isn't up, this call returns
   * null AND kicks off a background spawn. The next call finds a ready daemon.
   */
  async embed(text: string, kind: EmbedKind = "document"): Promise<number[] | null> {
    let sock: Socket;
    try {
      sock = await this.connectOnce();
    } catch {
      if (this.autoSpawn) this.trySpawnDaemon();
      return null;
    }
    try {
      const id = String(++this.nextId);
      const req: EmbedRequest = { op: "embed", id, kind, text };
      const resp = await this.sendAndWait(sock, req);
      if (resp.error || !("embedding" in resp) || !resp.embedding) {
        log(`embed err: ${resp.error ?? "no embedding"}`);
        return null;
      }
      return resp.embedding;
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      log(`embed failed: ${err}`);
      return null;
    } finally {
      try { sock.end(); } catch { /* best-effort */ }
    }
  }

  /**
   * Wait up to spawnWaitMs for the daemon to accept connections, spawning if
   * necessary. Meant for SessionStart / long-running batches — not the hot path.
   */
  async warmup(): Promise<boolean> {
    try {
      const s = await this.connectOnce();
      s.end();
      return true;
    } catch {
      if (!this.autoSpawn) return false;
      this.trySpawnDaemon();
      try {
        const s = await this.waitForSocket();
        s.end();
        return true;
      } catch {
        return false;
      }
    }
  }

  private connectOnce(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("connect timeout"));
      }, this.timeoutMs);
      sock.once("connect", () => {
        clearTimeout(to);
        resolve(sock);
      });
      sock.once("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
    });
  }

  private trySpawnDaemon(): void {
    // O_EXCL pidfile — only the first caller wins. Others find the pid file
    // and wait for the socket to appear.
    //
    // Race subtlety: we IMMEDIATELY write our own PID into the file to close
    // the window where another worker could see an empty pidfile and interpret
    // it as "stale". The daemon itself overwrites the file with its own PID
    // during startup (see daemon.ts start()).
    let fd: number;
    try {
      fd = openSync(this.pidPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
    } catch (e: unknown) {
      // Someone else is spawning (EEXIST) — or pidfile is stale. If stale, clean up and retry.
      if (this.isPidFileStale()) {
        try { unlinkSync(this.pidPath); } catch { /* best-effort */ }
        try {
          fd = openSync(this.pidPath, "wx", 0o600);
          writeSync(fd, String(process.pid));
        } catch {
          return; // someone else just claimed it; let waitForSocket handle it
        }
      } else {
        return;
      }
    }

    if (!this.daemonEntry || !existsSync(this.daemonEntry)) {
      log(`daemonEntry not configured or missing: ${this.daemonEntry}`);
      try { closeSync(fd); unlinkSync(this.pidPath); } catch { /* best-effort */ }
      return;
    }

    try {
      const child = spawn(process.execPath, [this.daemonEntry], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      log(`spawned daemon pid=${child.pid}`);
    } finally {
      closeSync(fd);
    }
  }

  private isPidFileStale(): boolean {
    try {
      const raw = readFileSync(this.pidPath, "utf-8").trim();
      const pid = Number(raw);
      if (!pid || Number.isNaN(pid)) return true;
      // kill(pid, 0) throws if process is gone.
      try {
        process.kill(pid, 0);
        // Process is alive — the daemon might just be loading the model and
        // hasn't bound the socket yet. DON'T treat as stale; let waitForSocket
        // poll. A hung daemon will eventually time out at the caller.
        return false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }

  private async waitForSocket(): Promise<Socket> {
    const deadline = Date.now() + this.spawnWaitMs;
    let delay = 30;
    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 300);
      if (!existsSync(this.socketPath)) continue;
      try {
        return await this.connectOnce();
      } catch {
        // socket appeared but daemon not ready yet — keep waiting
      }
    }
    throw new Error("daemon did not become ready within spawnWaitMs");
  }

  private sendAndWait(sock: Socket, req: EmbedRequest): Promise<DaemonResponse> {
    return new Promise((resolve, reject) => {
      let buf = "";
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("request timeout"));
      }, this.timeoutMs);
      sock.setEncoding("utf-8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        clearTimeout(to);
        try {
          resolve(JSON.parse(line) as DaemonResponse);
        } catch (e) {
          reject(e as Error);
        }
      });
      sock.on("error", (e) => { clearTimeout(to); reject(e); });
      sock.write(JSON.stringify(req) + "\n");
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let singleton: EmbedClient | null = null;
export function getEmbedClient(): EmbedClient {
  if (!singleton) singleton = new EmbedClient();
  return singleton;
}
