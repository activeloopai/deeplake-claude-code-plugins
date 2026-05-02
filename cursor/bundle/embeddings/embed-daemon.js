#!/usr/bin/env node

// dist/src/embeddings/daemon.js
import { createServer } from "node:net";
import { unlinkSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";

// dist/src/embeddings/protocol.js
var DEFAULT_SOCKET_DIR = "/tmp";
var DEFAULT_MODEL_REPO = "nomic-ai/nomic-embed-text-v1.5";
var DEFAULT_DTYPE = "q8";
var DEFAULT_DIMS = 768;
var DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1e3;
var DOC_PREFIX = "search_document: ";
var QUERY_PREFIX = "search_query: ";
function socketPathFor(uid, dir = DEFAULT_SOCKET_DIR) {
  return `${dir}/hivemind-embed-${uid}.sock`;
}
function pidPathFor(uid, dir = DEFAULT_SOCKET_DIR) {
  return `${dir}/hivemind-embed-${uid}.pid`;
}

// dist/src/embeddings/nomic.js
var NomicEmbedder = class {
  pipeline = null;
  loading = null;
  repo;
  dtype;
  dims;
  constructor(opts = {}) {
    this.repo = opts.repo ?? DEFAULT_MODEL_REPO;
    this.dtype = opts.dtype ?? DEFAULT_DTYPE;
    this.dims = opts.dims ?? DEFAULT_DIMS;
  }
  async load() {
    if (this.pipeline)
      return;
    if (this.loading)
      return this.loading;
    this.loading = (async () => {
      const mod = await import("@huggingface/transformers");
      mod.env.allowLocalModels = false;
      mod.env.useFSCache = true;
      this.pipeline = await mod.pipeline("feature-extraction", this.repo, { dtype: this.dtype });
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }
  addPrefix(text, kind) {
    return (kind === "query" ? QUERY_PREFIX : DOC_PREFIX) + text;
  }
  async embed(text, kind = "document") {
    await this.load();
    if (!this.pipeline)
      throw new Error("embedder not loaded");
    const out = await this.pipeline(this.addPrefix(text, kind), { pooling: "mean", normalize: true });
    const full = Array.from(out.data);
    return this.truncate(full);
  }
  async embedBatch(texts, kind = "document") {
    if (texts.length === 0)
      return [];
    await this.load();
    if (!this.pipeline)
      throw new Error("embedder not loaded");
    const prefixed = texts.map((t) => this.addPrefix(t, kind));
    const out = await this.pipeline(prefixed, { pooling: "mean", normalize: true });
    const flat = Array.from(out.data);
    const total = flat.length;
    const full = total / texts.length;
    const batches = [];
    for (let i = 0; i < texts.length; i++) {
      batches.push(this.truncate(flat.slice(i * full, (i + 1) * full)));
    }
    return batches;
  }
  truncate(vec) {
    if (this.dims >= vec.length)
      return vec;
    const head = vec.slice(0, this.dims);
    let norm = 0;
    for (const v of head)
      norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0)
      return head;
    for (let i = 0; i < head.length; i++)
      head[i] /= norm;
    return head;
  }
};

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var DEBUG = process.env.HIVEMIND_DEBUG === "1";
var LOG = join(homedir(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/embeddings/daemon.js
var log2 = (m) => log("embed-daemon", m);
function getUid() {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid !== void 0 ? String(uid) : process.env.USER ?? "default";
}
var EmbedDaemon = class {
  server = null;
  embedder;
  socketPath;
  pidPath;
  idleTimeoutMs;
  idleTimer = null;
  constructor(opts = {}) {
    const uid = getUid();
    const dir = opts.socketDir ?? "/tmp";
    this.socketPath = socketPathFor(uid, dir);
    this.pidPath = pidPathFor(uid, dir);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.embedder = new NomicEmbedder({ repo: opts.repo, dtype: opts.dtype, dims: opts.dims });
  }
  async start() {
    mkdirSync(this.socketPath.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(this.pidPath, String(process.pid), { mode: 384 });
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
      }
    }
    this.embedder.load().then(() => log2("model ready")).catch((e) => log2(`load err: ${e.message}`));
    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      const prevUmask = process.umask(127);
      this.server.listen(this.socketPath, () => {
        process.umask(prevUmask);
        try {
          chmodSync(this.socketPath, 384);
        } catch {
        }
        log2(`listening on ${this.socketPath}`);
        resolve();
      });
    });
    this.resetIdleTimer();
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }
  resetIdleTimer() {
    if (this.idleTimer)
      clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log2(`idle timeout ${this.idleTimeoutMs}ms reached, shutting down`);
      this.shutdown();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }
  shutdown() {
    try {
      this.server?.close();
    } catch {
    }
    try {
      if (existsSync(this.socketPath))
        unlinkSync(this.socketPath);
    } catch {
    }
    try {
      if (existsSync(this.pidPath))
        unlinkSync(this.pidPath);
    } catch {
    }
    process.exit(0);
  }
  handleConnection(sock) {
    let buf = "";
    sock.setEncoding("utf-8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0)
          continue;
        this.handleLine(sock, line);
      }
    });
    sock.on("error", () => {
    });
  }
  async handleLine(sock, line) {
    this.resetIdleTimer();
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      sock.write(JSON.stringify({ id: "unknown", error: "parse error" }) + "\n");
      return;
    }
    try {
      const resp = await this.dispatch(req);
      sock.write(JSON.stringify(resp) + "\n");
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const resp = { id: req.id, error: err };
      sock.write(JSON.stringify(resp) + "\n");
    }
  }
  async dispatch(req) {
    if (req.op === "ping") {
      const p = req;
      return { id: p.id, ready: true, model: this.embedder.repo, dims: this.embedder.dims };
    }
    if (req.op === "embed") {
      const e = req;
      const vec = await this.embedder.embed(e.text, e.kind);
      return { id: e.id, embedding: vec };
    }
    return { id: req.id, error: "unknown op" };
  }
};
var invokedDirectly = import.meta.url === `file://${process.argv[1]}` || process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  const dims = process.env.HIVEMIND_EMBED_DIMS ? Number(process.env.HIVEMIND_EMBED_DIMS) : void 0;
  const idleTimeoutMs = process.env.HIVEMIND_EMBED_IDLE_MS ? Number(process.env.HIVEMIND_EMBED_IDLE_MS) : void 0;
  const d = new EmbedDaemon({ dims, idleTimeoutMs });
  d.start().catch((e) => {
    log2(`fatal: ${e.message}`);
    process.exit(1);
  });
}
export {
  EmbedDaemon
};
