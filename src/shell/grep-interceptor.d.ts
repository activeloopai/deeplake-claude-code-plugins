import type { DeeplakeApi } from "../deeplake-api.js";
import type { DeeplakeFs } from "./deeplake-fs.js";
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
export declare function createGrepCommand(client: DeeplakeApi, fs: DeeplakeFs, table: string): import("just-bash").Command;
