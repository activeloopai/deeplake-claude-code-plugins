import { describe, it, expect } from "vitest";

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
