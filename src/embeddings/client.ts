// Thin client used by hooks to request embeddings from the daemon.
// Self-heals: if the socket is missing, the first caller spawns the daemon
// under an O_EXCL pidfile lock so concurrent callers don't spawn duplicates.

import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  pidPathFor,
  socketPathFor,
  type DaemonResponse,
  type EmbedKind,
  type EmbedRequest,
  type HelloRequest,
  type HelloResponse,
} from "./protocol.js";
import { log as _log } from "../utils/debug.js";
import { enqueueNotification } from "../notifications/queue.js";
import { embeddingsStatus } from "./disable.js";

// Canonical location for the standalone daemon bundle, deposited by
// `hivemind embeddings install`. Used as the auto-spawn fallback when
// neither opts.daemonEntry nor HIVEMIND_EMBED_DAEMON is set — so any
// agent (including pi, which has no bundled daemon of its own) can spawn
// the same shared daemon process.
const SHARED_DAEMON_PATH = join(homedir(), ".hivemind", "embed-deps", "embed-daemon.js");

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

// Process-local flags so an embed-deps-missing notification fires at most
// once per process AND the stuck-daemon kill+recycle path runs at most once
// per process (it's idempotent but the SIGTERM is wasted on every retry).
let _signalledMissingDeps = false;
let _recycledStuckDaemon = false;
// Hello handshake runs at most once per (process, EmbedClient instance).
// Stored on the instance, not module-global, because tests construct
// many clients and each one needs its own verification cycle.

export class EmbedClient {
  private socketPath: string;
  private pidPath: string;
  private timeoutMs: number;
  private daemonEntry: string | undefined;
  private autoSpawn: boolean;
  private spawnWaitMs: number;
  private nextId = 0;
  private helloVerified = false;

  constructor(opts: ClientOptions = {}) {
    const uid = getUid();
    const dir = opts.socketDir ?? "/tmp";
    this.socketPath = socketPathFor(uid, dir);
    this.pidPath = pidPathFor(uid, dir);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    // Resolution order: explicit opt → env override → canonical shared
    // location (set up by `hivemind embeddings install`). The shared path
    // is checked at use-time, not here, so a missing file just means
    // "no auto-spawn" without preventing socket-only connects when
    // another agent has already spawned the daemon.
    this.daemonEntry = opts.daemonEntry
      ?? process.env.HIVEMIND_EMBED_DAEMON
      ?? (existsSync(SHARED_DAEMON_PATH) ? SHARED_DAEMON_PATH : undefined);
    this.autoSpawn = opts.autoSpawn ?? true;
    this.spawnWaitMs = opts.spawnWaitMs ?? 5000;
  }

  /**
   * Returns an embedding vector, or null on timeout/failure. Hooks MUST treat
   * null as "skip embedding column" — never block the write path on us.
   *
   * Fire-and-forget spawn on miss: if the daemon isn't up, this call returns
   * null AND kicks off a background spawn. The next call finds a ready daemon.
   *
   * Stuck-daemon recycle: if the daemon returns a transformers-missing
   * error (typical after a marketplace upgrade left an older daemon process
   * alive but with no node_modules accessible from its bundle path), we
   * SIGTERM it and clear its sock/pid so the very next call spawns a fresh
   * daemon from the current bundle. Without this, the stuck daemon would
   * keep poisoning every session until its 10-minute idle-out fires.
   */
  async embed(text: string, kind: EmbedKind = "document"): Promise<number[] | null> {
    const v = await this.embedAttempt(text, kind);
    if (v !== "recycled") return v;
    // The probe killed the old daemon mid-call. With autoSpawn enabled,
    // spawn a fresh one and retry once. Without autoSpawn (tests, pi's
    // fallback that relies on the canonical shared daemon already being
    // up) we have no way to bring the daemon back, so just return null —
    // the caller treats it the same as any other transient miss.
    //
    // The retry path skips verifyDaemonOnce internally because
    // `helloVerified` is still false (we never reached the compatible
    // branch) but `_recycledStuckDaemon` is now true, so the second probe
    // early-returns instead of triggering another kill.
    if (!this.autoSpawn) return null;
    this.trySpawnDaemon();
    await this.waitForDaemonReady();
    const retry = await this.embedAttempt(text, kind);
    return retry === "recycled" ? null : retry;
  }

