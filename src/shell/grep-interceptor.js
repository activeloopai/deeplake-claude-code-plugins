import { defineCommand } from "just-bash";
import yargsParser from "yargs-parser";
import { sqlStr as esc } from "../utils/sql.js";
/**
 * Custom grep command for just-bash that replaces the built-in when the target
 * paths are under the Deeplake mount. Two-phase strategy:
 *   1. Coarse BM25 filter via Deeplake SQL → candidate paths
 *   2. Prefetch candidates into the in-memory content cache
 *   3. Fine-grained regex match line-by-line (in-memory, no further network I/O)
 *
 * Falls back to ILIKE if BM25 index is unavailable.
 * Falls through (returns exitCode=127) for paths outside the mount so
 * just-bash can route to its own built-in grep.
 */
export function createGrepCommand(client, fs, table) {
    return defineCommand("grep", async (args, ctx) => {
        const parsed = yargsParser(args, {
            boolean: ["r", "R", "l", "i", "n", "v", "c", "F", "fixed-strings", "recursive", "ignore-case"],
            alias: { r: "recursive", R: "recursive", F: "fixed-strings", i: "ignore-case", n: "line-number" },
        });
        const positional = parsed._;
        if (positional.length === 0) {
            return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 1 };
        }
        const pattern = String(positional[0]);
        const targetArgs = positional.slice(1);
        // Resolve all target paths against cwd
        const targets = targetArgs.length > 0
            ? targetArgs.map(t => ctx.fs.resolvePath(ctx.cwd, String(t))).filter(Boolean)
            : [ctx.cwd];
        if (targets.length === 0)
            return { stdout: "", stderr: "", exitCode: 1 };
        const mount = fs.mountPoint;
        // Only intercept if all targets are under our mount point
        const allUnderMount = targets.every(t => t === mount || t.startsWith(mount + "/"));
        if (!allUnderMount) {
            // Signal to caller that this command doesn't handle it
            return { stdout: "", stderr: "", exitCode: 127 };
        }
        // ── Phase 1: coarse filter — try BM25, fall back to in-memory ──────────
        let candidates = [];
        try {
            const bm25 = await Promise.race([
                client.query(`SELECT path FROM "${table}" WHERE summary <#> '${esc(pattern)}' LIMIT 50`),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
            ]);
            candidates = bm25.map(r => r["path"]).filter(Boolean);
        }
        catch {
            // BM25 index not available or timed out — fall back to in-memory
        }
        if (candidates.length === 0) {
            // No BM25 results or no index — use all files under targets and search in-memory
            candidates = fs.getAllPaths().filter(p => !p.endsWith("/"));
        }
        // Narrow candidates to those under the requested targets
        candidates = candidates.filter(c => targets.some(t => t === "/" || c === t || c.startsWith(t + "/")));
        // ── Phase 2: prefetch into content cache (parallel) ─────────────────────
        await Promise.all(candidates.map(p => fs.readFile(p).catch(() => null)));
        // ── Phase 3: fine-grained in-memory match ────────────────────────────────
        const fixedString = parsed.F || parsed["fixed-strings"];
        const ignoreCase = parsed.i || parsed["ignore-case"];
        const showLine = parsed.n || parsed["line-number"];
        const invertMatch = parsed.v;
        const filesOnly = parsed.l;
        const countOnly = parsed.c;
        const re = new RegExp(fixedString ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, ignoreCase ? "i" : "");
        const output = [];
        const multipleFiles = candidates.length > 1;
        for (const fp of candidates) {
            const content = await fs.readFile(fp).catch(() => null);
            if (content === null)
                continue;
            const lines = content.split("\n");
            const matchedLines = [];
            for (let i = 0; i < lines.length; i++) {
                const matched = re.test(lines[i]);
                if (matched !== invertMatch) {
                    if (filesOnly) {
                        output.push(fp);
                        break;
                    }
                    const prefix = multipleFiles ? `${fp}:` : "";
                    const lineNo = showLine ? `${i + 1}:` : "";
                    matchedLines.push(`${prefix}${lineNo}${lines[i]}`);
                }
            }
            if (!filesOnly) {
                if (countOnly) {
                    const prefix = multipleFiles ? `${fp}:` : "";
                    output.push(`${prefix}${matchedLines.length}`);
                }
                else {
                    output.push(...matchedLines);
                }
            }
        }
        return {
            stdout: output.length > 0 ? output.join("\n") + "\n" : "",
            stderr: "",
            exitCode: output.length > 0 ? 0 : 1,
        };
    });
}
//# sourceMappingURL=grep-interceptor.js.map