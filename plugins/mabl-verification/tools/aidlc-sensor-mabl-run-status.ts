#!/usr/bin/env bun
/**
 * aidlc-sensor-mabl-run-status.ts
 *
 * Advisory sensor for the mabl-verification plugin.
 * Reads the JSON summary from mabl-verification-run-results.md or
 * mabl-verification-local-run-log.md and reports pass/fail status.
 *
 * Exit 0 + JSON stdout = sensor result.
 * Degrades gracefully when input files are absent (reports pass with 0 tests).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface SensorInput {
  output_path: string;
  stage_slug: string;
}

interface RunSummary {
  tests_matched?: number;
  tests_run?: number;
  passed?: number;
  failed?: number;
  billable_skipped?: number;
  coverage_zero_match?: boolean;
  failures?: Array<{
    testId: string;
    testRunId: string;
    class: string;
    confidence: number;
    failingStep: string;
  }>;
  // local-run-log shape
  status?: string;
  test_name?: string;
  test_id?: string;
}

function findJsonBlock(content: string): RunSummary | null {
  // Extract the last JSON code block from the markdown
  const jsonBlocks = content.match(/```json\s*\n([\s\S]*?)\n```/g);
  if (!jsonBlocks || jsonBlocks.length === 0) return null;

  const lastBlock = jsonBlocks[jsonBlocks.length - 1];
  const jsonContent = lastBlock.replace(/```json\s*\n/, "").replace(/\n```$/, "");

  try {
    return JSON.parse(jsonContent);
  } catch {
    return null;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let outputPath = "";
  let stageSlug = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-path" && args[i + 1]) outputPath = args[++i];
    if (args[i] === "--stage-slug" && args[i + 1]) stageSlug = args[++i];
  }

  // Also check env vars (common sensor invocation pattern)
  outputPath = outputPath || process.env.AIDLC_OUTPUT_PATH || "";
  stageSlug = stageSlug || process.env.AIDLC_STAGE_SLUG || "";

  // Try to find the run results or local run log
  const candidates = [
    join(outputPath, "mabl-verification-run-results.md"),
    join(outputPath, "mabl-verification-local-run-log.md"),
  ];

  let summary: RunSummary | null = null;

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, "utf-8");
      summary = findJsonBlock(content);
      if (summary) break;
    }
  }

  // Degrade gracefully when no input exists
  if (!summary) {
    const result = {
      pass: true,
      findings_count: 0,
      tests_run: 0,
      tests_passed: 0,
      tests_failed: 0,
      billable_skipped: 0,
      has_unresolved_failures: false,
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  const testsRun = summary.tests_run ?? (summary.status ? 1 : 0);
  const testsPassed = summary.passed ?? (summary.status === "pass" ? 1 : 0);
  const testsFailed = summary.failed ?? (summary.status === "fail" ? 1 : 0);
  const billableSkipped = summary.billable_skipped ?? 0;

  // Count unresolved failures (not billable-skip, not already triaged as healed)
  const unresolvedFailures = (summary.failures ?? []).filter(
    (f) => f.class === "product" || f.class === "stale-test"
  );

  const pass = testsFailed === 0 || unresolvedFailures.length === 0;

  const result = {
    pass,
    findings_count: unresolvedFailures.length,
    tests_run: testsRun,
    tests_passed: testsPassed,
    tests_failed: testsFailed,
    billable_skipped: billableSkipped,
    has_unresolved_failures: unresolvedFailures.length > 0,
  };

  console.log(JSON.stringify(result));
  process.exit(0);
}

main();
