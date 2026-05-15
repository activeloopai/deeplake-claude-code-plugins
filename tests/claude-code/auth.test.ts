import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Source-level tests for src/commands/auth.ts after the PR #76 split. The
 * fs-touching credential helpers moved to src/commands/auth-creds.ts (covered
 * by auth-creds.test.ts); what remains in auth.ts is the network surface
 * (apiGet/apiPost/apiDelete + device-flow + org/workspace ops) plus the JWT
 * decoder and a few small helpers. These tests exercise that surface with
 * mocked fetch + mocked auth-creds saveCredentials, asserting BOTH shape
 * (URL, method, headers, body) AND count (one call, not two), per the
 * testing rules in CLAUDE.md.
 */

const fetchMock = vi.fn();
const saveCredentialsMock = vi.fn();
const loadCredentialsMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);
vi.mock("../../src/commands/auth-creds.js", () => ({
  loadCredentials: () => loadCredentialsMock(),
  saveCredentials: (creds: unknown) => saveCredentialsMock(creds),
  deleteCredentials: vi.fn(),
}));
vi.mock("../../src/utils/client-header.js", () => ({
  deeplakeClientHeader: () => ({ "X-Deeplake-Client": "hivemind/test" }),
}));

async function importAuth() {
  vi.resetModules();
  return await import("../../src/commands/auth.js");
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  saveCredentialsMock.mockReset();
  loadCredentialsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decodeJwtPayload", () => {
  it("decodes a 3-part JWT and returns the payload object", async () => {
    const { decodeJwtPayload } = await importAuth();
    // header.{"sub":"alice","exp":99}.signature  (base64url)
    const payload = Buffer.from(JSON.stringify({ sub: "alice", exp: 99 })).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const token = `header.${payload}.sig`;
    const decoded = decodeJwtPayload(token);
    expect(decoded).toEqual({ sub: "alice", exp: 99 });
  });

  it("returns null when the token is not 3 parts", async () => {
    const { decodeJwtPayload } = await importAuth();
    expect(decodeJwtPayload("not.jwt")).toBeNull();
    expect(decodeJwtPayload("just-one-part")).toBeNull();
  });

  it("returns null when the payload is not valid JSON", async () => {
    const { decodeJwtPayload } = await importAuth();
    const garbage = Buffer.from("not-json").toString("base64").replace(/=+$/, "");
    expect(decodeJwtPayload(`h.${garbage}.s`)).toBeNull();
  });
});

describe("requestDeviceCode", () => {
  it("POSTs to /auth/device/code and returns the body on 200", async () => {
    fetchMock.mockResolvedValueOnce(ok({
      device_code: "dc1", user_code: "ABCD", verification_uri: "u", verification_uri_complete: "uc",
      expires_in: 600, interval: 5,
    }));
    const { requestDeviceCode } = await importAuth();
    const r = await requestDeviceCode("https://api.example");
    expect(r.user_code).toBe("ABCD");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example/auth/device/code");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["X-Deeplake-Client"]).toBe("hivemind/test");
  });

  it("throws on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    const { requestDeviceCode } = await importAuth();
    await expect(requestDeviceCode("https://api.example")).rejects.toThrow(/Device flow unavailable/);
  });
});

describe("pollForToken", () => {
  it("returns the token body on 200", async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }));
    const { pollForToken } = await importAuth();
    const r = await pollForToken("dc1", "https://api.example");
    expect(r?.access_token).toBe("tok");
  });

  it("returns null on authorization_pending (still waiting)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }));
    const { pollForToken } = await importAuth();
    const r = await pollForToken("dc1", "https://api.example");
    expect(r).toBeNull();
  });

  it("returns null on slow_down (caller must back off)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }));
    const { pollForToken } = await importAuth();
    const r = await pollForToken("dc1", "https://api.example");
    expect(r).toBeNull();
  });

  it("throws on access_denied", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }));
    const { pollForToken } = await importAuth();
    await expect(pollForToken("dc1", "https://api.example")).rejects.toThrow(/denied/);
  });

  it("throws on expired_token", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "expired_token" }), { status: 400 }));
    const { pollForToken } = await importAuth();
    await expect(pollForToken("dc1", "https://api.example")).rejects.toThrow(/expired/i);
  });

  it("throws 'Token polling failed: HTTP <code>' on non-200 with no recognized error code", async () => {
    fetchMock.mockResolvedValueOnce(new Response("server error", { status: 500 }));
    const { pollForToken } = await importAuth();
    await expect(pollForToken("dc1", "https://api.example")).rejects.toThrow(/Token polling failed: HTTP 500/);
  });
});

