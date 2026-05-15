import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listAllExistingSkills,
  renderExistingSkillsBlock,
} from "../../src/skillify/existing-skills.js";

// existing-skills.ts uses `~/.claude/skills` as the global root via
// `homedir()`. We override $HOME per test so homedir() returns a tmpdir
// instead of the developer's real home — populating the "global" root
// without polluting the user's actual skill collection.
//
// Module-level spies on `os.homedir` don't work here because the
// dependency chain (existing-skills → skill-writer) binds the import at
// load time. Env-var override is the only reliable hook.
let projectCwd: string;
let fakeHome: string;
let originalHome: string | undefined;

const VALID_FRONTMATTER = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: "d"\nsource_sessions: []\nversion: 1\ncreated_by_agent: x\ncreated_at: 2026\nupdated_at: 2026\n---\n\n${body}\n`;

function writeSkill(root: string, name: string, body = "stub body"): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), VALID_FRONTMATTER(name, body));
}

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), "skilify-existing-project-"));
  fakeHome = mkdtempSync(join(tmpdir(), "skilify-existing-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { rmSync(projectCwd, { recursive: true, force: true }); } catch { /* nothing */ }
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* nothing */ }
});

const projectRoot = () => join(projectCwd, ".claude", "skills");
const globalRoot = () => join(fakeHome, ".claude", "skills");

describe("listAllExistingSkills", () => {
  it("returns an empty list when neither root has any skills", () => {
    expect(listAllExistingSkills(projectCwd)).toEqual([]);
  });

  it("reads from both project and global roots, tagging the source", () => {
    writeSkill(projectRoot(), "deploy", "project body");
    writeSkill(globalRoot(), "hivemind-plugin-testing--alice", "global body");
    const skills = listAllExistingSkills(projectCwd);
    // Project is enumerated first, then global.
    expect(skills).toEqual([
      { name: "deploy", body: expect.stringContaining("project body"), source: "project" },
      { name: "hivemind-plugin-testing--alice", body: expect.stringContaining("global body"), source: "global" },
    ]);
  });

  it("dedupes by name with project winning over global", () => {
    // Same skill name in both roots — the user has been editing locally.
    // The gate should see the project copy (newer) and ignore the global one.
    writeSkill(projectRoot(), "deploy", "local edits");
    writeSkill(globalRoot(), "deploy", "stale pulled copy");
    const skills = listAllExistingSkills(projectCwd);
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe("project");
    expect(skills[0].body).toContain("local edits");
  });

  it("surfaces the frontmatter `author` so the gate can detect cross-author MERGE", () => {
    const fmWithAuthor = (name: string, author: string) =>
      `---\nname: ${name}\ndescription: "d"\nauthor: ${author}\nsource_sessions: []\nversion: 1\ncreated_by_agent: x\ncreated_at: 2026\nupdated_at: 2026\n---\n\nbody\n`;
    const aDir = join(projectRoot(), "mine");
    mkdirSync(aDir, { recursive: true });
    writeFileSync(join(aDir, "SKILL.md"), fmWithAuthor("mine", "emanuele"));
    // Legacy file with no author in frontmatter — must stay undefined,
    // not be auto-filled with a placeholder.
    writeSkill(projectRoot(), "legacy", "body");
    const skills = listAllExistingSkills(projectCwd);
    const byName = Object.fromEntries(skills.map(s => [s.name, s]));
    expect(byName["mine"].author).toBe("emanuele");
    expect(byName["legacy"].author).toBeUndefined();
  });
});

describe("renderExistingSkillsBlock", () => {
  it("returns the no-skills sentinel when both roots are empty", () => {
    const result = renderExistingSkillsBlock(projectCwd, 1000);
    expect(result.mergeTargetNames).toEqual([]);
    expect(result.block).toMatch(/no existing skills/);
    expect(result.block).toMatch(/MERGE is NOT a valid choice/);
  });

  it("only [project] skills are MERGE-eligible (post-#125 review: worker's mergeSkill is rooted at cfg.install)", () => {
    writeSkill(projectRoot(), "deploy", "p body");
    writeSkill(globalRoot(), "team-standup--d", "g body");
    writeSkill(globalRoot(), "pg-deeplake-cred-callback--levon", "g body 2");
    const result = renderExistingSkillsBlock(projectCwd, 10_000);
    // [global] entries are reference-only until the worker can resolve a
    // global mergeSkill root (`<root>/<name>--<author>`) and translate
    // the verdict name back to a DB name. Without that plumbing the
    // worker would always fall through to writeNewSkill — i.e. silently
    // create a new skill instead of merging — which is exactly the
    // duplicate-producing bug #118 was meant to prevent.
    expect(result.mergeTargetNames).toEqual(["deploy"]);
  });

  it("tags each rendered skill with [project, ...] or [global, read-only, ...] and surfaces author", () => {
    // Project skill carries its author in the frontmatter; global pulled
    // skill from a teammate likewise.
    const fmWithAuthor = (name: string, author: string, body: string) =>
      `---\nname: ${name}\ndescription: "d"\nauthor: ${author}\nsource_sessions: []\nversion: 1\ncreated_by_agent: x\ncreated_at: 2026\nupdated_at: 2026\n---\n\n${body}\n`;
    {
      const dir = join(projectRoot(), "my-local");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), fmWithAuthor("my-local", "emanuele", "local body"));
    }
    {
      const dir = join(globalRoot(), "their-skill--alice");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), fmWithAuthor("their-skill--alice", "alice", "alice body"));
    }
    const result = renderExistingSkillsBlock(projectCwd, 10_000);
    // Tag shape: [<source>[, author=<name>]]. `[global, read-only, ...]`
    // signals to the LLM that the skill exists but isn't a MERGE target.
    expect(result.block).toContain("[project, author=emanuele]: my-local");
    expect(result.block).toContain("[global, read-only, author=alice]: their-skill--alice");
    // Defensive against future template churn.
    expect(result.block).not.toMatch(/^--- existing skill: /m);
  });

  it("mergeTargetNames excludes skills truncated by the char cap (not just by source)", () => {
    // The previous implementation built mergeTargetNames from ALL skills
    // and only the rendered block was truncated. That would let the gate
    // pick a name whose body it never saw — breaking the "safe + visible
    // to the LLM" contract.
    writeSkill(projectRoot(), "alpha", "a".repeat(50));
    writeSkill(projectRoot(), "beta", "b".repeat(50));
    writeSkill(projectRoot(), "gamma", "c".repeat(50));
    const huge = renderExistingSkillsBlock(projectCwd, 1_000_000);
    expect(huge.mergeTargetNames.sort()).toEqual(["alpha", "beta", "gamma"]);
    // Cap that fits only the first block.
    const oneBlockLen = Math.ceil(huge.block.length / 3);
    const truncated = renderExistingSkillsBlock(projectCwd, oneBlockLen + 5);
    expect(truncated.block).toContain("omitted");
    // Only the first (rendered) name is a valid MERGE target.
    expect(truncated.mergeTargetNames).toEqual(["alpha"]);
  });

  it("respects the char cap with a placeholder line for the omitted tail", () => {
    writeSkill(projectRoot(), "alpha", "body of alpha");
    writeSkill(projectRoot(), "beta", "body of beta");
    writeSkill(projectRoot(), "gamma", "body of gamma");
    // Measure one block's worth, then cap so two fit but the third spills.
    const huge = renderExistingSkillsBlock(projectCwd, 1_000_000);
    expect(huge.block).not.toContain("omitted");
    const oneBlockLen = Math.ceil(huge.block.length / 3);
    const cap = oneBlockLen * 2 + 5; // headroom for the second block to land
    const result = renderExistingSkillsBlock(projectCwd, cap);
    expect(result.block).toContain("more existing skills omitted");
    // The placeholder reflects the actual remaining count after two
    // blocks were kept (3 total - 2 kept = 1).
    expect(result.block).toMatch(/\[…1 more existing skills omitted\]/);
  });
});
