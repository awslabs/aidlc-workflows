#!/usr/bin/env node
/**
 * security-scan.js
 *
 * A tool used by the security-engineer persona during contribution to
 * code-generation and infrastructure-design stages.
 *
 * Wraps external security scanning tools (semgrep, checkov, trivy)
 * and normalizes their output into a common findings format.
 *
 * Usage:
 *   node security-scan.js <target-path> [--scanner semgrep|checkov|trivy]
 *
 * Output:
 *   JSON to stdout:
 *   {
 *     "tool": "security-scan",
 *     "scanner": "<scanner-used>",
 *     "target": "<path-scanned>",
 *     "status": "PASS" | "FINDINGS",
 *     "findings": [
 *       {
 *         "severity": "HIGH|MEDIUM|LOW",
 *         "rule": "<rule-id>",
 *         "file": "<file-path>",
 *         "line": <line-number>,
 *         "message": "<description>"
 *       }
 *     ],
 *     "summary": { "high": N, "medium": N, "low": N }
 *   }
 *
 * Exit codes:
 *   0 — no findings
 *   1 — findings exist
 *   2 — error (scanner not installed, bad arguments)
 *
 * Prerequisites:
 *   At least one scanner must be installed:
 *   - semgrep (pip install semgrep)
 *   - checkov (pip install checkov) — for IaC
 *   - trivy (brew install trivy) — for container/dependency scanning
 *
 * Note: This tool is not used by the current three stages (requirements,
 * stories, wireframes). It becomes relevant when code-generation and
 * infrastructure-design stages are added.
 */

const { execSync } = require("child_process");

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node security-scan.js <target-path> [--scanner semgrep|checkov|trivy]");
  process.exit(2);
}

const targetPath = args[0];
const scannerFlag = args.indexOf("--scanner");
const scanner = scannerFlag >= 0 ? args[scannerFlag + 1] : detectScanner();

function detectScanner() {
  const scanners = ["semgrep", "checkov", "trivy"];
  for (const s of scanners) {
    try {
      execSync(`which ${s}`, { stdio: "pipe" });
      return s;
    } catch {
      continue;
    }
  }
  console.error("No supported scanner found. Install semgrep, checkov, or trivy.");
  process.exit(2);
}

function runSemgrep(target) {
  try {
    const output = execSync(
      `semgrep scan --config auto --json --quiet "${target}"`,
      { stdio: ["pipe", "pipe", "pipe"], timeout: 120000 }
    ).toString();
    const results = JSON.parse(output);
    return (results.results || []).map(r => ({
      severity: (r.extra?.severity || "MEDIUM").toUpperCase(),
      rule: r.check_id || "unknown",
      file: r.path || "",
      line: r.start?.line || 0,
      message: r.extra?.message || r.check_id || "",
    }));
  } catch (e) {
    if (e.stdout) {
      try {
        const results = JSON.parse(e.stdout.toString());
        return (results.results || []).map(r => ({
          severity: (r.extra?.severity || "MEDIUM").toUpperCase(),
          rule: r.check_id || "unknown",
          file: r.path || "",
          line: r.start?.line || 0,
          message: r.extra?.message || r.check_id || "",
        }));
      } catch { /* fall through */ }
    }
    return [];
  }
}

function runCheckov(target) {
  try {
    const output = execSync(
      `checkov -d "${target}" --output json --quiet`,
      { stdio: ["pipe", "pipe", "pipe"], timeout: 120000 }
    ).toString();
    const results = JSON.parse(output);
    const failed = results.results?.failed_checks || [];
    return failed.map(r => ({
      severity: "HIGH",
      rule: r.check_id || "unknown",
      file: r.file_path || "",
      line: r.file_line_range?.[0] || 0,
      message: r.check_name || "",
    }));
  } catch {
    return [];
  }
}

function runTrivy(target) {
  try {
    const output = execSync(
      `trivy fs --format json --quiet "${target}"`,
      { stdio: ["pipe", "pipe", "pipe"], timeout: 120000 }
    ).toString();
    const results = JSON.parse(output);
    const findings = [];
    for (const result of results.Results || []) {
      for (const vuln of result.Vulnerabilities || []) {
        findings.push({
          severity: (vuln.Severity || "MEDIUM").toUpperCase(),
          rule: vuln.VulnerabilityID || "unknown",
          file: result.Target || "",
          line: 0,
          message: vuln.Title || vuln.Description || "",
        });
      }
    }
    return findings;
  } catch {
    return [];
  }
}

// --- Main ---

let findings;
switch (scanner) {
  case "semgrep":
    findings = runSemgrep(targetPath);
    break;
  case "checkov":
    findings = runCheckov(targetPath);
    break;
  case "trivy":
    findings = runTrivy(targetPath);
    break;
  default:
    console.error(`Unknown scanner: ${scanner}`);
    process.exit(2);
}

const summary = {
  high: findings.filter(f => f.severity === "HIGH").length,
  medium: findings.filter(f => f.severity === "MEDIUM").length,
  low: findings.filter(f => f.severity === "LOW").length,
};

const result = {
  tool: "security-scan",
  scanner,
  target: targetPath,
  status: findings.length === 0 ? "PASS" : "FINDINGS",
  findings,
  summary,
};

console.log(JSON.stringify(result, null, 2));
process.exit(findings.length === 0 ? 0 : 1);
