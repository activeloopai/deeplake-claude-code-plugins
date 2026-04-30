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
    await run(["org", "switch", "wayne"]);
    expect(switchOrgMock).toHaveBeenCalledWith("o2", "wayne");
    expect(consoleText()).toContain("Switched to org: wayne");
  });

  it("'org switch' is case-insensitive on the name lookup", async () => {
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "Acme" }]);
    await run(["org", "switch", "ACME"]);
    expect(switchOrgMock).toHaveBeenCalledWith("o1", "Acme");
  });

  it("'org switch' on unknown org exits 1", async () => {
    listOrgsMock.mockResolvedValue([{ id: "o1", name: "acme" }]);
    await run(["org", "switch", "ghost"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(switchOrgMock).not.toHaveBeenCalled();
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
  it("'workspaces' lists each workspace from listWorkspaces", async () => {
    listWorkspacesMock.mockResolvedValue([{ id: "ws1", name: "default" }, { id: "ws2", name: "alt" }]);
    await run(["workspaces"]);
    expect(listWorkspacesMock).toHaveBeenCalledWith("tok", "https://api.example", "org-1");
    expect(consoleText()).toContain("ws1  default");
    expect(consoleText()).toContain("ws2  alt");
  });

  it("'workspace <id>' calls switchWorkspace and confirms", async () => {
    await run(["workspace", "ws-7"]);
    expect(switchWorkspaceMock).toHaveBeenCalledWith("ws-7");
    expect(consoleText()).toContain("Switched to workspace: ws-7");
  });

  it("'workspace' without an id exits 1 with usage", async () => {
    await run(["workspace"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleText()).toContain("Usage: workspace <id>");
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