  /**
   * One round-trip: connect → verify → embed. Returns:
   *  - number[]  : embedding vector (happy path)
   *  - null      : timeout / daemon error / transformers-missing
   *  - "recycled": verifyDaemonOnce killed the daemon mid-call;
   *                caller should respawn and retry once.
   */
  private async embedAttempt(text: string, kind: EmbedKind): Promise<number[] | null | "recycled"> {
    let sock: Socket;
    try {
      sock = await this.connectOnce();
    } catch {
      if (this.autoSpawn) this.trySpawnDaemon();
      return null;
    }
    try {
      const recycled = await this.verifyDaemonOnce(sock);
      if (recycled) {
        // The verify step killed the daemon + cleared the sock. Don't
        // send the embed on this now-dead connection — signal "recycled"
        // to the caller so it can spawn fresh and retry.
        return "recycled";
      }
      const id = String(++this.nextId);
      const req: EmbedRequest = { op: "embed", id, kind, text };
      const resp = await this.sendAndWait(sock, req);
      if (resp.error || !("embedding" in resp) || !resp.embedding) {
        const err = resp.error ?? "no embedding";
        log(`embed err: ${err}`);
        if (isTransformersMissingError(err)) {
          this.handleTransformersMissing(err);
        }
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
   * Poll for the sock file to come back after `trySpawnDaemon` — used by
   * the recycle retry path. Best-effort: caps at `spawnWaitMs` and
   * returns regardless so the retry attempt can run.
   */
  private async waitForDaemonReady(): Promise<void> {
    const deadline = Date.now() + this.spawnWaitMs;
    while (Date.now() < deadline) {
      if (existsSync(this.socketPath)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Send a `hello` on first successful connect per EmbedClient instance.
   * If the daemon answers with a path that doesn't match our configured
   * daemonEntry — typical after a marketplace upgrade replaced the bundle
   * — SIGTERM the daemon + clear sock/pid so the next call spawns from the
   * current bundle.
   *
   * `helloVerified` is set ONLY after we've seen a compatible response,
   * so a transient probe failure or a recycle-triggering mismatch leaves
   * the flag false; the next reconnect re-runs verification against
   * whatever daemon is then live (typically the fresh spawn).
   */
  private async verifyDaemonOnce(sock: Socket): Promise<boolean> {
    if (this.helloVerified) return false;
    if (!this.daemonEntry) {
      // No expectation to verify against (e.g. canonical-shared-deps mode,
      // or pi's fallback). Mark verified so we don't re-enter on every
      // connect for the same EmbedClient.
      this.helloVerified = true;
      return false;
    }
    const id = String(++this.nextId);
    const req: HelloRequest = { op: "hello", id };
    let resp: DaemonResponse;
    try {
      resp = await this.sendAndWait(sock, req);
    } catch (e: unknown) {
      // Daemon doesn't understand `hello` (older protocol) or connection
      // hiccup. Don't kill on a transient — let embed proceed and surface
      // any real problem there. Leave `helloVerified` false so the next
      // reconnect attempts verification again (the current probe was
      // inconclusive, not "definitely compatible").
      log(`hello probe failed (inconclusive, will retry next connect): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const hello = resp as HelloResponse;
    // Recycle triggers — in order of severity:
    //
    // 1. No `daemonPath` in the response: the daemon predates this protocol
    //    (i.e. `{ error: "unknown op" }` from an older bundle). It's an
    //    incompatible older binary that needs to be replaced.
    //
    // 2. `daemonPath` is set but the file no longer exists on disk: the
    //    bundle that spawned it was GC'd (typical after Claude Code prunes
    //    old marketplace versions). The daemon is orphaned and a fresh
    //    spawn would use the current bundle.
    //
    // Note we DO NOT recycle on plain path mismatch when both paths exist
    // — that's the multi-agent case (e.g. claude-code spawned the daemon,
    // codex now wants to use it). All bundled daemons at the same
    // protocolVersion are functionally identical, so any of them serves
    // every agent fine. Recycling here would cause endless thrash.
    if (_recycledStuckDaemon) {
      // Another EmbedClient already triggered a recycle in this process;
      // skip the check (but don't mark verified — the next reconnect
      // against the freshly spawned daemon will run hello again, which
      // is a single round-trip and harmless).
      return false;
    }
    if (!hello.daemonPath) {
      _recycledStuckDaemon = true;
      log(`daemon does not implement hello (older protocol); recycling`);
      this.recycleDaemon(hello.pid);
      return true;
    }
    if (hello.daemonPath !== this.daemonEntry && !existsSync(hello.daemonPath)) {
      _recycledStuckDaemon = true;
      log(`daemon path no longer on disk — running=${hello.daemonPath} (gone) expected=${this.daemonEntry}; recycling`);
      this.recycleDaemon(hello.pid);
      return true;
    }
    // Compatible — same path, or different path but functionally identical
    // (multi-agent sharing of one warm daemon). Only NOW do we mark the
    // EmbedClient as verified.
    this.helloVerified = true;
    return false;
  }

  /**
   * On a transformers-missing error from the daemon, SIGTERM the stuck
   * daemon (the bundle daemon that can't find its deps) and clear
   * sock/pid so the next call spawns fresh. Also enqueue a one-time
   * notification telling the user to run `hivemind embeddings install`
   * — but only when the user has opted in. Suppressed when
   * embeddingsStatus() === "user-disabled" so we don't nag users who
   * explicitly chose to turn embeddings off.
   */
  private handleTransformersMissing(detail: string): void {
    if (!_recycledStuckDaemon) {
      _recycledStuckDaemon = true;
      this.recycleDaemon(null);
    }
    if (_signalledMissingDeps) return;
    _signalledMissingDeps = true;
    let status: string;
    try { status = embeddingsStatus(); } catch { status = "enabled"; }
    if (status === "user-disabled") return; // user said no, don't nag
    // Fire-and-forget. `enqueueNotification` is now async (it may yield
    // the event loop on lock contention); we don't await it so we never
    // block the capture hot path on a notification write. Errors land in
    // the .catch instead of being swallowed silently by the outer caller.
    enqueueNotification({
      id: "embed-deps-missing",
      severity: "warn",
      title: "Hivemind embeddings disabled — deps missing",
      body: `Semantic memory search is off because @huggingface/transformers is not installed where the daemon can find it. Run \`hivemind embeddings install\` to enable.`,
      dedupKey: { reason: "transformers-missing", detail: detail.slice(0, 200) },
    }).catch((e: unknown) => {
      log(`enqueue embed-deps-missing failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /**
   * Best-effort SIGTERM + sock/pid cleanup. Tolerant of every missing-file
   * combination and dead-PID cases.
   *
   * Identity check: gate the SIGTERM on the daemon's socket file still
   * existing. We know the daemon was alive moments ago (we either just
   * got a hello response or the caller saw a transformers-missing error
   * the daemon emitted), but if the socket file is gone by the time we
   * try to kill, the daemon process is also gone and the PID we
   * captured may already have been recycled by the OS to an unrelated
   * user process. Mirrors the gate added to `killEmbedDaemon` in the
   * CLI — same failure mode, rarer trigger.
   */
  private recycleDaemon(reportedPid: number | null): void {
    let pid: number | null = reportedPid;
    if (pid === null) {
      try {
        pid = Number.parseInt(readFileSync(this.pidPath, "utf-8").trim(), 10);
      } catch { /* no pidfile */ }
    }
    if (Number.isFinite(pid) && pid !== null && pid > 0 && existsSync(this.socketPath)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    } else if (pid !== null) {
      log(`recycle: socket gone, skipping SIGTERM on possibly-stale pid ${pid}`);
    }
    try { unlinkSync(this.socketPath); } catch { /* not present */ }
    try { unlinkSync(this.pidPath); } catch { /* not present */ }
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

  private sendAndWait(sock: Socket, req: EmbedRequest | HelloRequest): Promise<DaemonResponse> {
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
      // If the daemon crashes or closes the connection cleanly without
      // sending a response (FIN before any data), neither `error` nor `data`
      // ever fires — without this `end` handler the promise would silently
      // hang until `timeoutMs` (10 minutes by default).
      sock.on("end", () => { clearTimeout(to); reject(new Error("connection closed without response")); });
      sock.write(JSON.stringify(req) + "\n");
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Detect daemon-side errors that indicate `@huggingface/transformers` is
 * not resolvable from the daemon's bundle location. Matches:
 *   - The actionable wrapper we throw from `defaultImportTransformers`
 *     (contains the literal `hivemind embeddings install`), or
 *   - A Node module-resolution error that specifically names
 *     `@huggingface/transformers`.
 *
 * Bare `MODULE_NOT_FOUND` (without the package name) used to fall here
 * too, but that overshoots — it also caught onnxruntime-node / sharp
 * / etc. missing-dep failures, recycled the daemon for problems
 * `hivemind embeddings install` can't fix, and surfaced the wrong user
 * guidance. Any daemon-side import failure of an unrelated dependency
 * is a packaging bug we should hear about separately, not a request to
 * reinstall transformers.
 */
export function isTransformersMissingError(err: string): boolean {
  if (/hivemind embeddings install/i.test(err)) return true;
  return /@huggingface\/transformers/i.test(err);
}

// ── Test helpers ────────────────────────────────────────────────────────────

export function _resetClientStateForTesting(): void {
  _signalledMissingDeps = false;
  _recycledStuckDaemon = false;
}

let singleton: EmbedClient | null = null;
export function getEmbedClient(): EmbedClient {
  if (!singleton) singleton = new EmbedClient();
  return singleton;
}