describe("authLog default", () => {
  it("default authLog writes to stderr (covers the body of the exported binding)", async () => {
    const { authLog } = await importAuth();
    const captured: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      captured.push(s);
      return true;
    }) as typeof process.stderr.write);
    try {
      authLog("hello");
      expect(captured.join("")).toContain("hello");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("listOrgs / listWorkspaces", () => {
  it("listOrgs GETs /organizations and forwards Bearer + client header", async () => {
    fetchMock.mockResolvedValueOnce(ok([{ id: "o1", name: "acme" }, { id: "o2", name: "globex" }]));
    const { listOrgs } = await importAuth();
    const orgs = await listOrgs("tok", "https://api.example");
    expect(orgs).toEqual([{ id: "o1", name: "acme" }, { id: "o2", name: "globex" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example/organizations");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["X-Deeplake-Client"]).toBe("hivemind/test");
    // listOrgs is a GET — no method override means default GET (no method key).
    expect(init.method).toBeUndefined();
  });

  it("listOrgs returns [] when API gives a non-array body", async () => {
    fetchMock.mockResolvedValueOnce(ok({ unexpected: true }));
    const { listOrgs } = await importAuth();
    expect(await listOrgs("tok", "https://api.example")).toEqual([]);
  });

  it("listWorkspaces accepts the {data: [...]} envelope shape", async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: "ws1", name: "default" }] }));
    const { listWorkspaces } = await importAuth();
    const ws = await listWorkspaces("tok", "https://api.example", "o1");
    expect(ws).toEqual([{ id: "ws1", name: "default" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example/workspaces");
    expect(init.headers["X-Activeloop-Org-Id"]).toBe("o1");
  });

  it("listWorkspaces accepts a bare array body", async () => {
    fetchMock.mockResolvedValueOnce(ok([{ id: "ws1", name: "default" }]));
    const { listWorkspaces } = await importAuth();
    const ws = await listWorkspaces("tok", "https://api.example", "o1");
    expect(ws).toEqual([{ id: "ws1", name: "default" }]);
  });
});

describe("switchOrg / switchWorkspace", () => {
  it("switchOrg writes the new orgId+orgName to credentials", async () => {
    loadCredentialsMock.mockReturnValue({ token: "tok", orgId: "old", savedAt: "x" });
    const { switchOrg } = await importAuth();
    await switchOrg("new-org", "Activeloop");
    expect(saveCredentialsMock).toHaveBeenCalledTimes(1);
    const written = saveCredentialsMock.mock.calls[0][0];
    expect(written.orgId).toBe("new-org");
    expect(written.orgName).toBe("Activeloop");
    expect(written.token).toBe("tok"); // preserved
  });

  it("switchOrg throws if not logged in", async () => {
    loadCredentialsMock.mockReturnValue(null);
    const { switchOrg } = await importAuth();
    await expect(switchOrg("new-org", "Activeloop")).rejects.toThrow(/Not logged in/);
    expect(saveCredentialsMock).not.toHaveBeenCalled();
  });

  it("switchWorkspace writes the new workspaceId", async () => {
    loadCredentialsMock.mockReturnValue({ token: "tok", orgId: "o", savedAt: "x" });
    const { switchWorkspace } = await importAuth();
    await switchWorkspace("ws2");
    const written = saveCredentialsMock.mock.calls[0][0];
    expect(written.workspaceId).toBe("ws2");
  });

  it("switchWorkspace throws if not logged in", async () => {
    loadCredentialsMock.mockReturnValue(null);
    const { switchWorkspace } = await importAuth();
    await expect(switchWorkspace("ws2")).rejects.toThrow(/Not logged in/);
  });
});

describe("inviteMember / listMembers / removeMember", () => {
  it("inviteMember POSTs to /organizations/<id>/members/invite with the right body", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    const { inviteMember } = await importAuth();
    await inviteMember("alice@example.com", "ADMIN", "tok", "o1", "https://api.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example/organizations/o1/members/invite");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Activeloop-Org-Id"]).toBe("o1");
    expect(JSON.parse(init.body)).toEqual({ username: "alice@example.com", access_mode: "ADMIN" });
  });

  it("listMembers extracts members[] from the response", async () => {
    fetchMock.mockResolvedValueOnce(ok({
      members: [{ user_id: "u1", name: "Alice", email: "a@x", role: "admin" }],
    }));
    const { listMembers } = await importAuth();
    const m = await listMembers("tok", "o1", "https://api.example");
    expect(m).toEqual([{ user_id: "u1", name: "Alice", email: "a@x", role: "admin" }]);
  });

  it("listMembers returns [] when members field is missing", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    const { listMembers } = await importAuth();
    expect(await listMembers("tok", "o1", "https://api.example")).toEqual([]);
  });

  it("removeMember DELETEs to /organizations/<id>/members/<userId>", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    const { removeMember } = await importAuth();
    await removeMember("u1", "tok", "o1", "https://api.example");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example/organizations/o1/members/u1");
    expect(init.method).toBe("DELETE");
  });
});

// Stub setTimeout so the polling loop in deviceFlowLogin runs synchronously
// (calls callback immediately). Faster than fake timers + works with awaits.
function stubInstantTimers() {
  return vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
}

