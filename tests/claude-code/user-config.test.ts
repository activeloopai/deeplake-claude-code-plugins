import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUserConfig,
  writeUserConfig,
  getEmbeddingsEnabled,
  setEmbeddingsEnabled,
  _setConfigPathForTesting,
  _resetUserConfigForTesting,
} from "../../src/user-config.js";

let dir: string;
let configPath: string;

const originalEnv = process.env.HIVEMIND_EMBEDDINGS;

function restoreEnv(): void {
  if (originalEnv === undefined) delete process.env.HIVEMIND_EMBEDDINGS;
  else process.env.HIVEMIND_EMBEDDINGS = originalEnv;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hivemind-user-config-"));
  configPath = join(dir, "config.json");
  _setConfigPathForTesting(() => configPath);
  delete process.env.HIVEMIND_EMBEDDINGS;
});

afterEach(() => {
  _resetUserConfigForTesting();
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
});

describe("readUserConfig", () => {
  it("returns {} when the config file does not exist", () => {
    expect(readUserConfig()).toEqual({});
  });

  it("parses an existing valid config", () => {
    writeFileSync(configPath, JSON.stringify({ embeddings: { enabled: true } }), "utf-8");
    _resetUserConfigForTesting();
    _setConfigPathForTesting(() => configPath);
    expect(readUserConfig()).toEqual({ embeddings: { enabled: true } });
  });

  it("returns {} on corrupt JSON without throwing (don't crash the hook)", () => {
    writeFileSync(configPath, "{ not json", "utf-8");
    _resetUserConfigForTesting();
    _setConfigPathForTesting(() => configPath);
    expect(readUserConfig()).toEqual({});
  });

  it("returns {} when the root JSON value is not an object (e.g. an array)", () => {
    writeFileSync(configPath, JSON.stringify([1, 2, 3]), "utf-8");
    _resetUserConfigForTesting();
    _setConfigPathForTesting(() => configPath);
    expect(readUserConfig()).toEqual({});
  });

  it("caches the parsed config across calls (single file read per process)", () => {
    writeFileSync(configPath, JSON.stringify({ embeddings: { enabled: false } }), "utf-8");
    _resetUserConfigForTesting();
    _setConfigPathForTesting(() => configPath);
    const first = readUserConfig();
    // Mutate file under the cache — readUserConfig should NOT re-read.
    writeFileSync(configPath, JSON.stringify({ embeddings: { enabled: true } }), "utf-8");
    const second = readUserConfig();
    expect(second).toEqual(first);
  });
});

describe("writeUserConfig", () => {
  it("creates the file with the patched contents when none existed", () => {
    writeUserConfig({ embeddings: { enabled: true } });
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written).toEqual({ embeddings: { enabled: true } });
  });

  it("deep-merges into existing keys without clobbering siblings", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ embeddings: { enabled: true, other: "keep" }, unrelated: { x: 1 } }),
      "utf-8",
    );
    _resetUserConfigForTesting();
    _setConfigPathForTesting(() => configPath);
    writeUserConfig({ embeddings: { enabled: false } });
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written).toEqual({
      embeddings: { enabled: false, other: "keep" },
      unrelated: { x: 1 },
    });
  });

  it("writes atomically: no .tmp file remains after a successful write", () => {
    writeUserConfig({ embeddings: { enabled: true } });
    const dirEntries = require("node:fs").readdirSync(dir);
    expect(dirEntries.filter((f: string) => f.endsWith(".tmp") || f.includes(".tmp."))).toEqual([]);
  });

  it("creates the parent directory if missing", () => {
    rmSync(dir, { recursive: true, force: true });
    writeUserConfig({ embeddings: { enabled: true } });
    expect(existsSync(configPath)).toBe(true);
  });

  it("setEmbeddingsEnabled is a one-line wrapper that writes the right shape", () => {
    setEmbeddingsEnabled(false);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written).toEqual({ embeddings: { enabled: false } });
  });
});

describe("getEmbeddingsEnabled — migration from HIVEMIND_EMBEDDINGS", () => {
  it("writes enabled:false and returns false when env is unset on first run", () => {
    delete process.env.HIVEMIND_EMBEDDINGS;
    expect(getEmbeddingsEnabled()).toBe(false);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written).toEqual({ embeddings: { enabled: false } });
  });

  it("writes enabled:false and returns false when env is 'false' on first run", () => {
    process.env.HIVEMIND_EMBEDDINGS = "false";
    expect(getEmbeddingsEnabled()).toBe(false);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written).toEqual({ embeddings: { enabled: false } });
  });

  it("writes enabled:true and returns true when env is 'true' on first run", () => {
    process.env.HIVEMIND_EMBEDDINGS = "true";
    expect(getEmbeddingsEnabled()).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written).toEqual({ embeddings: { enabled: true } });
  });

  it("writes enabled:true on any non-'false' truthy env (lenient migration)", () => {
    process.env.HIVEMIND_EMBEDDINGS = "1";
    expect(getEmbeddingsEnabled()).toBe(true);
  });

  it("does NOT re-read the env var once a value is persisted", () => {
    process.env.HIVEMIND_EMBEDDINGS = "false";
    expect(getEmbeddingsEnabled()).toBe(false); // migration runs
    // Flip the env: should be ignored on subsequent reads.
    process.env.HIVEMIND_EMBEDDINGS = "true";
    _resetUserConfigForTesting();
    _setConfigPathForTesting(() => configPath);
    expect(getEmbeddingsEnabled()).toBe(false); // reads from persisted config
  });

  it("returns the persisted value when config already has embeddings.enabled set", () => {
    writeFileSync(configPath, JSON.stringify({ embeddings: { enabled: true } }), "utf-8");
    _resetUserConfigForTesting();
    _setConfigPathForTesting(() => configPath);
    // Env says false; persisted value should win.
    process.env.HIVEMIND_EMBEDDINGS = "false";
    expect(getEmbeddingsEnabled()).toBe(true);
  });

  it("setEmbeddingsEnabled overrides a prior migration value (last write wins)", () => {
    delete process.env.HIVEMIND_EMBEDDINGS;
    expect(getEmbeddingsEnabled()).toBe(false); // migration → false
    setEmbeddingsEnabled(true);
    expect(getEmbeddingsEnabled()).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written).toEqual({ embeddings: { enabled: true } });
  });
});
