// aidlc-sensor-ddd-conformance.ts — ADVISORY domain-conformance sensor (ddd plugin).
//
// Reads the machine-readable conformance report the ddd-conformance gate stage emits
// (ddd-conformance-report.json) and reports any recorded violation. ADVISORY: the framework has no
// blocking sensor severity yet, so a failure is reported, not enforced — the ddd-conformance gate
// stage runs the generated tests and is the hard gate. Self-contained: no import of the framework's
// aidlc-lib (a plugin tool ships in its own delta). Shipped to {{HARNESS_DIR}}/tools/ via the
// plugin's contributes.tools.
import { existsSync, readFileSync } from "node:fs";

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Violation {
  rule_id?: string;
  kind?: string;
  scope?: string;
  detail?: string;
}

interface Result {
  pass: boolean;
  findings_count: number;
  violations: string[];
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
  process.stderr.write(`aidlc-sensor-ddd-conformance: ${msg}\n`);
  process.exit(1);
}

// The dispatcher fires on EVERY write under the record dir (matches glob), not only this sensor's
// JSON, so most fires are for some other artifact and must report a clean no-op rather than a finding.
function passThrough(): never {
  process.stdout.write(`${JSON.stringify({ pass: true, findings_count: 0, violations: [] })}\n`);
  process.exit(0);
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.outputPath) fail("--output-path is required");
  // Only act on this sensor's own machine-readable file; any other write is a clean pass-through.
  if (!flags.outputPath.endsWith("ddd-conformance-report.json")) passThrough();
  if (!existsSync(flags.outputPath)) passThrough();

  let parsed: { violations?: Violation[] };
  try {
    parsed = JSON.parse(readFileSync(flags.outputPath, "utf-8"));
  } catch (err) {
    fail(`failed to parse conformance report ${flags.outputPath}: ${errorMessage(err)}`);
  }

  const violations = Array.isArray(parsed.violations) ? parsed.violations : [];
  const summaries = violations.map(
    (v) => `${v.rule_id ?? "?"} [${v.kind ?? "?"}] @ ${v.scope ?? "?"}: ${v.detail ?? ""}`.trim(),
  );

  const result: Result = {
    pass: summaries.length === 0,
    findings_count: summaries.length,
    violations: summaries,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