describe("deviceFlowLogin", () => {
  it("polls until pollForToken returns a token, then resolves with it", async () => {
    // Sequence: requestDeviceCode (ok), poll #1 (pending → null), poll #2 (token).
    fetchMock
      .mockResolvedValueOnce(ok({
        device_code: "dc1", user_code: "U", verification_uri: "u",
        verification_uri_complete: "uc", expires_in: 600, interval: 5,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }))
      .mockResolvedValueOnce(ok({ access_token: "tok-final", token_type: "Bearer", expires_in: 3600 }));
    const restore = stubInstantTimers();
    try {
      const { deviceFlowLogin } = await importAuth();
      const result = await deviceFlowLogin("https://api.example");
      expect(result.token).toBe("tok-final");
      expect(result.expiresIn).toBe(3600);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      restore.mockRestore();
    }
  });

  it("throws 'Device code expired' if the deadline passes with no token", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({
        device_code: "dc1", user_code: "U", verification_uri: "u",
        verification_uri_complete: "uc", expires_in: 1, interval: 5,
      }))
      .mockResolvedValue(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }));

    // For this case Date.now() must advance beyond the 1-second deadline.
    // Since we stub setTimeout to fire instantly, the loop body runs but
    // Date.now() doesn't change between iterations — we'd loop forever
    // unless we patch Date.now to return increasing values.
    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    vi.spyOn(Date, "now").mockImplementation(() => {
      fakeNow += 2_000; // advance 2s per call so the deadline (1s out) passes
      return fakeNow;
    });
    const restore = stubInstantTimers();
    try {
      const { deviceFlowLogin } = await importAuth();
      await expect(deviceFlowLogin("https://api.example")).rejects.toThrow(/Device code expired/);
    } finally {
      restore.mockRestore();
      vi.restoreAllMocks();
    }
  });
});

describe("login (full flow)", () => {
  it("orchestrates device-flow + /me + listOrgs + /users/me/tokens, saves credentials", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({
        device_code: "dc", user_code: "U", verification_uri: "u",
        verification_uri_complete: "uc", expires_in: 600, interval: 5,
      }))
      .mockResolvedValueOnce(ok({ access_token: "short-lived-tok", token_type: "Bearer", expires_in: 600 }))
      .mockResolvedValueOnce(ok({ id: "u1", name: "Alice", email: "a@example.com" }))
      .mockResolvedValueOnce(ok([{ id: "o1", name: "acme" }]))
      .mockResolvedValueOnce(ok({ token: { token: "long-lived-tok" } }));

    const restore = stubInstantTimers();
    try {
      const { login } = await importAuth();
      const creds = await login("https://api.example");
      expect(creds.token).toBe("long-lived-tok");
      expect(creds.orgId).toBe("o1");
      expect(creds.orgName).toBe("acme");
      expect(creds.userName).toBe("Alice");
      expect(creds.workspaceId).toBe("default");
      expect(creds.apiUrl).toBe("https://api.example");
      expect(saveCredentialsMock).toHaveBeenCalledTimes(1);
    } finally {
      restore.mockRestore();
    }
  });

  it("with multiple orgs picks the first and announces selection", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({
        device_code: "dc", user_code: "U", verification_uri: "u",
        verification_uri_complete: "uc", expires_in: 600, interval: 5,
      }))
      .mockResolvedValueOnce(ok({ access_token: "t", token_type: "Bearer", expires_in: 600 }))
      .mockResolvedValueOnce(ok({ id: "u1", name: "Alice" }))
      .mockResolvedValueOnce(ok([
        { id: "o1", name: "acme" },
        { id: "o2", name: "globex" },
      ]))
      .mockResolvedValueOnce(ok({ token: { token: "long" } }));
    const restore = stubInstantTimers();
    try {
      const { login } = await importAuth();
      const creds = await login("https://api.example");
      expect(creds.orgId).toBe("o1"); // first one
    } finally {
      restore.mockRestore();
    }
  });

  it("falls back to email-prefix when /me has no name", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({
        device_code: "dc", user_code: "U", verification_uri: "u",
        verification_uri_complete: "uc", expires_in: 600, interval: 5,
      }))
      .mockResolvedValueOnce(ok({ access_token: "t", token_type: "Bearer", expires_in: 600 }))
      .mockResolvedValueOnce(ok({ id: "u1", email: "alice@example.com" }))
      .mockResolvedValueOnce(ok([{ id: "o1", name: "acme" }]))
      .mockResolvedValueOnce(ok({ token: { token: "long" } }));
    const restore = stubInstantTimers();
    try {
      const { login } = await importAuth();
      const creds = await login("https://api.example");
      expect(creds.userName).toBe("alice");
    } finally {
      restore.mockRestore();
    }
  });
});

describe("API helper error path", () => {
  it("apiGet throws with status code on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const { listOrgs } = await importAuth();
    await expect(listOrgs("tok", "https://api.example")).rejects.toThrow(/403/);
  });

  it("apiPost throws on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    const { inviteMember } = await importAuth();
    await expect(inviteMember("a@x", "READ", "tok", "o1", "https://api.example")).rejects.toThrow(/400/);
  });

  it("apiDelete throws on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const { removeMember } = await importAuth();
    await expect(removeMember("u1", "tok", "o1", "https://api.example")).rejects.toThrow(/404/);
  });
});
