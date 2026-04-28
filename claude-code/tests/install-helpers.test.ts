import { describe, it, expect } from "vitest";
import { isHivemindHookEntry, mergeHooks } from "../../src/cli/install-codex.js";
import { upsertHivemindBlock, stripHivemindBlock } from "../../src/cli/install-pi.js";
import { isHivemindEntry, stripHooksFromConfig } from "../../src/cli/install-cursor.js";

/**
 * Unit tests for the pure helpers behind `hivemind <agent> install/uninstall`.
 *
 * Why these specifically (per CLAUDE.md testing philosophy):
 *   - mergeHooks: was a data-loss bug in 0.6.47 (writeJson clobbered user hooks).
 *     Tests here include the "failure case before the fix" — a fixture that
 *     would have lost a user-defined hook under the old blind-overwrite.
 *   - isHivemindHookEntry / isHivemindEntry: drives merge/strip; needs to be
 *     conservative on malformed input (no false positives).
 *   - upsertHivemindBlock / stripHivemindBlock: marker-block round-trip on
 *     ~/.pi/agent/AGENTS.md. Idempotent re-install is part of the contract.
 *   - stripHooksFromConfig: cursor uninstall edge cases (empty-object,
 *     version-only) caught in PR #75 review.
 *
 * All tests assert SHAPE AND COUNT (CLAUDE.md rule 6) so a bug that
 * accidentally adds an extra entry can't slip past a "merged something" check.
 */

// ─── codex: isHivemindHookEntry ───────────────────────────────────────────

describe("isHivemindHookEntry", () => {
  const PD = "/home/test/.codex/hivemind";

  it("true when entry has a hook command pointing into <pluginDir>/bundle/", () => {
    expect(isHivemindHookEntry({
      hooks: [{ type: "command", command: `node "${PD}/bundle/session-start.js"`, timeout: 120 }],
    }, PD)).toBe(true);
  });

  it("false when command points OUTSIDE pluginDir (e.g. user's own hook)", () => {
    expect(isHivemindHookEntry({
      hooks: [{ type: "command", command: "node /home/test/.codex/my-custom-hook.js" }],
    }, PD)).toBe(false);
  });

  it("false when command points to a sibling plugin dir (not ours)", () => {
    expect(isHivemindHookEntry({
      hooks: [{ type: "command", command: "node /home/test/.codex/other-plugin/bundle/x.js" }],
    }, PD)).toBe(false);
  });

  // CLAUDE.md rule 8: assert the bad-input case explicitly so a refactor
  // that drops the type guards can't silently start matching garbage.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "hello"],
    ["empty object", {}],
    ["hooks not an array", { hooks: "nope" }],
    ["hook missing command", { hooks: [{ type: "command", timeout: 10 }] }],
    ["hook with non-string command", { hooks: [{ command: 123 }] }],
  ])("false on malformed input: %s", (_label, entry) => {
    expect(isHivemindHookEntry(entry, PD)).toBe(false);
  });

  it("true if any one hook in the entry's hooks[] matches (mixed entry)", () => {
    expect(isHivemindHookEntry({
      hooks: [
        { type: "command", command: "node /not-ours.js" },
        { type: "command", command: `node "${PD}/bundle/capture.js"` },
      ],
    }, PD)).toBe(true);
  });
});

// ─── codex: mergeHooks (the data-loss-fix surface) ────────────────────────

