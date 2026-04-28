import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/cli/auth.ts — the thin login/orgs surface used by the
 * unified installer.
 *
 * isLoggedIn / ensureLoggedIn / maybeShowOrgChoice all delegate to
 * commands/auth.js (loadCredentials/login/listOrgs) and existsSync. Mock
 * those at the boundary (CLAUDE.md rule 5) so we exercise auth.ts logic
 * exclusively, including the env-var precedence on apiUrl.
 */

const existsSyncMock = vi.fn();
const loadCredentialsMock = vi.fn();
const loginMock = vi.fn();
const listOrgsMock = vi.fn();
const stdoutWriteMock = vi.fn();
const stderrWriteMock = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...a: unknown[]) => existsSyncMock(...a),
  };
});

vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: unknown[]) => loadCredentialsMock(...a),
  login: (...a: unknown[]) => loginMock(...a),
  listOrgs: (...a: unknown[]) => listOrgsMock(...a),
}));

async function importFresh(): Promise<typeof import("../../src/cli/auth.js")> {
  vi.resetModules();
  return await import("../../src/cli/auth.js");
}

beforeEach(() => {
  existsSyncMock.mockReset().mockReturnValue(false);
  loadCredentialsMock.mockReset().mockReturnValue(null);
  loginMock.mockReset().mockResolvedValue(undefined);
  listOrgsMock.mockReset().mockResolvedValue([]);
  stdoutWriteMock.mockReset();
  stderrWriteMock.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(((...a: unknown[]) => { stdoutWriteMock(...a); return true; }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((...a: unknown[]) => { stderrWriteMock(...a); return true; }) as any);
  delete process.env.HIVEMIND_API_URL;
  delete process.env.DEEPLAKE_API_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isLoggedIn", () => {
  it("false when credentials file is absent", async () => {
    existsSyncMock.mockReturnValue(false);
    const { isLoggedIn } = await importFresh();
    expect(isLoggedIn()).toBe(false);
    // We never bother calling loadCredentials when the file isn't even there.
    expect(loadCredentialsMock).not.toHaveBeenCalled();
  });

  it("false when file exists but credentials parse to null (corrupt JSON)", async () => {
    existsSyncMock.mockReturnValue(true);
    loadCredentialsMock.mockReturnValue(null);
    const { isLoggedIn } = await importFresh();
    expect(isLoggedIn()).toBe(false);
  });

  it("true when file exists AND credentials parse cleanly", async () => {
    existsSyncMock.mockReturnValue(true);
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o" });
    const { isLoggedIn } = await importFresh();
    expect(isLoggedIn()).toBe(true);
  });
});

describe("ensureLoggedIn", () => {
  it("returns true immediately when already logged in (no login() call)", async () => {
    existsSyncMock.mockReturnValue(true);
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o" });
    const { ensureLoggedIn } = await importFresh();
    expect(await ensureLoggedIn()).toBe(true);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("calls login() with the default api when no env override is set", async () => {
    // First isLoggedIn is false; after login(), isLoggedIn is true.
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o" });
    const { ensureLoggedIn } = await importFresh();
    expect(await ensureLoggedIn()).toBe(true);
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledWith("https://api.deeplake.ai");
  });

  it("HIVEMIND_API_URL takes precedence over DEEPLAKE_API_URL and the default", async () => {
    process.env.HIVEMIND_API_URL = "https://hm.example";
    process.env.DEEPLAKE_API_URL = "https://dl.example";
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o" });
    const { ensureLoggedIn } = await importFresh();
    await ensureLoggedIn();
    expect(loginMock).toHaveBeenCalledWith("https://hm.example");
  });

  it("DEEPLAKE_API_URL is used when only it is set", async () => {
    process.env.DEEPLAKE_API_URL = "https://dl.example";
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o" });
    const { ensureLoggedIn } = await importFresh();
    await ensureLoggedIn();
    expect(loginMock).toHaveBeenCalledWith("https://dl.example");
  });

  it("returns false (and writes to stderr) when login() rejects", async () => {
    existsSyncMock.mockReturnValue(false);
    loadCredentialsMock.mockReturnValue(null);
    loginMock.mockRejectedValue(new Error("network down"));
    const { ensureLoggedIn } = await importFresh();
    expect(await ensureLoggedIn()).toBe(false);
    const stderrText = stderrWriteMock.mock.calls.map(c => c[0]).join("");
    expect(stderrText).toContain("Login failed: network down");
  });

  it("returns false when login() resolves but credentials are still missing", async () => {
    // Edge case: login() succeeds but for some reason doesn't persist.
    existsSyncMock.mockReturnValue(false);
    loadCredentialsMock.mockReturnValue(null);
    const { ensureLoggedIn } = await importFresh();
    expect(await ensureLoggedIn()).toBe(false);
  });

  it("emits the 'Starting login...' notice on cold start", async () => {
    existsSyncMock.mockReturnValue(false);
    loadCredentialsMock.mockReturnValue(null);
    const { ensureLoggedIn } = await importFresh();
    await ensureLoggedIn();
    const stdoutText = stdoutWriteMock.mock.calls.map(c => c[0]).join("");
    expect(stdoutText).toContain("No Deeplake credentials found. Starting login...");
  });
});

describe("maybeShowOrgChoice", () => {
  it("no-op when not logged in (loadCredentials null)", async () => {
    loadCredentialsMock.mockReturnValue(null);
    const { maybeShowOrgChoice } = await importFresh();
    await maybeShowOrgChoice();
    expect(listOrgsMock).not.toHaveBeenCalled();
    expect(stdoutWriteMock).not.toHaveBeenCalled();
  });

  it("no-op when user belongs to a single org (no choice to show)", async () => {
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o", orgName: "acme" });
    listOrgsMock.mockResolvedValue([{ id: "o", name: "acme" }]);
    const { maybeShowOrgChoice } = await importFresh();
    await maybeShowOrgChoice();
    expect(stdoutWriteMock).not.toHaveBeenCalled();
  });

  it("prints the active-org line and the switch hint when 2+ orgs are visible", async () => {
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o1", orgName: "acme" });
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "acme" }, { id: "o2", name: "wayne" }]);
    const { maybeShowOrgChoice } = await importFresh();
    await maybeShowOrgChoice();
    const text = stdoutWriteMock.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("You belong to 2 orgs. Active: acme");
    expect(text).toContain("hivemind org switch <name-or-id>");
  });

  it("falls back to orgId when orgName is missing in credentials", async () => {
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o1" });
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "acme" }, { id: "o2", name: "wayne" }]);
    const { maybeShowOrgChoice } = await importFresh();
    await maybeShowOrgChoice();
    const text = stdoutWriteMock.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("Active: o1");
  });

  it("calls listOrgs with the credentials' apiUrl when present", async () => {
    loadCredentialsMock.mockReturnValue({ token: "tok", orgId: "o1", apiUrl: "https://custom.example" });
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "a" }, { id: "o2", name: "b" }]);
    const { maybeShowOrgChoice } = await importFresh();
    await maybeShowOrgChoice();
    expect(listOrgsMock).toHaveBeenCalledWith("tok", "https://custom.example");
  });

  it("falls back to the default apiUrl when none is in credentials", async () => {
    loadCredentialsMock.mockReturnValue({ token: "tok", orgId: "o1" });
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "a" }, { id: "o2", name: "b" }]);
    const { maybeShowOrgChoice } = await importFresh();
    await maybeShowOrgChoice();
    expect(listOrgsMock).toHaveBeenCalledWith("tok", "https://api.deeplake.ai");
  });

  it("swallows network errors silently (best-effort post-install hint)", async () => {
    loadCredentialsMock.mockReturnValue({ token: "tok", orgId: "o1" });
    listOrgsMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const { maybeShowOrgChoice } = await importFresh();
    await expect(maybeShowOrgChoice()).resolves.toBeUndefined();
    expect(stdoutWriteMock).not.toHaveBeenCalled();
    expect(stderrWriteMock).not.toHaveBeenCalled();
  });
});
