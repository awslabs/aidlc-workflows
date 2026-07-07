// aidlc-sensor-coverage-threshold.ts — ADVISORY coverage gate (test-pro plugin).
//
// Reads the machine-readable coverage summary the build-and-test contribution
// emits (test-pro-coverage-summary.json) and reports whether branch+line
// coverage meet their targets. ADVISORY: the framework has no blocking sensor
// severity yet, so a failure is reported, not enforced. Targets travel INSIDE
// the JSON (`targets`), falling back to embedded defaults — so this tool needs
// no node-derived dispatcher flag, only the --output-path the dispatcher always
// passes. Shipped to .claude/tools/ via the bundle's contributes.tools.
import { existsSync, readFileSync } from "node:fs";

// Self-contained — no import of the framework's aidlc-lib (a plugin tool ships
// in its own delta and must not depend on a sibling core tool being present).
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const DEFAULT_TARGETS = { line: 80, branch: 70 };

interface Result {
  pass: boolean;
  findings_count: number;
  line_pct: number;
  branch_pct: number;
  targets: { line: number; branch: number };
}

interface Flags {
  stage?: string;
  outputPath?: string;
}

function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stage") out.stage = argv[++i];
    else if (argv[i] === "--output-path") out.outputPath = argv[++i];
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`aidlc-sensor-coverage-threshold: ${msg}\n`);
  process.exit(1);
}

// A pass-through result — the sensor fired on a write it doesn't own, so it
// reports a clean no-op rather than a failure. The dispatcher fires on EVERY
// write under the record dir (matches glob), not only this sensor's JSON, so
// most fires are for some other artifact and must not raise a false finding.
function passThrough(): never {
  process.stdout.write(`${JSON.stringify({ pass: true, findings_count: 0, line_pct: 0, branch_pct: 0, targets: DEFAULT_TARGETS })}\n`);
  process.exit(0);
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.outputPath) fail("--output-path is required");
  // Only act on this sensor's own machine-readable file; any other write is a
  // clean pass-through (not a failure).
  if (!flags.outputPath.endsWith("test-pro-coverage-summary.json")) passThrough();
  if (!existsSync(flags.outputPath)) passThrough();

  let parsed: {
    line_pct?: number;
    branch_pct?: number;
    targets?: { line?: number; branch?: number };
  };
  try {
    parsed = JSON.parse(readFileSync(flags.outputPath, "utf-8"));
  } catch (err) {
    fail(`failed to parse coverage JSON ${flags.outputPath}: ${errorMessage(err)}`);
  }

  const line_pct = typeof parsed.line_pct === "number" ? parsed.line_pct : 0;
  const branch_pct = typeof parsed.branch_pct === "number" ? parsed.branch_pct : 0;
  const targets = {
    line: parsed.targets?.line ?? DEFAULT_TARGETS.line,
    branch: parsed.targets?.branch ?? DEFAULT_TARGETS.branch,
  };

  let findings_count = 0;
  if (line_pct < targets.line) findings_count++;
  if (branch_pct < targets.branch) findings_count++;

  const result: Result = {
    pass: findings_count === 0,
    findings_count,
    line_pct,
    branch_pct,
    targets,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