describe("mergeHooks", () => {
  const PD = "/home/test/.codex/hivemind";
  const ours = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `node "${PD}/bundle/session-start.js"`, timeout: 120 }] }],
      PostToolUse:  [{ hooks: [{ type: "command", command: `node "${PD}/bundle/capture.js"`,        timeout: 15  }] }],
    },
  };

  it("when no prior config: result equals ours, exact event count, exact entries", () => {
    const merged = mergeHooks({}, ours, PD);
    expect(Object.keys((merged as { hooks: object }).hooks)).toEqual(["SessionStart", "PostToolUse"]);
    expect((merged as { hooks: { SessionStart: unknown[] } }).hooks.SessionStart).toHaveLength(1);
    expect((merged as { hooks: { PostToolUse:  unknown[] } }).hooks.PostToolUse).toHaveLength(1);
  });

  // CLAUDE.md rule 12: "Write the failure case before the fix." This is
  // exactly the fixture that would have failed under the pre-fix
  // writeJson(HOOKS_PATH, buildHooksJson()) — the user's custom Notification
  // hook would have been silently wiped.
  it("preserves user-defined hooks for events hivemind does NOT claim", () => {
    const userHook = { hooks: [{ type: "command", command: "/usr/local/bin/my-notify.sh", timeout: 5 }] };
    const existing = { hooks: { Notification: [userHook] } };

    const merged = mergeHooks(existing, ours, PD);
    const h = (merged as { hooks: Record<string, unknown[]> }).hooks;

    // Exact event set: ours + the user's surviving event.
    expect(Object.keys(h).sort()).toEqual(["Notification", "PostToolUse", "SessionStart"]);
    // User's Notification hook is still there, exactly once, byte-equal.
    expect(h.Notification).toHaveLength(1);
    expect(h.Notification[0]).toEqual(userHook);
  });

  it("preserves user hooks for events hivemind ALSO claims (both kept side-by-side)", () => {
    const userHook = { hooks: [{ type: "command", command: "/usr/local/bin/my-pre-toolcall.sh", timeout: 3 }] };
    const existing = { hooks: { PostToolUse: [userHook] } };

    const merged = mergeHooks(existing, ours, PD);
    const h = (merged as { hooks: Record<string, unknown[]> }).hooks;

    // Exactly TWO entries on PostToolUse: user's first, then ours.
    expect(h.PostToolUse).toHaveLength(2);
    expect(h.PostToolUse[0]).toEqual(userHook);
    expect((h.PostToolUse[1] as { hooks: [{ command: string }] }).hooks[0].command)
      .toBe(`node "${PD}/bundle/capture.js"`);
  });

  // CLAUDE.md rule 8: the bad pattern this code class previously had
  // (duplicate hivemind entries on every re-install) must be asserted
  // NOT to occur, not just "merge worked."
  it("strips prior hivemind entries on re-install — no duplication after N re-runs", () => {
    let cur: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) cur = mergeHooks(cur, ours, PD);

    const h = (cur as { hooks: Record<string, unknown[]> }).hooks;
    expect(h.SessionStart).toHaveLength(1);
    expect(h.PostToolUse).toHaveLength(1);
    // Negative pattern: NO entry has a duplicate hivemind command.
    const allCommands = Object.values(h).flatMap(entries =>
      entries.flatMap((e: unknown) => (e as { hooks: { command: string }[] }).hooks.map(c => c.command)),
    );
    const hivemindCommands = allCommands.filter(c => c.includes(`${PD}/bundle/`));
    const unique = new Set(hivemindCommands);
    expect(hivemindCommands.length).toBe(unique.size);
  });

  it("re-install with mixed prior (user + stale hivemind) keeps user, replaces stale", () => {
    const userHook = { hooks: [{ type: "command", command: "/usr/local/bin/audit.sh", timeout: 5 }] };
    const staleHivemind = { hooks: [{ type: "command", command: `node "${PD}/bundle/old-capture.js"`, timeout: 15 }] };
    const existing = { hooks: { PostToolUse: [userHook, staleHivemind] } };

    const merged = mergeHooks(existing, ours, PD);
    const h = (merged as { hooks: Record<string, unknown[]> }).hooks;

    // Exactly two entries: user's audit + our fresh capture. Stale is GONE.
    expect(h.PostToolUse).toHaveLength(2);
    expect(h.PostToolUse[0]).toEqual(userHook);
    const ourCmd = (h.PostToolUse[1] as { hooks: [{ command: string }] }).hooks[0].command;
    expect(ourCmd).toBe(`node "${PD}/bundle/capture.js"`);
    expect(ourCmd).not.toContain("old-capture.js");
  });

  it("drops events whose surviving (non-hivemind) entries are empty", () => {
    const onlyHivemind = { hooks: [{ type: "command", command: `node "${PD}/bundle/old.js"` }] };
    const existing = { hooks: { OldEvent: [onlyHivemind] } };

    const merged = mergeHooks(existing, ours, PD);
    const h = (merged as { hooks: Record<string, unknown[]> }).hooks;
    expect(h.OldEvent).toBeUndefined();
  });

  it("preserves non-hooks top-level fields (so user metadata survives)", () => {
    const existing = { hooks: {}, version: 2, customField: "user-data" };
    const merged = mergeHooks(existing, ours, PD) as Record<string, unknown>;
    expect(merged.version).toBe(2);
    expect(merged.customField).toBe("user-data");
  });

  it("treats existing.hooks of wrong shape as empty (no crash, ours land cleanly)", () => {
    const merged = mergeHooks({ hooks: "this is not an object" }, ours, PD) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(merged.hooks)).toEqual(["SessionStart", "PostToolUse"]);
  });
});

