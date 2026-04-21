/**
 * Cap large tool outputs before they reach Claude Code.
 *
 * Claude Code's Bash tool silently persists any tool_result larger than
 * ~16 KB to disk and replaces it with a 2 KB "preview" + a path to the
 * persisted file. In the locomo `baseline_cloud_100qa_fix123` run, 11
 * out of 14 losing QAs that hit this path NEVER recovered — the model
 * saw a 2 KB slice of grep output and gave up instead of reading the
 * persisted file. For our workload 8 KB of meaningful content is
 * consistently more useful to the model than 2 KB + a dangling file
 * pointer, so we cap the plugin-returned output below that threshold
 * and replace the tail with a footer that tells the model how to
 * narrow the next call.
 *
 * The cap is applied at line boundaries to keep grep / cat output
 * structure intact. A short footer indicates how many lines / bytes
 * were elided and suggests refinements ("pipe to | head -N" or
 * "tighten the pattern").
 */

export const CLAUDE_OUTPUT_CAP_BYTES = 8 * 1024;

function byteLen(str: string): number {
  return Buffer.byteLength(str, "utf8");
}

export interface CapOutputOptions {
  /** Hint shown in the footer. Examples: "grep", "cat", "for-loop". */
  kind?: string;
  /** Override the cap size (bytes). Defaults to CLAUDE_OUTPUT_CAP_BYTES. */
  maxBytes?: number;
}

/**
 * If `output` fits in the cap, return it unchanged. Otherwise truncate
 * at the last newline that keeps the total (including footer) under the
 * cap, and append a footer describing what was elided.
 */
export function capOutputForClaude(output: string, options: CapOutputOptions = {}): string {
  const maxBytes = options.maxBytes ?? CLAUDE_OUTPUT_CAP_BYTES;
  if (byteLen(output) <= maxBytes) return output;

  const kind = options.kind ?? "output";
  // Reserve ~200 bytes for the footer so it always fits within maxBytes.
  const footerReserve = 220;
  const budget = Math.max(1, maxBytes - footerReserve);

  // Find the last newline before the byte budget. Walk forward building
  // the slice so the byte boundary stays valid even for multibyte UTF-8.
  let running = 0;
  const lines = output.split("\n");
  const keptLines: string[] = [];
  for (const line of lines) {
    const lineBytes = byteLen(line) + 1; // +1 for the newline
    if (running + lineBytes > budget) break;
    keptLines.push(line);
    running += lineBytes;
  }

  if (keptLines.length === 0) {
    // A single line is already over budget — take a prefix and mark it.
    // `Buffer.subarray` (non-deprecated replacement for `.slice`) cuts at a
    // byte boundary, which can split a multi-byte UTF-8 sequence and leak
    // U+FFFD into the output. Back up to the last valid UTF-8 start byte
    // (any byte whose top two bits aren't `10xxxxxx` — i.e. not a
    // continuation byte) so `toString("utf8")` decodes cleanly.
    const buf = Buffer.from(output, "utf8");
    let cutByte = Math.min(budget, buf.length);
    while (cutByte > 0 && (buf[cutByte] & 0xc0) === 0x80) cutByte--;
    const slice = buf.subarray(0, cutByte).toString("utf8");
    const footer = `\n... [${kind} truncated: ${(byteLen(output) / 1024).toFixed(1)} KB total; refine with '| head -N' or a tighter pattern]`;
    return slice + footer;
  }

  // `split("\n")` on `"a\nb\n"` produces `["a", "b", ""]` — the trailing
  // empty entry is a newline terminator, not a real extra line. Counting
  // it would over-report the elided-line tally in the footer.
  const totalLines = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
  const elidedLines = Math.max(0, totalLines - keptLines.length);
  const elidedBytes = byteLen(output) - byteLen(keptLines.join("\n"));
  const footer = `\n... [${kind} truncated: ${elidedLines} more lines (${(elidedBytes / 1024).toFixed(1)} KB) elided — refine with '| head -N' or a tighter pattern]`;
  return keptLines.join("\n") + footer;
}
