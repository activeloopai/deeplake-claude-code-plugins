import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const DEBUG = process.env.DEEPLAKE_DEBUG === "1";
const LOG = join(homedir(), ".deeplake", "hook-debug.log");
export function log(tag, msg) {
    if (!DEBUG)
        return;
    appendFileSync(LOG, `${new Date().toISOString()} [${tag}] ${msg}\n`);
}
//# sourceMappingURL=debug.js.map