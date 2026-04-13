import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ── isNewer (extracted from session-start.ts) ───────────────────────────────

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
}

describe("isNewer — version comparison", () => {
  it("detects major bump", () => {
    expect(isNewer("2.0.0", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "2.0.0")).toBe(false);
  });

  it("detects minor bump", () => {
    expect(isNewer("0.4.0", "0.3.0")).toBe(true);
    expect(isNewer("0.3.0", "0.4.0")).toBe(false);
  });

  it("detects patch bump", () => {
    expect(isNewer("0.3.9", "0.3.8")).toBe(true);
    expect(isNewer("0.3.8", "0.3.9")).toBe(false);
  });

  it("returns false for same version", () => {
    expect(isNewer("0.3.8", "0.3.8")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  it("handles multi-digit versions", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.4.10", "0.4.9")).toBe(true);
    expect(isNewer("10.0.0", "9.0.0")).toBe(true);
  });

  it("major takes priority over minor and patch", () => {
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.99.99", "2.0.0")).toBe(false);
  });

  it("minor takes priority over patch", () => {
    expect(isNewer("0.5.0", "0.4.99")).toBe(true);
    expect(isNewer("0.4.99", "0.5.0")).toBe(false);
  });
});

// ── Update notice generation (mirrors session-start.ts logic) ───────────────

function buildUpdateNotice(current: string, latest: string, autoupdate: boolean, updateSucceeded: boolean | null): string {
  if (!isNewer(latest, current)) return "";

  if (autoupdate) {
    if (updateSucceeded) {
      return `\n\n✅ Hivemind auto-updated: ${current} → ${latest}. Tell the user to run /reload-plugins to apply.`;
    } else {
      return `\n\n⬆️ Hivemind update available: ${current} → ${latest}. Auto-update failed — run /hivemind:update to upgrade manually.`;
    }
  }
  return `\n\n⬆️ Hivemind update available: ${current} → ${latest}. Run /hivemind:update to upgrade.`;
}

describe("update notice generation", () => {
  it("returns empty string when versions are equal", () => {
    expect(buildUpdateNotice("0.3.8", "0.3.8", true, null)).toBe("");
  });

  it("returns empty string when current is newer", () => {
    expect(buildUpdateNotice("0.4.0", "0.3.8", true, null)).toBe("");
  });

  it("shows success notice on autoupdate success", () => {
    const notice = buildUpdateNotice("0.3.8", "0.4.0", true, true);
    expect(notice).toContain("✅");
    expect(notice).toContain("0.3.8 → 0.4.0");
    expect(notice).toContain("/reload-plugins");
  });

  it("shows failure notice on autoupdate failure", () => {
    const notice = buildUpdateNotice("0.3.8", "0.4.0", true, false);
    expect(notice).toContain("⬆️");
    expect(notice).toContain("Auto-update failed");
    expect(notice).toContain("/hivemind:update");
  });

  it("shows manual upgrade notice when autoupdate is off", () => {
    const notice = buildUpdateNotice("0.3.8", "0.4.0", false, null);
    expect(notice).toContain("⬆️");
    expect(notice).toContain("/hivemind:update");
    expect(notice).not.toContain("Auto-update failed");
    expect(notice).not.toContain("✅");
  });
});

// ── Credentials autoupdate field ────────────────────────────────────────────

describe("autoupdate credential defaults", () => {
  it("autoupdate defaults to true when undefined", () => {
    const creds: { autoupdate?: boolean } = {};
    const autoupdate = creds.autoupdate !== false;
    expect(autoupdate).toBe(true);
  });

  it("autoupdate is true when explicitly set", () => {
    const creds = { autoupdate: true };
    const autoupdate = creds.autoupdate !== false;
    expect(autoupdate).toBe(true);
  });

  it("autoupdate is false when disabled", () => {
    const creds = { autoupdate: false };
    const autoupdate = creds.autoupdate !== false;
    expect(autoupdate).toBe(false);
  });
});

// ── getInstalledVersion — walk-up directory search ────────────────────────────

/**
 * Mirrors the getInstalledVersion logic from session-start.ts:
 * walks up from bundleDir looking for a package.json with name "hivemind".
 */
function getInstalledVersion(bundleDir: string): string | null {
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version) return pkg.version;
    } catch { /* not here, keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

describe("getInstalledVersion — walk-up directory search", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `hivemind-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds package.json one level up (cache layout)", () => {
    // cache: <root>/bundle/  with package.json at <root>/
    const bundleDir = join(root, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hivemind", version: "0.6.18" }));
    expect(getInstalledVersion(bundleDir)).toBe("0.6.18");
  });

  it("finds package.json two levels up (marketplace layout)", () => {
    // marketplace: <root>/claude-code/bundle/  with package.json at <root>/
    const bundleDir = join(root, "claude-code", "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hivemind", version: "0.5.0" }));
    expect(getInstalledVersion(bundleDir)).toBe("0.5.0");
  });

  it("returns null when no package.json exists", () => {
    const bundleDir = join(root, "a", "b", "c");
    mkdirSync(bundleDir, { recursive: true });
    expect(getInstalledVersion(bundleDir)).toBeNull();
  });

  it("skips package.json with wrong name", () => {
    const bundleDir = join(root, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    // package.json exists but has wrong name
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other-pkg", version: "1.0.0" }));
    expect(getInstalledVersion(bundleDir)).toBeNull();
  });

  it("skips package.json without version field", () => {
    const bundleDir = join(root, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hivemind" }));
    expect(getInstalledVersion(bundleDir)).toBeNull();
  });

  it("finds the nearest matching package.json (not a deeper one)", () => {
    // Two package.json files: one at <root>/ (v1.0.0), one at <root>/claude-code/ (v2.0.0)
    const bundleDir = join(root, "claude-code", "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hivemind", version: "1.0.0" }));
    writeFileSync(join(root, "claude-code", "package.json"), JSON.stringify({ name: "hivemind", version: "2.0.0" }));
    // Should find claude-code/package.json first (closer)
    expect(getInstalledVersion(bundleDir)).toBe("2.0.0");
  });

  it("finds hivemind-codex package name (codex install)", () => {
    const bundleDir = join(root, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hivemind-codex", version: "0.6.7" }));
    expect(getInstalledVersion(bundleDir)).toBe("0.6.7");
  });
});
