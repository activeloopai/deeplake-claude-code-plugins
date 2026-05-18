import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  embeddingsDisabled,
  embeddingsStatus,
  _setResolveForTesting,
  _setEnabledReaderForTesting,
  _resetForTesting,
} from "../../src/embeddings/disable.js";

beforeEach(() => {
  _resetForTesting();
  // Default: user has embeddings enabled. Individual tests flip this.
  _setEnabledReaderForTesting(() => true);
});

afterEach(() => {
  _resetForTesting();
});

describe("embeddingsStatus / embeddingsDisabled — user-config branch", () => {
  it("is 'enabled' when config says enabled and the package resolves", () => {
    _setEnabledReaderForTesting(() => true);
    _setResolveForTesting(() => { /* no throw → installed */ });
    expect(embeddingsStatus()).toBe("enabled");
    expect(embeddingsDisabled()).toBe(false);
  });

  it("is 'user-disabled' when config says embeddings.enabled === false", () => {
    _setEnabledReaderForTesting(() => false);
    // Resolver should never be consulted — set it to throw so this fails
    // loudly if the gate is ever removed.
    _setResolveForTesting(() => { throw new Error("must not be called"); });
    expect(embeddingsStatus()).toBe("user-disabled");
    expect(embeddingsDisabled()).toBe(true);
  });

  it("user-disabled wins over missing transformers (single, definitive signal)", () => {
    _setEnabledReaderForTesting(() => false);
    _setResolveForTesting(() => { throw new Error("MODULE_NOT_FOUND"); });
    expect(embeddingsStatus()).toBe("user-disabled");
    expect(embeddingsDisabled()).toBe(true);
  });
});

describe("embeddingsStatus / embeddingsDisabled — transformers-presence branch", () => {
  beforeEach(() => {
    _setEnabledReaderForTesting(() => true);
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
    _setEnabledReaderForTesting(() => true);
    // Real resolver runs against this test process, which has the package
    // installed via the worktree's node_modules → comes back 'enabled'.
    expect(embeddingsStatus()).toBe("enabled");
  });

  it("real default resolver finds @huggingface/transformers via the shared-deps probe", () => {
    // Smoke check: in the dev / CI environment the package IS installed
    // (either at ~/.hivemind/embed-deps/ or in the worktree's node_modules
    // via the bundle walk fallback). Guards against a regression in the
    // resolver chain (wrong base URL, wrong package name, build-time vs
    // runtime path drift, etc.).
    _resetForTesting();
    _setEnabledReaderForTesting(() => true);
    expect(embeddingsStatus()).toBe("enabled");
  });
});
