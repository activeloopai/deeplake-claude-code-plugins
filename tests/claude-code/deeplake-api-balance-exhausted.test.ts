import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for the balance-exhausted notification path in DeeplakeApi.
 *
 * Server returns 402 with body `{"balance_cents":0,"error":"insufficient
 * balance, please top up"}` when the org runs out of credits. Without
 * surfacing this, captures and memory recalls fail silently — the agent
 * reads empty memory and confidently reasons from no data, never telling
 * the user why. This pins the contract that:
 *
 *   - A 402 with `balance_cents` in the body enqueues a session-start banner
 *   - Process-local dedup: subsequent 402s in the same process don't double-enqueue
 *   - Non-402 errors do NOT enqueue
 *   - 402 WITHOUT `balance_cents` (some other 402 cause) does NOT enqueue
 *   - The original error still throws so callers' existing handling is unchanged
 */

const enqueueNotificationMock = vi.fn();
vi.mock("../../src/notifications/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/notifications/queue.js")>(
    "../../src/notifications/queue.js",
  );
  return { ...actual, enqueueNotification: (...a: unknown[]) => enqueueNotificationMock(...a) };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function bodyResp(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

let TEMP_HOME = "";
let ORIGINAL_HOME: string | undefined;

beforeEach(async () => {
  fetchMock.mockReset();
  enqueueNotificationMock.mockReset();
  enqueueNotificationMock.mockResolvedValue(undefined);
  const { _resetSdkStateForTesting } = await import("../../src/deeplake-api.js");
  _resetSdkStateForTesting();
  // Plant credentials in a sandbox HOME so billingUrl() can read orgName +
  // workspaceId. Tests that want to verify the no-creds fallback delete
  // the file inside the test body.
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-bal-exh-test-"));
  ORIGINAL_HOME = process.env.HOME;
  process.env.HOME = TEMP_HOME;
  mkdirSync(join(TEMP_HOME, ".deeplake"), { recursive: true });
  writeFileSync(
    join(TEMP_HOME, ".deeplake", "credentials.json"),
    JSON.stringify({
      token: "tok",
      orgId: "org-uuid",
      orgName: "acme",
      userName: "ada",
      workspaceId: "default",
      apiUrl: "https://api.example",
      savedAt: "2026-05-19T00:00:00Z",
    }),
    { mode: 0o600 },
  );
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  rmSync(TEMP_HOME, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function makeApi() {
  const { DeeplakeApi } = await import("../../src/deeplake-api.js");
  return new DeeplakeApi("tok", "https://api.example", "org", "ws", "memory");
}

describe("DeeplakeApi — 402 balance-exhausted handling", () => {
  it("enqueues a session-start banner when the daemon returns 402 with balance_cents:0", async () => {
    fetchMock.mockResolvedValueOnce(
      bodyResp(402, JSON.stringify({ balance_cents: 0, error: "insufficient balance, please top up" })),
    );
    const api = await makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow(/Query failed: 402/);

    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
    const arg = enqueueNotificationMock.mock.calls[0][0];
    expect(arg.id).toBe("balance-exhausted");
    expect(arg.severity).toBe("warn");
    expect(arg.title).toMatch(/credits exhausted/i);
    expect(arg.body).toMatch(/top up/i);
    // Org-scoped billing URL: deeplake.ai/{orgName}/workspace/{workspaceId}/billing
    expect(arg.body).toContain("https://deeplake.ai/acme/workspace/default/billing");
    expect(arg.dedupKey.reason).toBe("balance-zero");
    // No date — transient mode means refire every session-start while the
    // 402 keeps re-enqueuing. Daily-rotation logic was unnecessary.
    expect(arg.dedupKey.date).toBeUndefined();
    // transient: true → the drain shows it but does NOT record in
    // state.shown, so the next session's drain re-fires the freshly-
    // enqueued copy. Required for "fire every session until topped up"
    // semantics without re-enqueuing logic in deeplake-api.ts.
    expect(arg.transient).toBe(true);
  });

  it("process-local dedup: a second 402 in the same process does not re-enqueue", async () => {
    fetchMock.mockResolvedValue(
      bodyResp(402, JSON.stringify({ balance_cents: 0, error: "insufficient balance, please top up" })),
    );
    const api = await makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow(/402/);
    await expect(api.query("INSERT INTO sessions VALUES (1)")).rejects.toThrow(/402/);
    await expect(api.query("SELECT 2")).rejects.toThrow(/402/);
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue when status is 402 but body lacks balance_cents (a different 402 reason)", async () => {
    fetchMock.mockResolvedValueOnce(bodyResp(402, JSON.stringify({ error: "some-other-402-cause" })));
    const api = await makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow(/402/);
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  it("does NOT enqueue for non-402 errors", async () => {
    // 500 with balance_cents in body — only the STATUS+BODY combination should match.
    fetchMock.mockResolvedValueOnce(
      bodyResp(500, JSON.stringify({ balance_cents: 0, error: "internal" })),
    );
    // Re-fire 4 times (3 retries + final) to exhaust retry budget.
    fetchMock.mockResolvedValue(bodyResp(500, JSON.stringify({ balance_cents: 0, error: "internal" })));
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const api = await makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow(/Query failed: 500/);
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  it("falls back to https://deeplake.ai when credentials are missing or malformed", async () => {
    // Wipe the planted creds — billingUrl() should return the bare host
    // rather than producing a URL with literal `undefined` segments.
    rmSync(join(TEMP_HOME, ".deeplake", "credentials.json"));
    fetchMock.mockResolvedValueOnce(
      bodyResp(402, JSON.stringify({ balance_cents: 0, error: "insufficient balance, please top up" })),
    );
    const api = await makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow(/402/);
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
    const arg = enqueueNotificationMock.mock.calls[0][0];
    expect(arg.body).toContain("https://deeplake.ai");
    expect(arg.body).not.toContain("undefined");
    expect(arg.body).not.toContain("/workspace/");
  });

  it("still throws the original Query failed error (caller's catch path unchanged)", async () => {
    fetchMock.mockResolvedValueOnce(
      bodyResp(402, JSON.stringify({ balance_cents: 0, error: "insufficient balance, please top up" })),
    );
    const api = await makeApi();
    let caught: unknown = null;
    try {
      await api.query("SELECT 1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Query failed: 402/);
    expect((caught as Error).message).toMatch(/insufficient balance/);
  });
});
