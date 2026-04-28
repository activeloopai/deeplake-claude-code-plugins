/**
 * Source-level coverage for src/commands/auth.ts.
 *
 * Mocks the side-effecting boundaries (node:fs, node:os, node:child_process,
 * global.fetch) so the real auth module logic — credential storage, JWT
 * payload decoding, API helpers (incl. the new X-Deeplake-Client header
 * injection), the device-flow polling state machine, and the full login
 * orchestration — runs unmodified.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Filesystem + homedir mocks (set before auth.ts loads so its
//    module-level join(homedir(), ".deeplake") resolves to /tmp/test-home).
const HOME = "/tmp/test-home";
const fakeFs = new Map<string, string>();
const existsMock = vi.fn((p: string) => fakeFs.has(p));
const readMock = vi.fn((p: string) => {
  const v = fakeFs.get(p);
  if (v === undefined) throw new Error(`ENOENT: ${p}`);
  return v;
});
const writeMock = vi.fn((p: string, c: string) => { fakeFs.set(p, c); });
const mkdirMock = vi.fn();
const unlinkMock = vi.fn((p: string) => { fakeFs.delete(p); });

vi.mock("node:fs", () => ({
  readFileSync: (p: string) => readMock(p),
  writeFileSync: (p: string, c: string) => writeMock(p, c),
  existsSync: (p: string) => existsMock(p),
  mkdirSync: (...a: unknown[]) => mkdirMock(...a),
  unlinkSync: (p: string) => unlinkMock(p),
}));

vi.mock("node:os", () => ({ homedir: () => HOME }));

const execMock = vi.fn();
vi.mock("node:child_process", () => ({ execSync: (...a: unknown[]) => execMock(...a) }));

// Suppress stderr noise from auth.ts during tests.
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

// Pull in the module *after* the mocks above are registered.
const auth = await import("../../src/commands/auth.js");

const CREDS_PATH = `${HOME}/.deeplake/credentials.json`;

function fetchSpy(): { calls: { url: string; init?: RequestInit }[]; mock: ReturnType<typeof vi.fn>; nextResponse: (resp: Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }) => void } {
  const queue: any[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (queue.length === 0) {
      throw new Error(`unexpected fetch to ${url} (no queued response)`);
    }
    return queue.shift();
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock, nextResponse: (r) => queue.push(r) };
}

function ok(body: unknown): { ok: true; status: 200; json: () => Promise<unknown>; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function notOk(status: number, bodyText = ""): { ok: false; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
  return {
    ok: false,
    status,
    json: async () => { try { return JSON.parse(bodyText); } catch { return {}; } },
    text: async () => bodyText,
  };
}

beforeEach(() => {
  fakeFs.clear();
  existsMock.mockClear();
  readMock.mockClear();
  writeMock.mockClear();
  mkdirMock.mockClear();
  unlinkMock.mockClear();
  execMock.mockClear();
  stderrMock.mockClear();
  vi.unstubAllGlobals();
});

describe("decodeJwtPayload", () => {
  it("decodes a 3-part JWT", () => {
    const payload = { sub: "user-1", iat: 1700000000 };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = `header.${b64}.sig`;
    expect(auth.decodeJwtPayload(token)).toEqual(payload);
  });

  it("returns null for a non-3-part token", () => {
    expect(auth.decodeJwtPayload("not.a.real.token")).toBeNull();
    expect(auth.decodeJwtPayload("only-one-part")).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(auth.decodeJwtPayload("h.@@@notbase64@@@.s")).toBeNull();
  });
});

describe("credential storage", () => {
  it("loadCredentials returns null when no file exists", () => {
    expect(auth.loadCredentials()).toBeNull();
  });

  it("loadCredentials parses an existing file", () => {
    fakeFs.set(CREDS_PATH, JSON.stringify({ token: "t", orgId: "o", savedAt: "ts" }));
    expect(auth.loadCredentials()).toMatchObject({ token: "t", orgId: "o" });
  });

  it("loadCredentials returns null on malformed JSON", () => {
    fakeFs.set(CREDS_PATH, "not json {");
    expect(auth.loadCredentials()).toBeNull();
  });

  it("saveCredentials writes JSON + sets savedAt", () => {
    auth.saveCredentials({ token: "abc", orgId: "o1", savedAt: "" });
    expect(fakeFs.has(CREDS_PATH)).toBe(true);
    const written = JSON.parse(fakeFs.get(CREDS_PATH)!);
    expect(written.token).toBe("abc");
    expect(typeof written.savedAt).toBe("string");
    expect(written.savedAt.length).toBeGreaterThan(0);
  });

  it("saveCredentials creates config dir when missing", () => {
    existsMock.mockImplementationOnce(() => false);
    auth.saveCredentials({ token: "x", orgId: "y", savedAt: "" });
    expect(mkdirMock).toHaveBeenCalled();
  });

  it("saveCredentials skips mkdir when config dir already exists", () => {
    existsMock.mockImplementationOnce(() => true);
    auth.saveCredentials({ token: "x", orgId: "y", savedAt: "" });
    expect(mkdirMock).not.toHaveBeenCalled();
  });

  it("deleteCredentials returns true when a file existed", () => {
    fakeFs.set(CREDS_PATH, "{}");
    expect(auth.deleteCredentials()).toBe(true);
    expect(fakeFs.has(CREDS_PATH)).toBe(false);
  });

  it("deleteCredentials returns false when no file", () => {
    expect(auth.deleteCredentials()).toBe(false);
  });
});

describe("API helpers — header injection (incl. X-Deeplake-Client)", () => {
  it("listOrgs sets Authorization + X-Deeplake-Client (apiGet path)", async () => {
    const f = fetchSpy();
    f.nextResponse(ok([{ id: "o1", name: "Org 1" }]));

    const orgs = await auth.listOrgs("tok-xyz", "https://api.example.com");

    expect(orgs).toEqual([{ id: "o1", name: "Org 1" }]);
    const headers = f.calls[0].init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-xyz");
    expect(headers["X-Deeplake-Client"]).toMatch(/^hivemind\//);
    expect(f.calls[0].url).toBe("https://api.example.com/organizations");
  });

  it("listOrgs returns [] when API returns non-array", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({ unexpected: true }));
    expect(await auth.listOrgs("t")).toEqual([]);
  });

  it("inviteMember sets X-Activeloop-Org-Id + X-Deeplake-Client (apiPost path)", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({}));

    await auth.inviteMember("ada@x.com", "WRITE", "tok", "org-xyz", "https://api.example.com");

    const headers = f.calls[0].init!.headers as Record<string, string>;
    expect(headers["X-Activeloop-Org-Id"]).toBe("org-xyz");
    expect(headers["X-Deeplake-Client"]).toMatch(/^hivemind\//);
    expect(f.calls[0].init!.method).toBe("POST");
    expect(f.calls[0].url).toBe("https://api.example.com/organizations/org-xyz/members/invite");
  });

  it("listMembers returns members array via apiGet", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({ members: [{ user_id: "u1", name: "n", email: "e", role: "ADMIN" }] }));

    const members = await auth.listMembers("tok", "org-1");
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe("u1");
  });

  it("listMembers returns [] when response is missing members", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({}));
    expect(await auth.listMembers("tok", "org-1")).toEqual([]);
  });

  it("removeMember uses DELETE + correct URL (apiDelete path)", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({}));

    await auth.removeMember("user-9", "tok", "org-1");

    const headers = f.calls[0].init!.headers as Record<string, string>;
    expect(f.calls[0].init!.method).toBe("DELETE");
    expect(headers["X-Deeplake-Client"]).toMatch(/^hivemind\//);
    expect(f.calls[0].url).toContain("/organizations/org-1/members/user-9");
  });

  it("apiGet throws on non-2xx", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(403, "forbidden"));
    await expect(auth.listOrgs("tok")).rejects.toThrow(/403/);
  });

  it("apiPost throws on non-2xx", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(500));
    await expect(auth.inviteMember("u", "READ", "t", "o")).rejects.toThrow(/500/);
  });

  it("apiDelete throws on non-2xx", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(404, "missing"));
    await expect(auth.removeMember("u", "t", "o")).rejects.toThrow(/404/);
  });
});

describe("listWorkspaces", () => {
  it("unwraps both {data: [...]} and bare array shapes", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({ data: [{ id: "w1", name: "default" }] }));
    expect(await auth.listWorkspaces("t", undefined, "org-1")).toEqual([{ id: "w1", name: "default" }]);

    f.nextResponse(ok([{ id: "w2", name: "other" }]));
    expect(await auth.listWorkspaces("t")).toEqual([{ id: "w2", name: "other" }]);
  });

  it("returns [] when the response shape is neither array nor {data: array}", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({ unexpected: true }));
    expect(await auth.listWorkspaces("t")).toEqual([]);
  });
});

describe("switchOrg / switchWorkspace", () => {
  it("switchOrg throws when not logged in", async () => {
    await expect(auth.switchOrg("o2", "Org Two")).rejects.toThrow(/Not logged in/);
  });

  it("switchOrg saves new orgId/orgName preserving the rest", async () => {
    fakeFs.set(CREDS_PATH, JSON.stringify({
      token: "t", orgId: "old", orgName: "Old", userName: "u", workspaceId: "ws", apiUrl: "https://x", savedAt: "ts",
    }));
    await auth.switchOrg("new", "New Org");
    const saved = JSON.parse(fakeFs.get(CREDS_PATH)!);
    expect(saved.orgId).toBe("new");
    expect(saved.orgName).toBe("New Org");
    expect(saved.token).toBe("t");
    expect(saved.userName).toBe("u");
  });

  it("switchWorkspace throws when not logged in", async () => {
    await expect(auth.switchWorkspace("ws-x")).rejects.toThrow(/Not logged in/);
  });

  it("switchWorkspace updates only the workspaceId", async () => {
    fakeFs.set(CREDS_PATH, JSON.stringify({
      token: "t", orgId: "o", workspaceId: "old", savedAt: "ts",
    }));
    await auth.switchWorkspace("new-ws");
    const saved = JSON.parse(fakeFs.get(CREDS_PATH)!);
    expect(saved.workspaceId).toBe("new-ws");
    expect(saved.orgId).toBe("o");
  });
});

describe("device flow", () => {
  it("requestDeviceCode posts to /auth/device/code and parses the response", async () => {
    const f = fetchSpy();
    const body = {
      device_code: "dc", user_code: "UC-1234",
      verification_uri: "https://v", verification_uri_complete: "https://v?code=UC-1234",
      expires_in: 900, interval: 5,
    };
    f.nextResponse(ok(body));

    const got = await auth.requestDeviceCode("https://api.example.com");

    expect(got).toEqual(body);
    expect(f.calls[0].url).toBe("https://api.example.com/auth/device/code");
    expect(f.calls[0].init!.method).toBe("POST");
    const headers = f.calls[0].init!.headers as Record<string, string>;
    expect(headers["X-Deeplake-Client"]).toMatch(/^hivemind\//);
  });

  it("requestDeviceCode throws when API returns non-2xx", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(503));
    await expect(auth.requestDeviceCode()).rejects.toThrow(/Device flow unavailable/);
  });

  it("pollForToken returns the token on 2xx", async () => {
    const f = fetchSpy();
    f.nextResponse(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));
    const result = await auth.pollForToken("dc");
    expect(result?.access_token).toBe("tok");
  });

  it("pollForToken returns null while authorization_pending", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(400, JSON.stringify({ error: "authorization_pending" })));
    expect(await auth.pollForToken("dc")).toBeNull();
  });

  it("pollForToken returns null on slow_down", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(400, JSON.stringify({ error: "slow_down" })));
    expect(await auth.pollForToken("dc")).toBeNull();
  });

  it("pollForToken throws on expired_token", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(400, JSON.stringify({ error: "expired_token" })));
    await expect(auth.pollForToken("dc")).rejects.toThrow(/expired/i);
  });

  it("pollForToken throws on access_denied", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(400, JSON.stringify({ error: "access_denied" })));
    await expect(auth.pollForToken("dc")).rejects.toThrow(/denied/i);
  });

  it("pollForToken throws on other 400 with no recognized error", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(400, "not-json"));
    await expect(auth.pollForToken("dc")).rejects.toThrow(/Token polling failed: HTTP 400/);
  });

  it("pollForToken throws on non-400 / non-2xx", async () => {
    const f = fetchSpy();
    f.nextResponse(notOk(503));
    await expect(auth.pollForToken("dc")).rejects.toThrow(/HTTP 503/);
  });

  it("deviceFlowLogin orchestrates request + poll, opens browser, returns token", async () => {
    vi.useFakeTimers();
    const f = fetchSpy();
    f.nextResponse(ok({
      device_code: "dc", user_code: "UC", verification_uri: "https://v",
      verification_uri_complete: "https://v?c=UC", expires_in: 900, interval: 1,
    }));
    f.nextResponse(ok({ access_token: "the-token", token_type: "Bearer", expires_in: 3600 }));

    const promise = auth.deviceFlowLogin("https://api.example.com");
    // The poll loop sleeps for `interval * 1000` (clamped to 5s minimum); fast-forward.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result.token).toBe("the-token");
    expect(execMock).toHaveBeenCalled(); // openBrowser tried to open
    vi.useRealTimers();
  });

  it("deviceFlowLogin still completes when openBrowser fails (covers catch + falsy-opened branch)", async () => {
    vi.useFakeTimers();
    execMock.mockImplementationOnce(() => { throw new Error("no display"); });
    const f = fetchSpy();
    f.nextResponse(ok({
      device_code: "dc", user_code: "UC", verification_uri: "https://v",
      verification_uri_complete: "https://v?c=UC", expires_in: 900, interval: 1,
    }));
    f.nextResponse(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));

    const promise = auth.deviceFlowLogin("https://api.example.com");
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result.token).toBe("tok");
    vi.useRealTimers();
  });

  it("deviceFlowLogin throws when device code expires before any poll succeeds", async () => {
    vi.useFakeTimers();
    const f = fetchSpy();
    f.nextResponse(ok({
      device_code: "dc", user_code: "UC", verification_uri: "https://v",
      verification_uri_complete: "https://v?c=UC", expires_in: 1, interval: 1, // 1s expiry
    }));
    f.nextResponse(notOk(400, JSON.stringify({ error: "authorization_pending" })));

    // Attach the rejection handler synchronously so vitest doesn't flag the
    // pending promise as an unhandled rejection while we advance timers.
    const promise = auth.deviceFlowLogin("https://api.example.com");
    let caught: unknown;
    const settled = promise.catch(e => { caught = e; });

    // Both the poll interval (≥5s) and the deadline (1s) elapse — loop exits via deadline.
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Device code expired/);
    vi.useRealTimers();
  });

  it("openBrowser linux branch (xdg-open) is exercised when platform=linux", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      vi.useFakeTimers();
      const f = fetchSpy();
      f.nextResponse(ok({
        device_code: "dc", user_code: "UC", verification_uri: "https://v",
        verification_uri_complete: "https://v?c=UC", expires_in: 900, interval: 1,
      }));
      f.nextResponse(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));

      const promise = auth.deviceFlowLogin();
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;

      expect(execMock).toHaveBeenCalledWith(expect.stringContaining("xdg-open"), expect.any(Object));
      vi.useRealTimers();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("openBrowser win32 branch (start) is exercised when platform=win32", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      vi.useFakeTimers();
      const f = fetchSpy();
      f.nextResponse(ok({
        device_code: "dc", user_code: "UC", verification_uri: "https://v",
        verification_uri_complete: "https://v?c=UC", expires_in: 900, interval: 1,
      }));
      f.nextResponse(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));

      const promise = auth.deviceFlowLogin();
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;

      expect(execMock).toHaveBeenCalledWith(expect.stringContaining("start"), expect.any(Object));
      vi.useRealTimers();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});

describe("login orchestration", () => {
  it("walks the full flow with a single org", async () => {
    vi.useFakeTimers();
    const f = fetchSpy();
    // 1. requestDeviceCode
    f.nextResponse(ok({
      device_code: "dc", user_code: "UC", verification_uri: "https://v",
      verification_uri_complete: "https://v?c=UC", expires_in: 900, interval: 1,
    }));
    // 2. pollForToken
    f.nextResponse(ok({ access_token: "auth-tok", token_type: "Bearer", expires_in: 3600 }));
    // 3. apiGet /me
    f.nextResponse(ok({ id: "u1", name: "ada", email: "ada@x.com" }));
    // 4. listOrgs
    f.nextResponse(ok([{ id: "org-1", name: "Solo Org" }]));
    // 5. apiPost /users/me/tokens
    f.nextResponse(ok({ token: { token: "long-lived-api-token" } }));

    const promise = auth.login("https://api.example.com");
    await vi.advanceTimersByTimeAsync(5_000);
    const creds = await promise;

    expect(creds.token).toBe("long-lived-api-token");
    expect(creds.orgId).toBe("org-1");
    expect(creds.orgName).toBe("Solo Org");
    expect(creds.userName).toBe("ada");
    expect(creds.workspaceId).toBe("default");

    // Saved to disk under fake home
    expect(fakeFs.has(CREDS_PATH)).toBe(true);
    const onDisk = JSON.parse(fakeFs.get(CREDS_PATH)!);
    expect(onDisk.token).toBe("long-lived-api-token");
    vi.useRealTimers();
  });

  it("login falls back to 'unknown' when both user.name and user.email are empty", async () => {
    vi.useFakeTimers();
    const f = fetchSpy();
    f.nextResponse(ok({
      device_code: "dc", user_code: "UC", verification_uri: "https://v",
      verification_uri_complete: "https://v?c=UC", expires_in: 900, interval: 1,
    }));
    f.nextResponse(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));
    f.nextResponse(ok({ id: "u", name: "", email: "" }));
    f.nextResponse(ok([{ id: "o", name: "Solo" }]));
    f.nextResponse(ok({ token: { token: "api-tok" } }));

    const promise = auth.login();
    await vi.advanceTimersByTimeAsync(5_000);
    const creds = await promise;

    expect(creds.userName).toBe("unknown");
    vi.useRealTimers();
  });

  it("deviceFlowLogin falls back to 5s interval when server omits one", async () => {
    vi.useFakeTimers();
    const f = fetchSpy();
    f.nextResponse(ok({
      device_code: "dc", user_code: "UC", verification_uri: "https://v",
      verification_uri_complete: "https://v?c=UC", expires_in: 900,
      // interval omitted → falls back to 5
    }));
    f.nextResponse(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));

    const promise = auth.deviceFlowLogin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await promise).token).toBe("tok");
    vi.useRealTimers();
  });

  it("multi-org path defaults to the first org", async () => {
    vi.useFakeTimers();
    const f = fetchSpy();
    f.nextResponse(ok({
      device_code: "dc", user_code: "UC", verification_uri: "https://v",
      verification_uri_complete: "https://v?c=UC", expires_in: 900, interval: 1,
    }));
    f.nextResponse(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));
    f.nextResponse(ok({ id: "u", name: "", email: "ada@x.com" })); // empty name → falls back to email-prefix
    f.nextResponse(ok([{ id: "first", name: "First" }, { id: "second", name: "Second" }]));
    f.nextResponse(ok({ token: { token: "api-tok" } }));

    const promise = auth.login();
    await vi.advanceTimersByTimeAsync(5_000);
    const creds = await promise;

    expect(creds.orgId).toBe("first");
    expect(creds.userName).toBe("ada"); // email-prefix fallback
    vi.useRealTimers();
  });
});
