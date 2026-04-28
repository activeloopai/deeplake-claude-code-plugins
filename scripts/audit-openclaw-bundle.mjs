#!/usr/bin/env node
/**
 * Local replication of ClawHub's static-analysis scanner against the openclaw
 * plugin bundle. Runs the same per-file regex rules ClawHub uses at publish
 * time so we can see flags BEFORE shipping a release instead of after.
 *
 * Rules are replicated (not imported) from openclaw's skill-scanner — that
 * code lives in our research-reference checkout under ~/al-projects/ext/ and
 * is third-party we don't own. Re-sync these rules if upstream changes them.
 *
 *   Reference: openclaw repo, src/security/skill-scanner.ts:147-206
 *
 * Usage:
 *   node scripts/audit-openclaw-bundle.mjs           # scan openclaw/dist
 *   node scripts/audit-openclaw-bundle.mjs <path>    # scan a specific dir
 *
 * Exits non-zero if any "critical" or "warn" finding is reported.
 */

import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";

const SCAN_DIR = process.argv[2] ?? "openclaw/dist";
const SCANNABLE_EXT = new Set([".js", ".mjs", ".cjs"]);
const MAX_FILE_BYTES = 1024 * 1024; // 1MB; matches upstream default

// ---- LINE_RULES (per-line; both pattern AND requiresContext must match) ----
const LINE_RULES = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
    requiresContext: /child_process/,
  },
  {
    ruleId: "dynamic-code-execution",
    severity: "critical",
    message: "Dynamic code execution detected",
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    ruleId: "crypto-mining",
    severity: "critical",
    message: "Possible crypto-mining reference detected",
    pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i,
  },
  {
    ruleId: "suspicious-network",
    severity: "warn",
    message: "WebSocket connection to non-standard port",
    pattern: /new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/,
    portCheck: true,
  },
];

const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);
const NETWORK_SEND = /\bfetch\s*\(|\bpost\s*\(|\.\s*post\s*\(|http\.request\s*\(/i;

// ---- SOURCE_RULES (whole file; both pattern AND requiresContext must match) ----
const SOURCE_RULES = [
  {
    ruleId: "potential-exfiltration",
    severity: "warn",
    message: "File read combined with network send (possible exfiltration)",
    pattern: /readFileSync|readFile/,
    requiresContext: NETWORK_SEND,
  },
  {
    ruleId: "obfuscated-code-hex",
    severity: "warn",
    message: "Hex-encoded string sequence detected (possible obfuscation)",
    pattern: /(\\x[0-9a-fA-F]{2}){6,}/,
  },
  {
    ruleId: "obfuscated-code-base64",
    severity: "warn",
    message: "Large base64 payload with decode call detected (possible obfuscation)",
    pattern: /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/,
  },
  {
    ruleId: "env-harvesting",
    severity: "critical",
    message: "Environment variable access combined with network send (possible credential harvesting)",
    pattern: /process\.env/,
    requiresContext: NETWORK_SEND,
  },
];

function truncate(s, n = 120) { return s.length <= n ? s : s.slice(0, n) + "…"; }

function scanFile(path) {
  const stat = statSync(path);
  if (stat.size > MAX_FILE_BYTES) {
    return [{ ruleId: "file-too-large", severity: "info", file: path, line: 0, message: `Skipped (${stat.size} bytes > ${MAX_FILE_BYTES} byte limit)`, evidence: "" }];
  }
  const source = readFileSync(path, "utf-8");
  const lines = source.split("\n");
  const findings = [];

  for (const rule of LINE_RULES) {
    if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = rule.pattern.exec(line);
      if (!m) continue;
      if (rule.portCheck) {
        const port = Number.parseInt(m[1], 10);
        if (STANDARD_PORTS.has(port)) continue;
      }
      findings.push({ ruleId: rule.ruleId, severity: rule.severity, file: path, line: i + 1, message: rule.message, evidence: truncate(line.trim()) });
      break; // one finding per line-rule per file
    }
  }

  for (const rule of SOURCE_RULES) {
    if (!rule.pattern.test(source)) continue;
    if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
    let matchLine = 0, matchEvidence = "";
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) { matchLine = i + 1; matchEvidence = lines[i].trim(); break; }
    }
    if (matchLine === 0) { matchLine = 1; matchEvidence = source.slice(0, 120); }
    findings.push({ ruleId: rule.ruleId, severity: rule.severity, file: path, line: matchLine, message: rule.message, evidence: truncate(matchEvidence) });
  }

  return findings;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && SCANNABLE_EXT.has(extname(entry.name).toLowerCase())) yield p;
  }
}

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 };
const SEVERITY_ICON = { info: "·", warn: "!", critical: "✗" };

const allFindings = [];
let scannedFiles = 0;
for await (const file of walk(SCAN_DIR)) {
  scannedFiles++;
  for (const f of scanFile(file)) allFindings.push(f);
}

const counts = { info: 0, warn: 0, critical: 0 };
for (const f of allFindings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

console.log(`\nScanned ${scannedFiles} file(s) under ${SCAN_DIR}/\n`);

if (allFindings.length === 0) {
  console.log("✓ No findings. Bundle is clean against ClawHub's static-analysis rules.\n");
  process.exit(0);
}

allFindings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
for (const f of allFindings) {
  console.log(`${SEVERITY_ICON[f.severity]} [${f.severity.toUpperCase()}] ${f.ruleId}`);
  console.log(`    ${f.file}:${f.line}`);
  console.log(`    ${f.message}`);
  if (f.evidence) console.log(`    > ${f.evidence}`);
  console.log();
}

const summary = `${counts.critical} critical, ${counts.warn} warn, ${counts.info} info`;
console.log(`Summary: ${summary}\n`);
process.exit(counts.critical > 0 || counts.warn > 0 ? 1 : 0);
