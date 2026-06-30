// aidlc-sensor-requirement-coverage.ts — ADVISORY requirement-traceability gate
// (test-pro bundle).
//
// Reads test-pro-test-results.json (emitted by the build-and-test contribution)
// and reports whether every functional requirement has at least one covering
// test. ADVISORY (no blocking severity in the framework yet). Needs only the
// --output-path the dispatcher always passes. Shipped to .claude/tools/ via the
// bundle's contributes.tools.
import { existsSync, readFileSync } from "node:fs";

// Self-contained — no import of the framework's aidlc-lib (a bundle tool ships
// in its own delta and must not depend on a sibling core tool being present).
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Result {
  pass: boolean;
  findings_count: number;
  uncovered_requirements: string[];
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
  process.stderr.write(`aidlc-sensor-requirement-coverage: ${msg}\n`);
  process.exit(1);
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.outputPath) fail("--output-path is required");
  if (!existsSync(flags.outputPath)) fail(`--output-path not found: ${flags.outputPath}`);

  let parsed: { requirements?: Record<string, { covered?: boolean }> };
  try {
    parsed = JSON.parse(readFileSync(flags.outputPath, "utf-8"));
  } catch (err) {
    fail(`failed to parse results JSON ${flags.outputPath}: ${errorMessage(err)}`);
  }

  const reqs = parsed.requirements ?? {};
  const uncovered_requirements = Object.entries(reqs)
    .filter(([, v]) => v?.covered !== true)
    .map(([k]) => k)
    .sort();

  const result: Result = {
    pass: uncovered_requirements.length === 0,
    findings_count: uncovered_requirements.length,
    uncovered_requirements,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
