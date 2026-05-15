import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/commands/auth-login.ts — the runAuthCommand dispatcher.
 *
 * The dispatcher is a switch over args[0]; we mock the auth + session-prune
 * modules at the boundary (CLAUDE.md rule 5) and exercise every case path.
 * Each case is asserted on COUNT and SHAPE (rule 6) so a regression that
 * misroutes a subcommand cannot slip through.
 */

const loadCredentialsMock = vi.fn();
const loginMock = vi.fn();
const saveCredentialsMock = vi.fn();
const deleteCredentialsMock = vi.fn();
const listOrgsMock = vi.fn();
const switchOrgMock = vi.fn();
const listWorkspacesMock = vi.fn();
const switchWorkspaceMock = vi.fn();
const inviteMemberMock = vi.fn();
const listMembersMock = vi.fn();
const removeMemberMock = vi.fn();
const sessionPruneMock = vi.fn();
const consoleLogMock = vi.fn();
const exitSpy = vi.fn();

vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: unknown[]) => loadCredentialsMock(...a),
  login: (...a: unknown[]) => loginMock(...a),
  saveCredentials: (...a: unknown[]) => saveCredentialsMock(...a),
  deleteCredentials: (...a: unknown[]) => deleteCredentialsMock(...a),
  listOrgs: (...a: unknown[]) => listOrgsMock(...a),
  switchOrg: (...a: unknown[]) => switchOrgMock(...a),
  listWorkspaces: (...a: unknown[]) => listWorkspacesMock(...a),
  switchWorkspace: (...a: unknown[]) => switchWorkspaceMock(...a),
  inviteMember: (...a: unknown[]) => inviteMemberMock(...a),
  listMembers: (...a: unknown[]) => listMembersMock(...a),
  removeMember: (...a: unknown[]) => removeMemberMock(...a),
}));
vi.mock("../../src/commands/session-prune.js", () => ({
  sessionPrune: (...a: unknown[]) => sessionPruneMock(...a),
}));

const validCreds = {
  token: "tok",
  orgId: "org-1",
  orgName: "acme",
  workspaceId: "default",
  apiUrl: "https://api.example",
  autoupdate: true,
  savedAt: "2024-01-01",
};

beforeEach(() => {
  loadCredentialsMock.mockReset().mockReturnValue(validCreds);
  loginMock.mockReset().mockResolvedValue(undefined);
  saveCredentialsMock.mockReset();
  deleteCredentialsMock.mockReset().mockReturnValue(true);
  listOrgsMock.mockReset().mockResolvedValue([]);
  switchOrgMock.mockReset().mockResolvedValue(undefined);
  listWorkspacesMock.mockReset().mockResolvedValue([]);
  switchWorkspaceMock.mockReset().mockResolvedValue(undefined);
  inviteMemberMock.mockReset().mockResolvedValue(undefined);
  listMembersMock.mockReset().mockResolvedValue([]);
  removeMemberMock.mockReset().mockResolvedValue(undefined);
  sessionPruneMock.mockReset().mockResolvedValue(undefined);
  consoleLogMock.mockReset();
  exitSpy.mockReset();
  vi.spyOn(console, "log").mockImplementation(((...a: unknown[]) => { consoleLogMock(...a); }) as any);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitSpy(code);
    throw Object.assign(new Error("__exit__"), { __exit: true });
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function run(args: string[]): Promise<void> {
  vi.resetModules();
  const mod = await import("../../src/commands/auth-login.js");
  try {
    await mod.runAuthCommand(args);
  } catch (e: unknown) {
    if (!(e && typeof e === "object" && "__exit" in (e as Record<string, unknown>))) throw e;
  }
}

const consoleText = () => consoleLogMock.mock.calls.map(c => c.map(String).join(" ")).join("\n");

describe("runAuthCommand — login", () => {
  it("calls login() with the apiUrl from credentials when present", async () => {
    await run(["login"]);
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledWith("https://api.example");
  });

  it("falls back to the default apiUrl when credentials are absent", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await run(["login"]);
    expect(loginMock).toHaveBeenCalledWith("https://api.deeplake.ai");
  });
});

describe("runAuthCommand — whoami", () => {
  it("prints user/workspace/api lines when logged in", async () => {
    await run(["whoami"]);
    const text = consoleText();
    expect(text).toContain("User org: acme");
    expect(text).toContain("Workspace: default");
    expect(text).toContain("API: https://api.example");
  });

  it("falls back to orgId when orgName is missing", async () => {
    loadCredentialsMock.mockReturnValue({ ...validCreds, orgName: undefined });
    await run(["whoami"]);
    expect(consoleText()).toContain("User org: org-1");
  });

  it("uses orgName as the dispatch default when no command argument is passed", async () => {
    // runAuthCommand defaults the command to "whoami" when args[0] is undefined.
    await run([]);
    expect(consoleText()).toContain("User org: acme");
  });

  it("prints 'Not logged in' guidance when credentials are missing", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await run(["whoami"]);
    expect(consoleText()).toContain("Not logged in");
  });
});

