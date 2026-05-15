import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderNotifications } from "../../src/notifications/format.js";
import { welcomeRule } from "../../src/notifications/rules/welcome.js";
import {
  registerRule,
  listRules,
  evaluateRules,
  _resetRulesForTest,
} from "../../src/notifications/rules/registry.js";
import { emit } from "../../src/notifications/delivery/index.js";
import { readState, writeState, statePath } from "../../src/notifications/state.js";
import { readQueue, writeQueue, enqueueNotification, queuePath } from "../../src/notifications/queue.js";
import { drainSessionStart } from "../../src/notifications/index.js";
import { fetchBackendNotifications } from "../../src/notifications/sources/backend.js";
import type { Notification, Rule } from "../../src/notifications/index.js";
import type { Credentials } from "../../src/commands/auth-creds.js";

/**
 * Targeted coverage tests for branches not exercised by the main
 * notifications.test.ts. Each test names the source file + branch it covers.
 */

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-notif-cov-"));
  ORIGINAL_HOME = process.env.HOME;
  process.env.HOME = TEMP_HOME;
  _resetRulesForTest();
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// format.ts: severity fallback branches
// ---------------------------------------------------------------------------

describe("format — severity fallbacks", () => {
  it("uses info prefix when severity is undefined", () => {
    const items: Notification[] = [{ id: "a", title: "T", body: "B", dedupKey: {} }];
    expect(renderNotifications(items)).toContain("🐝");
  });

  it("falls back to info prefix when severity is an unrecognized string", () => {
    const items: Notification[] = [
      { id: "a", severity: "weird-bogus" as any, title: "T", body: "B", dedupKey: {} },
    ];
    expect(renderNotifications(items)).toContain("🐝");
  });
});

// ---------------------------------------------------------------------------
// rules/welcome.ts: optional creds fields
// ---------------------------------------------------------------------------

describe("welcomeRule — optional creds fallbacks", () => {
  const baseCreds: Credentials = {
    token: "tok",
    orgId: "org-only",
    savedAt: "2026-05-06T00:00:00Z",
  };

  it("drops the comma-clause when userName is missing (no awkward 'there' fallback)", () => {
    const result = welcomeRule.evaluate({
      agent: "claude-code",
      creds: { ...baseCreds, userName: undefined },
      state: { shown: {} },
    });
    expect(result?.title).toBe("Welcome back");
    expect(result?.title).not.toContain("there");
    expect(result?.title).not.toContain(",");
  });

  it("falls back to 'your organization' when orgName is missing (does NOT expose orgId UUID)", () => {
    const result = welcomeRule.evaluate({
      agent: "claude-code",
      creds: { ...baseCreds, orgName: undefined, userName: "u" },
      state: { shown: {} },
    });
    expect(result?.body).toContain("your organization");
    // Critical: must NOT leak the UUID-shaped orgId into user-facing text.
    expect(result?.body).not.toContain(baseCreds.orgId);
    expect(result?.body).not.toContain("undefined");
  });

  it("uses 'org <name>' phrasing when orgName is present", () => {
    const result = welcomeRule.evaluate({
      agent: "claude-code",
      creds: { ...baseCreds, orgName: "acme", userName: "u" },
      state: { shown: {} },
    });
    expect(result?.body).toContain("Connected to org acme");
  });

  it("falls back to 'default' workspace when workspaceId is missing", () => {
    const result = welcomeRule.evaluate({
      agent: "claude-code",
      creds: { ...baseCreds, workspaceId: undefined, userName: "u" },
      state: { shown: {} },
    });
    expect(result?.body).toContain("default");
  });
});

// ---------------------------------------------------------------------------
// rules/registry.ts: duplicate registration + trigger filtering
// ---------------------------------------------------------------------------

describe("rules registry — edge cases", () => {
  it("throws on duplicate rule id", () => {
    registerRule(welcomeRule);
    expect(() => registerRule(welcomeRule)).toThrow(/duplicate rule id/);
  });

  it("listRules returns currently registered rules", () => {
    expect(listRules()).toHaveLength(0);
    registerRule(welcomeRule);
    expect(listRules()).toHaveLength(1);
  });

  it("evaluateRules ignores rules with non-matching triggers", () => {
    const adHocRule: Rule = {
      id: "ad-hoc-test",
      trigger: "ad_hoc",
      evaluate: () => ({ id: "should-not-fire", title: "T", body: "B", dedupKey: {} }),
    };
    registerRule(adHocRule);
    const out = evaluateRules("session_start", {
      agent: "claude-code",
      creds: null,
      state: { shown: {} },
    });
    expect(out).toHaveLength(0);
  });

  it("evaluateRules drops rules that return null", () => {
    const nullRule: Rule = {
      id: "always-null",
      trigger: "session_start",
      evaluate: () => null,
    };
    registerRule(nullRule);
    const out = evaluateRules("session_start", {
      agent: "claude-code",
      creds: null,
      state: { shown: {} },
    });
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// delivery/index.ts: empty-string short-circuit
// ---------------------------------------------------------------------------

describe("delivery dispatch — empty rendered short-circuit", () => {
  it("emit() returns silently when rendered is empty string", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: any) => {
      writes.push(typeof c === "string" ? c : c.toString());
      return true;
    });
    emit("claude-code", "");
    expect(writes).toEqual([]);
    vi.restoreAllMocks();
  });
});


// ---------------------------------------------------------------------------
// state.ts: shape-mismatch malformed JSON branches
// ---------------------------------------------------------------------------

describe("state — malformed shape (valid JSON, wrong type)", () => {
  it("treats null payload as empty", () => {
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(statePath(), "null", "utf-8");
    expect(readState()).toEqual({ shown: {} });
  });

  it("treats array payload as empty", () => {
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(statePath(), "[1,2,3]", "utf-8");
    expect(readState()).toEqual({ shown: {} });
  });

  it("treats { shown: 'not-object' } as empty", () => {
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ shown: "string-not-object" }), "utf-8");
    expect(readState()).toEqual({ shown: {} });
  });

  it("writeState round-trips through readState", () => {
    writeState({ shown: { foo: { dedupKey: "k", shownAt: "2026" } } });
    expect(readState().shown.foo.dedupKey).toBe("k");
  });
});

