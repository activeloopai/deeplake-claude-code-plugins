import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCompiledBashCommand } from "../../src/hooks/bash-command-compiler.js";
import { handleGrepDirect, parseBashGrep } from "../../src/hooks/grep-direct.js";
import { processPreToolUse } from "../../src/hooks/pre-tool-use.js";

type FixtureFile = { path: string; content: string };

type SessionTurn = {
  speaker: string;
  dia_id: string;
  text: string;
};

const baseConfig = {
  token: "token",
  orgId: "org-1",
  orgName: "Acme",
  userName: "alice",
  workspaceId: "default",
  apiUrl: "https://api.example.com",
  tableName: "memory",
  sessionsTableName: "sessions",
  memoryPath: "/tmp/.deeplake/memory",
};

function buildSessionFile(
  sessionNumber: number,
  turns: SessionTurn[],
  dateTime = "8:56 pm on 20 July, 2023",
): FixtureFile {
  const session = {
    conversation_id: 0,
    session_number: sessionNumber,
    date_time: dateTime,
    speakers: {
      speaker_a: "Caroline",
      speaker_b: "Melanie",
    },
    turns,
  };
  return {
    path: `/sessions/conv_0_session_${sessionNumber}.json`,
    content: `${JSON.stringify(session, null, 2)}\n`,
  };
}

function rewriteForLocalRoot(command: string, root: string): string {
  return command
    .replaceAll("/sessions", `${root}/sessions`)
    .replaceAll("/summaries", `${root}/summaries`)
    .replaceAll("/index.md", `${root}/index.md`);
}

function runLocalBash(root: string, command: string): string {
  const localCommand = rewriteForLocalRoot(command, root);
  try {
    return execFileSync("/bin/bash", ["-lc", localCommand], {
      encoding: "utf8",
    }).trim();
  } catch (error: any) {
    return String(error?.stdout ?? "").trim();
  }
}

function writeFixture(files: FixtureFile[]): string {
  const root = mkdtempSync(join(tmpdir(), "hivemind-benchmark-replay-"));
  for (const file of files) {
    const fullPath = join(root, file.path.slice(1));
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, file.content);
  }
  return root;
}

