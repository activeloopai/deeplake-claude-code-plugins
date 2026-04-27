import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  embeddingsDisabled,
  embeddingsStatus,
  _setResolveForTesting,
  _resetForTesting,
} from "../../src/embeddings/disable.js";

const originalEnv = process.env.HIVEMIND_EMBEDDINGS;

function restoreEnv(): void {
  if (originalEnv === undefined) delete process.env.HIVEMIND_EMBEDDINGS;
  else process.env.HIVEMIND_EMBEDDINGS = originalEnv;
}

describe("embeddingsStatus / embeddingsDisabled — env branch", () => {
  beforeEach(() => {
    delete process.env.HIVEMIND_EMBEDDINGS;
    _resetForTesting();
  });

  afterEach(() => {
    restoreEnv();
    _resetForTesting();
  });

  it("is 'enabled' when env is unset and the package resolves", () => {
    _setResolveForTesting(() => { /* no throw → installed */ });
    expect(embeddingsStatus()).toBe("enabled");
    expect(embeddingsDisabled()).toBe(false);
  });

  it("is 'env-disabled' when HIVEMIND_EMBEDDINGS is exactly 'false'", () => {
    process.env.HIVEMIND_EMBEDDINGS = "false";
    // Resolver should never be consulted — set it to throw so this fails
    // loudly if the env-check is ever removed.
    _setResolveForTesting(() => { throw new Error("must not be called"); });
    expect(embeddingsStatus()).toBe("env-disabled");
    expect(embeddingsDisabled()).toBe(true);
  });

  it("env-disabled wins over a missing package (single, definitive signal)", () => {
    process.env.HIVEMIND_EMBEDDINGS = "false";
    _setResolveForTesting(() => { throw new Error("MODULE_NOT_FOUND"); });
    expect(embeddingsStatus()).toBe("env-disabled");
    expect(embeddingsDisabled()).toBe(true);
  });

  it("stays 'enabled' for any non-'false' truthy env value (avoid surprise kills)", () => {
    for (const value of ["0", "no", "true", "", "FALSE", "False"]) {
      process.env.HIVEMIND_EMBEDDINGS = value;
      _resetForTesting();
      _setResolveForTesting(() => { /* installed */ });
      expect(embeddingsStatus()).toBe("enabled");
      expect(embeddingsDisabled()).toBe(false);
    }
  });
});

describe("embeddingsStatus / embeddingsDisabled — transformers-presence branch", () => {
  beforeEach(() => {
    delete process.env.HIVEMIND_EMBEDDINGS;
    _resetForTesting();
  });

  afterEach(() => {
    restoreEnv();
    _resetForTesting();
  });

  it("is 'enabled' when @huggingface/transformers resolves cleanly", () => {
    _setResolveForTesting(() => { /* resolution OK */ });
    expect(embeddingsStatus()).toBe("enabled");
    expect(embeddingsDisabled()).toBe(false);
  });

  it("is 'no-transformers' on MODULE_NOT_FOUND from the resolver", () => {
    _setResolveForTesting(() => {
      const err = new Error("Cannot find module '@huggingface/transformers'") as NodeJS.ErrnoException;
      err.code = "MODULE_NOT_FOUND";
      throw err;
    });
    expect(embeddingsStatus()).toBe("no-transformers");
    expect(embeddingsDisabled()).toBe(true);
  });

  it("is 'no-transformers' on any other resolver throw (defensive: never crash)", () => {
    _setResolveForTesting(() => { throw new Error("permission denied"); });
    expect(embeddingsStatus()).toBe("no-transformers");
    expect(embeddingsDisabled()).toBe(true);
  });

  it("does not re-resolve on every call — first result is cached for the process", () => {
    let calls = 0;
    _setResolveForTesting(() => {
      calls += 1;
      if (calls > 1) throw new Error("resolver should be called at most once");
    });
    expect(embeddingsStatus()).toBe("enabled");
    expect(embeddingsStatus()).toBe("enabled");
    expect(embeddingsDisabled()).toBe(false);
    expect(calls).toBe(1);
  });

  it("caches the disabled result too (a missing package doesn't probe again)", () => {
    let calls = 0;
    _setResolveForTesting(() => {
      calls += 1;
      throw new Error("MODULE_NOT_FOUND");
    });
    expect(embeddingsStatus()).toBe("no-transformers");
    expect(embeddingsStatus()).toBe("no-transformers");
    expect(embeddingsDisabled()).toBe(true);
    expect(calls).toBe(1);
  });

  it("_resetForTesting clears the cache and restores the real resolver", () => {
    _setResolveForTesting(() => { throw new Error("simulated missing"); });
    expect(embeddingsStatus()).toBe("no-transformers");
    _resetForTesting();
    // Real resolver runs against this test process, which has the package
    // installed via the worktree's node_modules → comes back 'enabled'.
    expect(embeddingsStatus()).toBe("enabled");
  });

  it("real default resolver finds @huggingface/transformers in this repo", () => {
    // Smoke check: in the dev / CI environment the package IS installed,
    // so the actual createRequire-based resolver succeeds. Guards against
    // a regression in the resolution path itself (wrong base URL, wrong
    // package name spelling, build-time vs runtime path drift, etc.).
    _resetForTesting();
    expect(embeddingsStatus()).toBe("enabled");
  });
});