// ─── pi: upsertHivemindBlock / stripHivemindBlock ─────────────────────────

const BEGIN = "<!-- BEGIN hivemind-memory -->";
const END   = "<!-- END hivemind-memory -->";

describe("upsertHivemindBlock", () => {
  it("on empty AGENTS.md: writes the marker block followed by trailing newline", () => {
    const out = upsertHivemindBlock(null);
    expect(out).toContain(BEGIN);
    expect(out).toContain(END);
    expect(out.endsWith("\n")).toBe(true);
    // Marker count: exactly one of each (CLAUDE.md rule 6).
    expect((out.match(new RegExp(BEGIN, "g")) ?? []).length).toBe(1);
    expect((out.match(new RegExp(END,   "g")) ?? []).length).toBe(1);
  });

  it("appends to existing content with a blank-line separator (no marker yet)", () => {
    const prior = "# My pi notes\nKeep these.";
    const out = upsertHivemindBlock(prior);
    expect(out.startsWith("# My pi notes\nKeep these.\n\n")).toBe(true);
    expect(out).toContain(BEGIN);
    // User content is preserved verbatim.
    expect(out).toContain("Keep these.");
  });

  it("idempotent: re-upsert produces exactly one marker pair, not two", () => {
    let cur: string | null = null;
    for (let i = 0; i < 4; i++) cur = upsertHivemindBlock(cur);
    const begins = (cur!.match(new RegExp(BEGIN, "g")) ?? []).length;
    const ends   = (cur!.match(new RegExp(END,   "g")) ?? []).length;
    expect(begins).toBe(1);
    expect(ends).toBe(1);
  });

  it("replaces in-place when marker already present (preserves before+after content)", () => {
    const prior = `# Header\n\n${BEGIN}\nold body\n${END}\n\n## After\nuser stuff`;
    const out = upsertHivemindBlock(prior);
    // Old body is gone; new block is in; user's before/after kept.
    expect(out).not.toContain("old body");
    expect(out).toContain("# Header");
    expect(out).toContain("## After");
    expect(out).toContain("user stuff");
    expect((out.match(new RegExp(BEGIN, "g")) ?? []).length).toBe(1);
  });

  it("malformed prior block (BEGIN without END) → appends a fresh block", () => {
    const prior = `# Header\n${BEGIN}\nbroken — no end marker\n## After`;
    const out = upsertHivemindBlock(prior);
    // We do NOT silently strip the broken block (could discard user-touched
    // content); we append a fresh one and let the user clean up.
    expect(out).toContain("broken — no end marker");
    // And there's a complete marker pair somewhere.
    expect(out).toContain(END);
  });
});