// ---------------------------------------------------------------------------
// queue.ts: shape-mismatch malformed JSON
// ---------------------------------------------------------------------------

describe("queue — malformed shape (valid JSON, wrong type)", () => {
  it("treats null payload as empty queue", () => {
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(queuePath(), "null", "utf-8");
    expect(readQueue()).toEqual({ queue: [] });
  });

  it("treats { queue: 'not-array' } as empty queue", () => {
    mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
    writeFileSync(queuePath(), JSON.stringify({ queue: "string-not-array" }), "utf-8");
    expect(readQueue()).toEqual({ queue: [] });
  });

  it("writeQueue round-trips through readQueue", () => {
    writeQueue({ queue: [{ id: "x", title: "T", body: "B", dedupKey: {} }] });
    expect(readQueue().queue).toHaveLength(1);
    expect(readQueue().queue[0].id).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// sources/backend.ts: edge-case branches
// ---------------------------------------------------------------------------

describe("backend source — edge cases", () => {
  const FRESH_CREDS: Credentials = {
    token: "tok",
    orgId: "org",
    userName: "u",
    savedAt: "2026-05-06T00:00:00Z",
  };

  afterEach(() => vi.restoreAllMocks());

  it("uses DEFAULT_API_URL when creds.apiUrl is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args: any[]) => {
      return new Response(JSON.stringify({ notifications: [] }), { status: 200 });
    });
    await fetchBackendNotifications({ ...FRESH_CREDS, apiUrl: undefined });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("api.deeplake.ai");
  });

  it("omits X-Activeloop-Org-Id header when creds.orgId is missing", async () => {
    let captured: any = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args: any[]) => {
      captured = args[1];
      return new Response(JSON.stringify({ notifications: [] }), { status: 200 });
    });
    await fetchBackendNotifications({ ...FRESH_CREDS, orgId: "" });
    const headers = captured?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("X-Activeloop-Org-Id");
  });

  it("treats malformed body shape as empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ wrong: "shape" }), { status: 200 });
    });
    const out = await fetchBackendNotifications(FRESH_CREDS);
    expect(out).toEqual([]);
  });

  it("normalizes invalid severity to info", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          notifications: [
            { id: "a", severity: "BOGUS", title: "T", body: "B", dedup_key: "k" },
          ],
        }),
        { status: 200 },
      );
    });
    const out = await fetchBackendNotifications(FRESH_CREDS);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("info");
  });

  it("handles missing dedup_key on server response (defaults to empty string)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          notifications: [{ id: "a", title: "T", body: "B" }],
        }),
        { status: 200 },
      );
    });
    const out = await fetchBackendNotifications(FRESH_CREDS);
    expect(out).toHaveLength(1);
    expect(out[0].dedupKey).toEqual({ id: "a", dedup_key: "" });
  });
});

// ---------------------------------------------------------------------------
// drainSessionStart: queue-drain-on-empty-fresh branch
// ---------------------------------------------------------------------------

describe("drainSessionStart — queue drained even when nothing fresh", () => {
  afterEach(() => vi.restoreAllMocks());

  it("when all notifications are dedup'd, queue is still drained", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: any) => {
      writes.push(typeof c === "string" ? c : c.toString());
      return true;
    });

    const n: Notification = { id: "x", title: "T", body: "B", dedupKey: { v: 1 } };
    enqueueNotification(n);

    // First drain: fires, marks as shown
    await drainSessionStart({ agent: "claude-code", creds: null });
    expect(writes.length).toBe(1);
    expect(readQueue().queue.length).toBe(0);

    // Re-enqueue same notification with same dedupKey → fresh.length === 0
    enqueueNotification(n);
    expect(readQueue().queue.length).toBe(1);

    writes.length = 0;
    await drainSessionStart({ agent: "claude-code", creds: null });
    expect(writes.length).toBe(0); // dedup'd
    // Critical: queue still drained even though nothing emitted
    expect(readQueue().queue.length).toBe(0);
  });
});