describe("runAuthCommand — org list / switch", () => {
  it("'org list' prints '<id>  <name>' for each org", async () => {
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "acme" }, { id: "o2", name: "wayne" }]);
    await run(["org", "list"]);
    expect(listOrgsMock).toHaveBeenCalledWith("tok", "https://api.example");
    expect(consoleText()).toContain("o1  acme");
    expect(consoleText()).toContain("o2  wayne");
  });

  it("'org switch' calls switchOrg and confirms with the matched org name", async () => {
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "acme" }, { id: "o2", name: "wayne" }]);
    // 'default' exists in the new org, so no workspace reset is expected.
    listWorkspacesMock.mockResolvedValue([{ id: "default", name: "default" }]);
    await run(["org", "switch", "wayne"]);
    expect(switchOrgMock).toHaveBeenCalledWith("o2", "wayne");
    expect(consoleText()).toContain("Switched to org: wayne");
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
  });

  it("'org switch' is case-insensitive on the name lookup", async () => {
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "Acme" }]);
    listWorkspacesMock.mockResolvedValue([{ id: "default", name: "default" }]);
    await run(["org", "switch", "ACME"]);
    expect(switchOrgMock).toHaveBeenCalledWith("o1", "Acme");
  });

  it("'org switch' on unknown org exits 1", async () => {
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "acme" }]);
    await run(["org", "switch", "ghost"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(switchOrgMock).not.toHaveBeenCalled();
  });

  it("'org switch' resets workspace to 'default' when the carried-over workspace doesn't exist in the new org", async () => {
    // Previous workspace was "k7" (from a different org). New org only has "default".
    loadCredentialsMock.mockReturnValue({ ...validCreds, workspaceId: "k7" });
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockResolvedValue([{ id: "default", name: "default" }]);
    await run(["org", "switch", "wayne"]);
    expect(switchOrgMock).toHaveBeenCalledWith("o2", "wayne");
    expect(switchWorkspaceMock).toHaveBeenCalledWith("default");
    expect(switchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(consoleText()).toContain("not in org 'wayne'");
    expect(consoleText()).toContain("Reset workspace to 'default'");
    // listWorkspaces must be called with the NEW org id, not the stale one from creds.
    expect(listWorkspacesMock).toHaveBeenCalledWith("tok", "https://api.example", "o2");
  });

  it("'org switch' normalizes a name-only carry-over to the canonical workspace id (so subsequent commands target a stable id, not a renameable name)", async () => {
    // Stored workspaceId is "shared" — that's a NAME in the new org, not an id.
    // The fix must persist the canonical id "ws-shared" so a future rename of
    // the workspace doesn't silently invalidate this user's credentials.
    loadCredentialsMock.mockReturnValue({ ...validCreds, workspaceId: "shared" });
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockResolvedValue([{ id: "ws-shared", name: "shared" }]);
    await run(["org", "switch", "wayne"]);
    expect(switchWorkspaceMock).toHaveBeenCalledWith("ws-shared");
    expect(switchWorkspaceMock).toHaveBeenCalledTimes(1);
    const text = consoleText();
    expect(text).toContain("resolved to id 'ws-shared'");
    // Must NOT print the reset-to-default warning — this is a normalization,
    // not a reset to the sentinel.
    expect(text).not.toContain("Reset workspace");
  });

  it("'org switch' leaves credentials untouched when the carried-over id already matches a workspace by id (no normalization needed)", async () => {
    loadCredentialsMock.mockReturnValue({ ...validCreds, workspaceId: "ws-shared" });
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockResolvedValue([{ id: "ws-shared", name: "shared" }]);
    await run(["org", "switch", "wayne"]);
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    const text = consoleText();
    expect(text).not.toContain("Reset workspace");
    expect(text).not.toContain("resolved to id");
  });

  it("'org switch' aborts atomically when listWorkspaces fails — switchOrg is never called and credentials remain on the old org", async () => {
    // Atomicity: the workspace fetch happens BEFORE switchOrg so a network
    // failure can't leave credentials half-committed (org switched but
    // workspace not validated). Re-running the command then succeeds cleanly.
    loadCredentialsMock.mockReturnValue({ ...validCreds, workspaceId: "k7" });
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockRejectedValue(new Error("network down"));
    await expect(run(["org", "switch", "wayne"])).rejects.toThrow("network down");
    expect(switchOrgMock).not.toHaveBeenCalled();
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
  });

  it("'org switch' does not log a reset warning when the carry-over is already the 'default' sentinel and the new org has no 'default' workspace", async () => {
    // Avoid a misleading "Workspace 'default' is not in org … Reset workspace
    // to 'default'." message — there's nothing to reset.
    loadCredentialsMock.mockReturnValue({ ...validCreds, workspaceId: "default" });
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockResolvedValue([{ id: "ws-1", name: "alpha" }]);
    await run(["org", "switch", "wayne"]);
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(consoleText()).not.toContain("Reset workspace");
  });

  it("'org switch' falls back to the 'default' sentinel when credentials have no workspaceId field at all", async () => {
    // Coverage: the `?? "default"` branch (workspaceId field missing entirely
    // — possible on legacy or partially-initialized creds).
    const credsNoWs = { ...validCreds } as Record<string, unknown>;
    delete credsNoWs.workspaceId;
    loadCredentialsMock.mockReturnValue(credsNoWs);
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockResolvedValue([{ id: "ws-1", name: "alpha" }]);
    await run(["org", "switch", "wayne"]);
    // No reset warning (sentinel + no match → silent), no normalization log.
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    const text = consoleText();
    expect(text).not.toContain("Reset workspace");
    expect(text).not.toContain("resolved to id");
  });

  it("'org switch' resets but suppresses the 'Available workspaces' line when the new org has zero workspaces", async () => {
    // Coverage: the `wsList.length > 0` else branch.
    loadCredentialsMock.mockReturnValue({ ...validCreds, workspaceId: "k7" });
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockResolvedValue([]);
    await run(["org", "switch", "wayne"]);
    expect(switchWorkspaceMock).toHaveBeenCalledWith("default");
    const text = consoleText();
    expect(text).toContain("Reset workspace to 'default'");
    expect(text).not.toContain("Available workspaces:");
  });

  it("'org switch' does not crash when a workspace in the list has no `name` field (matches purely by id)", async () => {
    // Defensive: API responses may omit `name` for system/internal workspaces.
    // The find predicate must guard against `w.name.toLowerCase()` blowing up.
    loadCredentialsMock.mockReturnValue({ ...validCreds, workspaceId: "ws-named-only" });
    listOrgsMock.mockResolvedValue([{ id: "o2", name: "wayne" }]);
    listWorkspacesMock.mockResolvedValue([
      { id: "ws-no-name", name: undefined as unknown as string },
      { id: "ws-named-only", name: "named" },
    ]);
    await run(["org", "switch", "wayne"]);
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(consoleText()).not.toContain("Reset workspace");
  });

  it("'org switch' without a target exits 1 with usage", async () => {
    await run(["org", "switch"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleText()).toContain("Usage: org switch");
  });

  it("unknown 'org' subcommand prints usage", async () => {
    await run(["org", "bogus"]);
    expect(consoleText()).toContain("Usage: org list | org switch");
  });

  it("'org list' without credentials exits 1", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await run(["org", "list"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runAuthCommand — workspaces / workspace", () => {
  it("'workspaces' lists each workspace's display name (one per line)", async () => {
    listWorkspacesMock.mockResolvedValue([{ id: "ws1", name: "default" }, { id: "ws2", name: "alt" }]);
    await run(["workspaces"]);
    expect(listWorkspacesMock).toHaveBeenCalledWith("tok", "https://api.example", "org-1");
    const lines = consoleText().split("\n").filter(l => l.length > 0);
    expect(lines).toEqual(["default", "alt"]);
  });

  it("'workspaces' falls back to the id when a workspace has no display name", async () => {
    // Defensive: API responses occasionally omit `name` for system/internal
    // workspaces; the listing must still be readable instead of printing
    // "undefined".
    listWorkspacesMock.mockResolvedValue([{ id: "ws-no-name", name: undefined as unknown as string }]);
    await run(["workspaces"]);
    expect(consoleText()).toContain("ws-no-name");
    expect(consoleText()).not.toContain("undefined");
  });

  it("'workspace' without a subcommand exits 1 with usage listing only `list` and `switch`", async () => {
    await run(["workspace"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = consoleText();
    expect(text).toContain("workspace list");
    expect(text).toContain("workspace switch <name-or-id>");
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(listWorkspacesMock).not.toHaveBeenCalled();
  });

  it("an unknown subcommand (no longer a bare-target shortcut) exits 1 and never touches the API", async () => {
    // Regression guard: previously `workspace ws-7` was a shortcut for switching.
    // It must now be rejected — only `list` and `switch <target>` are valid.
    await run(["workspace", "ws-7"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleText()).toContain("Usage: workspace list | workspace switch <name-or-id>");
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(listWorkspacesMock).not.toHaveBeenCalled();
  });

  it("'workspace list' prints each workspace's display name (one per line), matching the plural `workspaces` command", async () => {
    listWorkspacesMock.mockResolvedValue([{ id: "ws1", name: "default" }, { id: "ws2", name: "alt" }]);
    await run(["workspace", "list"]);
    expect(listWorkspacesMock).toHaveBeenCalledWith("tok", "https://api.example", "org-1");
    const lines = consoleText().split("\n").filter(l => l.length > 0);
    expect(lines).toEqual(["default", "alt"]);
    // Critical: must NOT call switchWorkspace — `list` is read-only.
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
  });

  it("'workspace switch <id>' validates against listWorkspaces and switches to the matched id", async () => {
    listWorkspacesMock.mockResolvedValue([{ id: "ws-7", name: "seven" }, { id: "ws-8", name: "eight" }]);
    await run(["workspace", "switch", "ws-7"]);
    expect(listWorkspacesMock).toHaveBeenCalledWith("tok", "https://api.example", "org-1");
    expect(switchWorkspaceMock).toHaveBeenCalledWith("ws-7");
    expect(switchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(consoleText()).toContain("Switched to workspace: seven");
  });

  it("'workspace switch <name>' resolves names case-insensitively", async () => {
    listWorkspacesMock.mockResolvedValue([{ id: "ws-7", name: "Seven" }]);
    await run(["workspace", "switch", "SEVEN"]);
    expect(switchWorkspaceMock).toHaveBeenCalledWith("ws-7");
  });

  it("'workspace switch <unknown>' exits 1 with the available list and never calls switchWorkspace", async () => {
    listWorkspacesMock.mockResolvedValue([{ id: "ws-7", name: "seven" }]);
    await run(["workspace", "switch", "k7"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(consoleText()).toContain("Workspace not found: k7");
    expect(consoleText()).toContain("Available workspaces: seven");
  });

  it("'workspace switch <unknown>' suppresses the 'Available workspaces' line when the org has zero workspaces", async () => {
    // Coverage for the `wsList.length > 0` else branch in the workspace switch
    // handler (mirrors the same branch in `org switch`).
    listWorkspacesMock.mockResolvedValue([]);
    await run(["workspace", "switch", "k7"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = consoleText();
    expect(text).toContain("Workspace not found: k7");
    expect(text).not.toContain("Available workspaces:");
  });

  it("'workspace switch' does not crash when a workspace in the list has no `name` field", async () => {
    // Defensive: same name-undefined guard as in the `org switch` carry-over
    // resolver. The find predicate must not invoke `w.name.toLowerCase()` on
    // an undefined name.
    listWorkspacesMock.mockResolvedValue([
      { id: "ws-no-name", name: undefined as unknown as string },
      { id: "ws-7", name: "seven" },
    ]);
    await run(["workspace", "switch", "ws-no-name"]);
    expect(switchWorkspaceMock).toHaveBeenCalledWith("ws-no-name");
  });

  it("'workspace switch' without a target exits 1 with subcommand-specific usage", async () => {
    await run(["workspace", "switch"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleText()).toContain("Usage: workspace switch <name-or-id>");
    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    // Must not even hit the API when the user supplied no target.
    expect(listWorkspacesMock).not.toHaveBeenCalled();
  });

  it("'workspaces' without credentials exits 1", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await run(["workspaces"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runAuthCommand — invite", () => {
  it("invites with WRITE as the default mode when no mode is given", async () => {
    await run(["invite", "alice@example.com"]);
    expect(inviteMemberMock).toHaveBeenCalledWith("alice@example.com", "WRITE", "tok", "org-1", "https://api.example");
    expect(consoleText()).toContain("Invited alice@example.com with WRITE access");
  });

  it("normalises the mode argument to upper-case", async () => {
    await run(["invite", "bob@x", "admin"]);
    expect(inviteMemberMock).toHaveBeenCalledWith("bob@x", "ADMIN", "tok", "org-1", "https://api.example");
  });

  it("missing email exits 1 with usage", async () => {
    await run(["invite"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleText()).toContain("Usage: invite <email>");
  });
});

describe("runAuthCommand — members / remove", () => {
  it("'members' prints '<role.padEnd(8)> <email>' per member", async () => {
    listMembersMock.mockResolvedValue([
      { role: "ADMIN", email: "a@x" },
      { role: "WRITE", email: "b@x" },
      { role: "READ",  name: "no-email-user" }, // name fallback when email absent
    ]);
    await run(["members"]);
    const text = consoleText();
    expect(text).toContain("ADMIN");
    expect(text).toContain("a@x");
    expect(text).toContain("b@x");
    expect(text).toContain("no-email-user");
  });

  it("'remove <user-id>' calls removeMember and confirms", async () => {
    await run(["remove", "user-42"]);
    expect(removeMemberMock).toHaveBeenCalledWith("user-42", "tok", "org-1", "https://api.example");
    expect(consoleText()).toContain("Removed user user-42");
  });

  it("'remove' without a user-id exits 1 with usage", async () => {
    await run(["remove"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleText()).toContain("Usage: remove <user-id>");
  });
});

describe("runAuthCommand — sessions prune", () => {
  it("'sessions prune' delegates remaining args to sessionPrune", async () => {
    await run(["sessions", "prune", "--before", "2026-01-01", "--yes"]);
    expect(sessionPruneMock).toHaveBeenCalledWith(["--before", "2026-01-01", "--yes"]);
  });

  it("unknown 'sessions' subcommand prints usage instead of crashing", async () => {
    await run(["sessions", "bogus"]);
    expect(sessionPruneMock).not.toHaveBeenCalled();
    expect(consoleText()).toContain("Usage: sessions prune");
  });
});

describe("runAuthCommand — autoupdate", () => {
  it("'autoupdate on' calls saveCredentials with autoupdate:true", async () => {
    await run(["autoupdate", "on"]);
    expect(saveCredentialsMock).toHaveBeenCalledTimes(1);
    expect(saveCredentialsMock.mock.calls[0][0]).toMatchObject({ ...validCreds, autoupdate: true });
    expect(consoleText()).toContain("Autoupdate enabled");
  });

  it("'autoupdate off' calls saveCredentials with autoupdate:false", async () => {
    await run(["autoupdate", "off"]);
    expect(saveCredentialsMock.mock.calls[0][0]).toMatchObject({ autoupdate: false });
    expect(consoleText()).toContain("Autoupdate disabled");
  });

  it("'autoupdate true/false' aliases work too", async () => {
    await run(["autoupdate", "true"]);
    expect(saveCredentialsMock.mock.calls[0][0]).toMatchObject({ autoupdate: true });
    saveCredentialsMock.mockClear();
    await run(["autoupdate", "false"]);
    expect(saveCredentialsMock.mock.calls[0][0]).toMatchObject({ autoupdate: false });
  });

  it("'autoupdate' (no arg) prints the current value with 'on' default for missing field", async () => {
    loadCredentialsMock.mockReturnValue({ ...validCreds, autoupdate: undefined });
    await run(["autoupdate"]);
    expect(consoleText()).toContain("Autoupdate is currently: on");
  });

  it("'autoupdate' (no arg) prints 'off' when the stored value is explicitly false", async () => {
    loadCredentialsMock.mockReturnValue({ ...validCreds, autoupdate: false });
    await run(["autoupdate"]);
    expect(consoleText()).toContain("Autoupdate is currently: off");
  });

  it("'autoupdate' without credentials exits 1", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await run(["autoupdate"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runAuthCommand — logout", () => {
  it("calls deleteCredentials and confirms when credentials existed", async () => {
    deleteCredentialsMock.mockReturnValue(true);
    await run(["logout"]);
    expect(deleteCredentialsMock).toHaveBeenCalledTimes(1);
    expect(consoleText()).toContain("Logged out");
  });

  it("prints 'Not logged in' when there were no credentials to delete", async () => {
    deleteCredentialsMock.mockReturnValue(false);
    await run(["logout"]);
    expect(consoleText()).toContain("Not logged in");
  });
});

describe("runAuthCommand — unknown command", () => {
  it("prints the Commands index for an unrecognised verb", async () => {
    await run(["bogus"]);
    expect(consoleText()).toContain("Commands:");
    expect(consoleText()).toContain("login");
    expect(consoleText()).toContain("autoupdate");
  });
});
