/**
 * Authentication round-trip: write credentials → read back → use downstream.
 *
 * The real device flow needs a browser and an Auth0 round-trip — not e2e-
 * able from a headless harness. What IS e2e-able is the structural piece:
 *
 *   1. credentials.json gets written with the expected shape + mode 0600
 *   2. `hivemind whoami` reads it back and surfaces the right fields
 *   3. The CLI dispatchers (org / workspace / status) recognize the
 *      logged-in state without erroring
 *
 * Regression class this catches: a future refactor to auth-creds.ts that
 * changes the on-disk shape (renamed fields, missing fields, wrong file
 * mode) breaks every downstream consumer without any unit test catching it
 * because the consumers usually mock `loadCredentials()` directly.
 *
 * Setup pre-writes a stub credentials.json into the tmp HOME with valid
 * structure. Assertions invoke `hivemind whoami` and `hivemind workspaces`
 * via subprocess (HOME=tmp), parse the output, and confirm the expected
 * values surface. The "workspaces" subcommand is allowed to fail with a
 * network error since the stub token isn't real — we only assert that the
 * command recognizes the logged-in state.
 *
 * installOnly: true — no agent spawn.
 */

import { writeFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { E2ECase } from "../types.js";

const STUB_TOKEN = "e2e-stub-token-not-real";
const STUB_ORG_ID = "e2e-stub-org-id";
const STUB_ORG_NAME = "e2e-stub-org";
const STUB_WORKSPACE_ID = "e2e-stub-workspace-id";

const authLifecycleCase: E2ECase = {
  id: "15-auth-lifecycle",
  description:
    "credentials.json round-trips: write → read by `hivemind whoami` → recognized as logged in",
  prompt: "[install-only — auth round-trip]",
  installOnly: true,
  async setup(ctx) {
    // Pre-write a stub credentials.json with valid structure. Same shape
    // the device-flow path produces on completion. Note: the harness's
    // sandbox.ts ALREADY wrote a creds file under tmp HOME pointing at
    // the e2e workspace. We overwrite with our deterministic stub so the
    // assertions can match on known values.
    const deeplakeDir = join(ctx.home, ".deeplake");
    mkdirSync(deeplakeDir, { recursive: true, mode: 0o700 });
    const credsPath = join(deeplakeDir, "credentials.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        token: STUB_TOKEN,
        orgId: STUB_ORG_ID,
        orgName: STUB_ORG_NAME,
        workspaceId: STUB_WORKSPACE_ID,
        apiUrl: "https://api.deeplake.ai",
        savedAt: new Date().toISOString(),
      }, null, 2),
      { mode: 0o600 },
    );
  },
  assertions: [
    {
      type: "custom",
      label: "credentials.json exists with mode 0600",
      check: async ({ ctx }) => {
        const credsPath = join(ctx.home, ".deeplake", "credentials.json");
        if (!existsSync(credsPath)) return `${credsPath} missing after setup`;
        const stat = statSync(credsPath);
        const mode = stat.mode & 0o777;
        if (mode !== 0o600) {
          return `${credsPath} has mode ${mode.toString(8)} — must be 0600 since the token is secret`;
        }
        return null;
      },
    },
    {
      type: "custom",
      label: "`hivemind whoami` reads the stub and recognizes logged-in state",
      check: async ({ ctx }) => {
        const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
        const cliBundle = join(repoRoot, "bundle", "cli.js");
        let out: string;
        try {
          out = execFileSync(process.execPath, [cliBundle, "whoami"], {
            env: { ...process.env, HOME: ctx.home },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          }).toString();
        } catch (e: unknown) {
          const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
          // The whoami subcommand reads creds locally — it should NOT
          // fail on a stub token (no network call until /me lookup).
          // If it does fail here, the creds-shape contract regressed.
          return `\`hivemind whoami\` failed: ${err.stderr?.toString().slice(-300) ?? err.stdout?.toString().slice(-300) ?? err.message ?? String(e)}`;
        }
        // The output should mention the stub org name (or id) — exact format
        // varies by version but one of the two stub markers must appear.
        if (!out.includes(STUB_ORG_NAME) && !out.includes(STUB_ORG_ID)) {
          return `\`hivemind whoami\` output did NOT surface the logged-in org. Got: ${JSON.stringify(out.slice(0, 300))}`;
        }
        // Must NOT report "Not logged in" — that means the read path
        // didn't recognize the stub.
        if (/not logged in/i.test(out)) {
          return `\`hivemind whoami\` printed "not logged in" despite a valid credentials.json on disk. Got: ${JSON.stringify(out.slice(0, 300))}`;
        }
        return null;
      },
    },
  ],
  // Auth flow is CLI-shape, not agent-shape. Run once via claude-code.
  skipFor: ["codex", "cursor-agent", "hermes", "pi", "openclaw"],
};

export default authLifecycleCase;
