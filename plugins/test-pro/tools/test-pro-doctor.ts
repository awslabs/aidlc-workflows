// Reference doctor-check script for plugin authors to copy (issue #796).
// It is deterministic and read-only: inspect the composed install, then emit
// the plugin doctor JSON contract on stdout.

import { existsSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.env.AIDLC_PROJECT_DIR ?? process.cwd();
const harnessDir = process.env.AIDLC_HARNESS_DIR ?? ".claude";
const harnessRoot = join(projectDir, harnessDir);
// The person's entry in the harness this check runs in: Codex's is $aidlc.
const entry = harnessDir === ".codex" ? "$aidlc" : "/aidlc";
const fix = `Run \`${entry} plugin sync\` (or re-run the plugin's \`hooks/compose.ts\`).`;

function installed(
  relativePath: string,
  severity: "error" | "advisory",
): { pass: boolean; label: string; fix: string; severity: "error" | "advisory" } {
  return {
    pass: existsSync(join(harnessRoot, relativePath)),
    label: `${relativePath} installed`,
    fix,
    severity,
  };
}

const checks = [
  installed("tools/aidlc-sensor-coverage-threshold.ts", "error"),
  installed("tools/aidlc-sensor-requirement-coverage.ts", "error"),
  installed("sensors/aidlc-coverage-threshold.md", "error"),
  installed("sensors/aidlc-requirement-coverage.md", "error"),
  installed("scopes/test-pro-validation.md", "advisory"),
  installed("agents/test-pro-metrics-agent.md", "advisory"),
];

process.stdout.write(`${JSON.stringify({ checks })}\n`);