describe("stripHivemindBlock", () => {
  it("no marker → input is returned unchanged", () => {
    const prior = "# Header\nNo hivemind here.\n";
    expect(stripHivemindBlock(prior)).toBe(prior);
  });

  it("marker-only file → empty string (caller's job to delete the file)", () => {
    const prior = `${BEGIN}\nbody\n${END}`;
    expect(stripHivemindBlock(prior)).toBe("");
  });

  it("marker between user content → both halves preserved with single blank line", () => {
    const prior = `# Before\nuser one\n\n${BEGIN}\nhivemind body\n${END}\n\n## After\nuser two\n`;
    const out = stripHivemindBlock(prior);
    expect(out).toContain("# Before");
    expect(out).toContain("user one");
    expect(out).toContain("## After");
    expect(out).toContain("user two");
    expect(out).not.toContain("hivemind body");
    expect(out).not.toContain(BEGIN);
    expect(out).not.toContain(END);
  });

  it("marker at file head (no 'before') → returns just the after content", () => {
    const prior = `${BEGIN}\nbody\n${END}\n\n## After only\n`;
    const out = stripHivemindBlock(prior);
    expect(out.startsWith("## After only")).toBe(true);
    expect(out).not.toContain(BEGIN);
  });

  it("malformed (BEGIN without END) → input returned unchanged (don't truncate user data)", () => {
    const prior = `# Header\n${BEGIN}\nbroken — no end marker\nuser stuff after\n`;
    expect(stripHivemindBlock(prior)).toBe(prior);
  });
});

// ─── cursor: isHivemindEntry / stripHooksFromConfig ───────────────────────

describe("isHivemindEntry (cursor)", () => {
  it("true when command points into ~/.cursor/hivemind/bundle/", () => {
    expect(isHivemindEntry({ command: "node /home/u/.cursor/hivemind/bundle/capture.js" })).toBe(true);
  });

  it("false when command points elsewhere", () => {
    expect(isHivemindEntry({ command: "/usr/local/bin/my-cursor-hook" })).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "x"],
    ["empty object", {}],
    ["non-string command", { command: 7 }],
  ])("false on malformed input: %s", (_l, e) => {
    expect(isHivemindEntry(e)).toBe(false);
  });
});

describe("stripHooksFromConfig (cursor)", () => {
  const us = { command: "node /home/u/.cursor/hivemind/bundle/capture.js" };

  it("returns null when input is null", () => {
    expect(stripHooksFromConfig(null)).toBeNull();
  });

  it("strips ONLY hivemind entries; user entries on shared events stay", () => {
    const userHook = { command: "/usr/local/bin/my-pre-tool.sh" };
    const cfg = { version: 1, hooks: { postToolUse: [userHook, us], beforeSubmitPrompt: [us] } };
    const stripped = stripHooksFromConfig(cfg) as { hooks: Record<string, unknown[]> };
    // postToolUse: user's hook survives, ours is gone, count is exact.
    expect(stripped.hooks.postToolUse).toHaveLength(1);
    expect(stripped.hooks.postToolUse[0]).toEqual(userHook);
    // beforeSubmitPrompt was hivemind-only → event removed entirely.
    expect(stripped.hooks.beforeSubmitPrompt).toBeUndefined();
  });

  it("when every event ends up empty: hooks key is dropped, version-only object remains", () => {
    const cfg = { version: 1, hooks: { postToolUse: [us], stop: [us] } };
    const stripped = stripHooksFromConfig(cfg) as Record<string, unknown>;
    expect(stripped.hooks).toBeUndefined();
    expect(stripped.version).toBe(1);
  });

  it("removes the HIVEMIND marker key while preserving other fields", () => {
    // Marker key from src/cli/install-cursor.ts:18 — installCursor writes
    // this so subsequent installs/uninstalls can identify a hivemind-managed
    // config. Uninstall MUST remove it so a re-install starts clean.
    const cfg: Record<string, unknown> = {
      version: 1,
      hooks: { postToolUse: [us] },
      _hivemindManaged: { version: "0.6.48" },
      myUserField: "keep me",
    };
    const stripped = stripHooksFromConfig(cfg) as Record<string, unknown>;
    expect(stripped._hivemindManaged).toBeUndefined();
    expect(stripped.myUserField).toBe("keep me");
  });

  it("idempotent: re-strip on already-stripped config makes no further change", () => {
    const cfg = { version: 1, hooks: { postToolUse: [us] } };
    const once  = JSON.stringify(stripHooksFromConfig(JSON.parse(JSON.stringify(cfg))));
    const twice = JSON.stringify(
      stripHooksFromConfig(JSON.parse(once)),
    );
    expect(twice).toBe(once);
  });
});
