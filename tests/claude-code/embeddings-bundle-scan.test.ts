import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundle-level guards that the embed-daemon fix actually lands in every
 * shipped agent bundle. Per the project testing philosophy: source tests
 * prove the helpers are correct, bundle tests prove the build didn't drop
 * the helpers, re-inline an old pattern, or otherwise regress on the
 * shipped artifact.
 *
 * A 30-second reviewer guardrail: scan the shipped JS for the literal
 * strings that prove each fix shipped to each agent.
 */

const repoRoot = process.cwd();

interface AgentBundle {
  agent: "claude-code" | "codex" | "cursor" | "hermes";
  embedDaemon: string;
  captureHook: string;
}

const AGENTS: AgentBundle[] = [
  {
    agent: "claude-code",
    embedDaemon: join(repoRoot, "claude-code", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "claude-code", "bundle", "capture.js"),
  },
  {
    agent: "codex",
    embedDaemon: join(repoRoot, "codex", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "codex", "bundle", "capture.js"),
  },
  {
    agent: "cursor",
    embedDaemon: join(repoRoot, "cursor", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "cursor", "bundle", "capture.js"),
  },
  {
    agent: "hermes",
    embedDaemon: join(repoRoot, "hermes", "bundle", "embeddings", "embed-daemon.js"),
    captureHook: join(repoRoot, "hermes", "bundle", "capture.js"),
  },
];

describe("shipped embed-daemon.js — explicit transformers resolver", () => {
  for (const a of AGENTS) {
    describe(a.agent, () => {
      it(`embed-daemon.js exists at the shipped path`, () => {
        expect(existsSync(a.embedDaemon), `missing: ${a.embedDaemon}`).toBe(true);
      });

      it(`embed-daemon.js loads transformers via the canonical shared-deps location`, () => {
        const src = readFileSync(a.embedDaemon, "utf-8");
        // Positive: canonical shared-deps path (".hivemind" + "embed-deps"
        // adjacent string literals survive esbuild's join() reformatting).
        expect(src).toMatch(/\.hivemind/);
        expect(src).toMatch(/embed-deps/);
        // Positive: createRequire-rooted resolve survived bundling.
        expect(src).toMatch(/createRequire/);
      });

      it(`embed-daemon.js throws an actionable error pointing at "hivemind embeddings install"`, () => {
        const src = readFileSync(a.embedDaemon, "utf-8");
        // The wrapper error message must survive the bundle so the
        // client-side log line tells the user what to do.
        expect(src).toContain("hivemind embeddings install");
      });
    });
  }
});

describe("shipped capture.js — self-heal + visible-failure notification", () => {
  for (const a of AGENTS) {
    describe(a.agent, () => {
      it(`capture.js exists`, () => {
        expect(existsSync(a.captureHook), `missing: ${a.captureHook}`).toBe(true);
      });

      it(`capture.js invokes the self-heal helper`, () => {
        const src = readFileSync(a.captureHook, "utf-8");
        expect(src).toContain("ensurePluginNodeModulesLink");
      });

      it(`capture.js carries the embed-deps-missing notification dedupKey`, () => {
        const src = readFileSync(a.captureHook, "utf-8");
        // The notification ID is what the SessionStart drain renders.
        expect(src).toContain("embed-deps-missing");
      });

      it(`capture.js still suppresses notifications when user-disabled (no nag for explicit opt-out)`, () => {
        const src = readFileSync(a.captureHook, "utf-8");
        // The guard must survive in the shipped artifact.
        expect(src).toMatch(/user-disabled/);
      });
    });
  }
});

describe("shipped shell/deeplake-shell.js — embed daemon path resolves to an existing file", () => {
  // Regression guard for CodeRabbit #6/#7/#11: the in-bundle resolver
  // computed `dirname(import.meta.url) + "embeddings/embed-daemon.js"`,
  // which when run from `<agent>/bundle/shell/` pointed at the missing
  // path `<agent>/bundle/shell/embeddings/embed-daemon.js`. The fix
  // adds `..` so it correctly lands at `<agent>/bundle/embeddings/`.
  // We verify both literally (the `..` survived bundling) AND
  // structurally (the actual bundled daemon file exists where the
  // bundled shell would look for it).
  const SHELL_BUNDLES: Array<[string, string, string]> = [
    ["claude-code",
      join(repoRoot, "claude-code", "bundle", "shell", "deeplake-shell.js"),
      join(repoRoot, "claude-code", "bundle", "embeddings", "embed-daemon.js")],
    ["codex",
      join(repoRoot, "codex", "bundle", "shell", "deeplake-shell.js"),
      join(repoRoot, "codex", "bundle", "embeddings", "embed-daemon.js")],
    ["cursor",
      join(repoRoot, "cursor", "bundle", "shell", "deeplake-shell.js"),
      join(repoRoot, "cursor", "bundle", "embeddings", "embed-daemon.js")],
  ];

  it.each(SHELL_BUNDLES)("%s shell bundle exists", (_label, shellPath) => {
    expect(existsSync(shellPath), `missing: ${shellPath}`).toBe(true);
  });

  it.each(SHELL_BUNDLES)(
    "%s daemon sibling exists at the parent-of-shell path",
    (_label, _shellPath, daemonPath) => {
      expect(existsSync(daemonPath), `missing: ${daemonPath}`).toBe(true);
    },
  );

  it.each(SHELL_BUNDLES)(
    "%s shell bundle resolves daemonEntry via parent-of-shell (`..` survived bundling)",
    (_label, shellPath) => {
      const src = readFileSync(shellPath, "utf-8");
      // The resolver builds a path like:
      //   join(dirname(import.meta.url), "..", "embeddings", "embed-daemon.js")
      // After esbuild minification the literals "..", "embeddings",
      // "embed-daemon.js" stay intact. Without the `..` we'd see
      // `"embeddings", "embed-daemon.js"` adjacent. Match the corrected
      // shape: a `..` immediately followed by `embeddings`.
      expect(src).toMatch(/"\.\.",\s*"embeddings",\s*"embed-daemon\.js"/);
    },
  );
});

describe("shipped bundle/cli.js — full embeddings subcommand surface", () => {
  const cliPath = join(repoRoot, "bundle", "cli.js");

  it("bundle/cli.js exists", () => {
    expect(existsSync(cliPath), `missing: ${cliPath}`).toBe(true);
  });

  it("dispatcher recognises every embeddings subcommand", () => {
    const src = readFileSync(cliPath, "utf-8");
    expect(src).toContain('"install"');
    expect(src).toContain('"enable"');
    expect(src).toContain('"disable"');
    expect(src).toContain('"uninstall"');
    expect(src).toContain('"status"');
  });

  it("CLI references ~/.deeplake/config.json so the model knows where state lives", () => {
    const src = readFileSync(cliPath, "utf-8");
    expect(src).toContain("~/.deeplake/config.json");
  });
});