function makeQueryRows(files: FixtureFile[]) {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

function likePatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("%", ".*").replaceAll("_", ".")}$`);
}

async function runVirtualCommand(files: FixtureFile[], command: string): Promise<string> {
  const queryRows = makeQueryRows(files);
  const grepHandler = async (_api: any, _memory: string, _sessions: string, params: any) => {
    const api = { query: vi.fn().mockResolvedValue(queryRows) } as any;
    return (await handleGrepDirect(api, "memory", "sessions", params)) ?? "";
  };

  const compiled = await executeCompiledBashCommand(
    { query: vi.fn() } as any,
    "memory",
    "sessions",
    command,
    {
      readVirtualPathContentsFn: vi.fn(async (_api, _memory, _sessions, paths: string[]) => new Map(
        paths.map((path) => [path, files.find((file) => file.path === path)?.content ?? null]),
      )) as any,
      listVirtualPathRowsForDirsFn: vi.fn(async (_api, _memory, _sessions, dirs: string[]) => new Map(
        dirs.map((dir) => [
          dir,
          files
            .filter((file) => file.path === dir || file.path.startsWith(`${dir.replace(/\/+$/, "")}/`))
            .map((file) => ({ path: file.path, size_bytes: Buffer.byteLength(file.content) })),
        ]),
      )) as any,
      findVirtualPathsFn: vi.fn(async (_api, _memory, _sessions, dir: string, filenamePattern: string) => {
        const dirPrefix = dir.replace(/\/+$/, "") || "/";
        const matcher = likePatternToRegExp(filenamePattern);
        return files
          .filter((file) => file.path.startsWith(`${dirPrefix}/`))
          .map((file) => file.path)
          .filter((path) => matcher.test(path.slice(path.lastIndexOf("/") + 1)));
      }) as any,
      handleGrepDirectFn: grepHandler as any,
    },
  );
  if (compiled !== null) return compiled.trim();

  const grepParams = parseBashGrep(command);
  if (!grepParams) {
    throw new Error(`Command is neither compiled nor grep-direct: ${command}`);
  }
  return (await grepHandler(null, "memory", "sessions", grepParams)).trim();
}

describe("benchmark replay parity", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("matches raw output for relationship-status grep", async () => {
    const files = [
      buildSessionFile(13, [
        { dia_id: "D13:1", speaker: "Caroline", text: "I'm single and planning to adopt as a single parent." },
        { dia_id: "D13:2", speaker: "Caroline", text: "As a transgender woman, the support group changed my life." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -E 'relationship|dating|partner|married|single|girlfriend|boyfriend' /sessions/conv_0_session_13.json";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "I\'m single and planning to adopt as a single parent."');
  });

  it("matches raw output for camping-location grep", async () => {
    const files = [
      buildSessionFile(10, [
        { dia_id: "D10:12", speaker: "Melanie", text: "We camped near a mountain lake in a state park last summer." },
        { dia_id: "D10:13", speaker: "Caroline", text: "That sounds beautiful." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -E 'mountain|lake|forest|state|park|location|where|place' /sessions/conv_0_session_10.json";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "We camped near a mountain lake in a state park last summer."');
  });

  it("matches raw output for Dr. Seuss bookshelf grep", async () => {
    const files = [
      buildSessionFile(6, [
        { dia_id: "D6:1", speaker: "Melanie", text: "We keep classic kids' books like Dr. Seuss on the bookshelf." },
        { dia_id: "D6:2", speaker: "Caroline", text: "That sounds perfect for the kids." },
      ]),
      buildSessionFile(7, [
        { dia_id: "D7:1", speaker: "Caroline", text: "I just started a new counseling course." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -E 'Dr. Seuss|bookshelf|books' /sessions/*.json";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "We keep classic kids\' books like Dr. Seuss on the bookshelf."');
  });

  it("keeps the 18th-birthday shell-loop case explicitly divergent by returning retry guidance", async () => {
    const files = [
      buildSessionFile(12, [
        { dia_id: "D12:1", speaker: "Caroline", text: "A friend made it for my 18th birthday ten years ago." },
        { dia_id: "D12:2", speaker: "Melanie", text: "That's really thoughtful." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const localCommand = "for file in /sessions/conv_0_session_*.json; do echo \"=== $(basename $file) ===\"; grep -i \"age\\|year.*old\\|born\\|birthday\\|turn.*18\" \"$file\" 2>/dev/null | head -3; done | grep -B 1 -i \"age\\|birthday\\|born\"";
    const local = runLocalBash(root, localCommand);
    expect(local).toContain("18th birthday");

    const decision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: {
        command: "for file in ~/.deeplake/memory/sessions/conv_0_session_*.json; do echo \"=== $(basename $file) ===\"; grep -i \"age\\|year.*old\\|born\\|birthday\\|turn.*18\" \"$file\" 2>/dev/null | head -3; done | grep -B 1 -i \"age\\|birthday\\|born\"",
      },
      tool_use_id: "tu-bm-q12",
    }, {
      config: baseConfig as any,
    });

    expect(decision?.command).toContain("RETRY REQUIRED");
    expect(decision?.description).toContain("unsupported command");
  });

  it("matches raw output for the direct-grep fallback after the blocked 18th-birthday loop", async () => {
    const files = [
      buildSessionFile(12, [
        { dia_id: "D12:1", speaker: "Caroline", text: "A friend made it for my 18th birthday ten years ago." },
        { dia_id: "D12:2", speaker: "Melanie", text: "That's really thoughtful." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -i -E 'age|birthday|born.*19|born.*20' /sessions/";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "A friend made it for my 18th birthday ten years ago."');
  });

  it("matches raw output for support-group date searches", async () => {
    const files = [
      buildSessionFile(10, [
        { dia_id: "D10:1", speaker: "Caroline", text: "I joined the LGBTQ support group last Tuesday, July 18, 2023." },
        { dia_id: "D10:2", speaker: "Melanie", text: "That sounds like such a good step." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -i -E 'support group|lgbtq support' /sessions/";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "I joined the LGBTQ support group last Tuesday, July 18, 2023."');
  });

  it("matches raw output for move-from-four-years-ago searches", async () => {
    const files = [
      buildSessionFile(11, [
        { dia_id: "D11:1", speaker: "Caroline", text: "I moved here from Sweden four years ago." },
        { dia_id: "D11:2", speaker: "Melanie", text: "That must have been a big change." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -i -E 'moved from|four year|4 year|sweden' /sessions/";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "I moved here from Sweden four years ago."');
  });

  it("matches raw output for Melanie activity aggregation searches", async () => {
    const files = [
      buildSessionFile(8, [
        { dia_id: "D8:1", speaker: "Melanie", text: "We tried a pottery workshop, went swimming, and planned our annual camping trip." },
        { dia_id: "D8:2", speaker: "Caroline", text: "That sounds like a full summer." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -i -E 'pottery|swimming|camping' /sessions/";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "We tried a pottery workshop, went swimming, and planned our annual camping trip."');
  });

  it("matches raw output for Melanie destress searches", async () => {
    const files = [
      buildSessionFile(9, [
        { dia_id: "D9:1", speaker: "Melanie", text: "Running helps me destress after busy weeks." },
        { dia_id: "D9:2", speaker: "Caroline", text: "That makes sense." },
      ]),
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -i -E 'destress|stress|running|painting' /sessions/";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(virtual).toContain('"text": "Running helps me destress after busy weeks."');
  });

  it("matches raw output for q23-style summary markdown searches", async () => {
    const files: FixtureFile[] = [
      {
        path: "/summaries/locomo/conv_0_session_6_summary.md",
        content: [
          "# Session 6",
          "## Searchable Facts",
          "- Melanie said Charlotte's Web was her favorite book as a child.",
          "- The family keeps classic kids' books on the bookshelf.",
          "",
        ].join("\n"),
      },
      {
        path: "/summaries/locomo/conv_0_session_7_summary.md",
        content: [
          "# Session 7",
          "## Searchable Facts",
          "- Caroline started a new counseling course.",
          "",
        ].join("\n"),
      },
    ];
    const root = writeFixture(files);
    roots.push(root);

    const command = "grep -r -i -E 'book|read' /summaries/locomo/conv_0_session_*.md";
    const local = runLocalBash(root, command);
    const virtual = await runVirtualCommand(files, command);

    expect(local.replaceAll(root, "")).toEqual(virtual);
    expect(local).toContain("Charlotte's Web");
  });
});
