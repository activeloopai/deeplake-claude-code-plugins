import { describe, expect, it } from "vitest";
import { runGate, findAgentBin, type Agent } from "../../src/skillify/gate-runner.js";

describe("findAgentBin", () => {
  it("returns a path for each known agent (PATH lookup or fallback)", () => {
    for (const agent of ["claude_code", "codex", "cursor", "hermes", "pi"] as Agent[]) {
      const p = findAgentBin(agent);
      expect(p).toBeTruthy();
      expect(typeof p).toBe("string");
      expect(p).toMatch(/[/\\]/); // looks like a path
    }
  });
});

describe("runGate dispatch", () => {
  it("returns errored when bin path does not exist (no exception)", () => {
    const r = runGate({
      agent: "claude_code",
      prompt: "test",
      bin: "/nonexistent/path/to/missing-binary",
    });
    expect(r.errored).toBe(true);
    expect(r.errorMessage).toMatch(/not found/i);
    // Should not throw — returns a clean error structure
    expect(r.stdout).toBe("");
  });

  // Per-agent argv shape — we can't actually exec without a real binary, so
  // we use a stub script that just echoes its args to stdout, then assert
  // the agent's expected flags appear in the output.
  it("constructs claude_code invocation with --model haiku + bypassPermissions", () => {
    const r = runGate({
      agent: "claude_code",
      prompt: "PROMPT_MARKER",
      bin: "/usr/bin/echo",
      timeoutMs: 5_000,
    });
    expect(r.errored).toBe(false);
    expect(r.stdout).toContain("PROMPT_MARKER");
    expect(r.stdout).toContain("--model");
    expect(r.stdout).toContain("haiku");
    expect(r.stdout).toContain("bypassPermissions");
  });

  it("constructs codex invocation with exec + --dangerously-bypass-approvals-and-sandbox", () => {
    const r = runGate({
      agent: "codex",
      prompt: "PROMPT_MARKER",
      bin: "/usr/bin/echo",
      timeoutMs: 5_000,
    });
    expect(r.errored).toBe(false);
    expect(r.stdout).toContain("PROMPT_MARKER");
    expect(r.stdout).toContain("exec");
    expect(r.stdout).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("constructs cursor-agent invocation with --print + --model + --force", () => {
    const r = runGate({
      agent: "cursor",
      prompt: "PROMPT_MARKER",
      bin: "/usr/bin/echo",
      cursorModel: "claude-sonnet-4-5",
      timeoutMs: 5_000,
    });
    expect(r.errored).toBe(false);
    expect(r.stdout).toContain("--print");
    expect(r.stdout).toContain("--model");
    expect(r.stdout).toContain("claude-sonnet-4-5");
    expect(r.stdout).toContain("--force");
    expect(r.stdout).toContain("PROMPT_MARKER");
  });

  it("constructs pi invocation with --print + --provider + --model", () => {
    const r = runGate({
      agent: "pi",
      prompt: "PROMPT_MARKER",
      bin: "/usr/bin/echo",
      piProvider: "google",
      piModel: "gemini-2.5-flash",
      timeoutMs: 5_000,
    });
    expect(r.errored).toBe(false);
    expect(r.stdout).toContain("--print");
    expect(r.stdout).toContain("--provider");
    expect(r.stdout).toContain("google");
    expect(r.stdout).toContain("--model");
    expect(r.stdout).toContain("gemini-2.5-flash");
    expect(r.stdout).toContain("PROMPT_MARKER");
  });

  it("pi falls back to env var defaults for provider + model when explicit override absent", () => {
    const original = {
      provider: process.env.HIVEMIND_PI_PROVIDER,
      model: process.env.HIVEMIND_PI_MODEL,
    };
    try {
      process.env.HIVEMIND_PI_PROVIDER = "test-pi-provider";
      process.env.HIVEMIND_PI_MODEL = "test-pi-model";
      const r = runGate({ agent: "pi", prompt: "p", bin: "/usr/bin/echo" });
      expect(r.stdout).toContain("test-pi-provider");
      expect(r.stdout).toContain("test-pi-model");
    } finally {
      if (original.provider === undefined) delete process.env.HIVEMIND_PI_PROVIDER;
      else process.env.HIVEMIND_PI_PROVIDER = original.provider;
      if (original.model === undefined) delete process.env.HIVEMIND_PI_MODEL;
      else process.env.HIVEMIND_PI_MODEL = original.model;
    }
  });

  it("pi uses google + gemini-2.5-flash defaults when neither opts nor env are set", () => {
    const original = {
      provider: process.env.HIVEMIND_PI_PROVIDER,
      model: process.env.HIVEMIND_PI_MODEL,
    };
    try {
      delete process.env.HIVEMIND_PI_PROVIDER;
      delete process.env.HIVEMIND_PI_MODEL;
      const r = runGate({ agent: "pi", prompt: "p", bin: "/usr/bin/echo" });
      expect(r.stdout).toContain("google");
      expect(r.stdout).toContain("gemini-2.5-flash");
    } finally {
      if (original.provider !== undefined) process.env.HIVEMIND_PI_PROVIDER = original.provider;
      if (original.model !== undefined) process.env.HIVEMIND_PI_MODEL = original.model;
    }
  });

  it("constructs hermes invocation with -z + --provider + -m + --yolo", () => {
    const r = runGate({
      agent: "hermes",
      prompt: "PROMPT_MARKER",
      bin: "/usr/bin/echo",
      hermesProvider: "openrouter",
      hermesModel: "anthropic/claude-haiku-4-5",
      timeoutMs: 5_000,
    });
    expect(r.errored).toBe(false);
    expect(r.stdout).toContain("-z");
    expect(r.stdout).toContain("PROMPT_MARKER");
    expect(r.stdout).toContain("--provider");
    expect(r.stdout).toContain("openrouter");
    expect(r.stdout).toContain("-m");
    expect(r.stdout).toContain("anthropic/claude-haiku-4-5");
    expect(r.stdout).toContain("--yolo");
    expect(r.stdout).toContain("--ignore-user-config");
  });

  it("falls back to env var defaults for cursor/hermes model when explicit override absent", () => {
    const original = {
      cursor: process.env.HIVEMIND_CURSOR_MODEL,
      hermesProv: process.env.HIVEMIND_HERMES_PROVIDER,
      hermesModel: process.env.HIVEMIND_HERMES_MODEL,
    };
    try {
      process.env.HIVEMIND_CURSOR_MODEL = "test-cursor-model";
      process.env.HIVEMIND_HERMES_PROVIDER = "test-provider";
      process.env.HIVEMIND_HERMES_MODEL = "test-hermes-model";
      const c = runGate({ agent: "cursor", prompt: "p", bin: "/usr/bin/echo" });
      expect(c.stdout).toContain("test-cursor-model");
      const h = runGate({ agent: "hermes", prompt: "p", bin: "/usr/bin/echo" });
      expect(h.stdout).toContain("test-provider");
      expect(h.stdout).toContain("test-hermes-model");
    } finally {
      // Restore (delete if originally undefined to avoid pollution)
      if (original.cursor === undefined) delete process.env.HIVEMIND_CURSOR_MODEL;
      else process.env.HIVEMIND_CURSOR_MODEL = original.cursor;
      if (original.hermesProv === undefined) delete process.env.HIVEMIND_HERMES_PROVIDER;
      else process.env.HIVEMIND_HERMES_PROVIDER = original.hermesProv;
      if (original.hermesModel === undefined) delete process.env.HIVEMIND_HERMES_MODEL;
      else process.env.HIVEMIND_HERMES_MODEL = original.hermesModel;
    }
  });
});
