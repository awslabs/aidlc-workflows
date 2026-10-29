#!/usr/bin/env bun
/**
 * aidlc-sensor-mabl-coverage-threshold.ts
 *
 * Advisory sensor for the mabl-verification plugin.
 * Reads the JSON summary from mabl-verification-coverage-report.md and reports
 * whether critical or normal coverage gaps exist.
 *
 * Exit 0 + JSON stdout = sensor result.
 * Degrades gracefully when input file is absent (reports pass with 0 flows).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface CoverageSummary {
  total_flows: number;
  covered: number;
  weakly_covered: number;
  uncovered: number;
  gaps: Array<{
    flow: string;
    severity: "critical" | "normal" | "low";
    recommendation: "author" | "defer" | "none";
    authored_test_id: string | null;
    has_test: boolean;
  }>;
  gap_found: boolean;
  critical_gap_count: number;
  ship_blocker: boolean;
}

function findJsonBlock(content: string): CoverageSummary | null {
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

  outputPath = outputPath || process.env.AIDLC_OUTPUT_PATH || "";
  stageSlug = stageSlug || process.env.AIDLC_STAGE_SLUG || "";

  const reportPath = join(outputPath, "mabl-verification-coverage-report.md");

  if (!existsSync(reportPath)) {
    // No coverage report means the coverage-gap stage hasn't run —
    // degrade gracefully, no findings.
    const result = {
      pass: true,
      findings_count: 0,
      total_flows: 0,
      covered: 0,
      uncovered: 0,
      critical_gap_count: 0,
      ship_blocker: false,
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  const content = readFileSync(reportPath, "utf-8");
  const summary = findJsonBlock(content);

  if (!summary) {
    // File exists but no parseable JSON — report as a finding
    const result = {
      pass: false,
      findings_count: 1,
      total_flows: 0,
      covered: 0,
      uncovered: 0,
      critical_gap_count: 0,
      ship_blocker: false,
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  // Count actionable gaps (critical/normal without a test)
  const actionableGaps = summary.gaps.filter(
    (g) =>
      (g.severity === "critical" || g.severity === "normal") &&
      !g.has_test &&
      g.recommendation !== "none"
  );

  const criticalGaps = summary.gaps.filter(
    (g) => g.severity === "critical" && !g.has_test
  );

  const pass = criticalGaps.length === 0;

  const result = {
    pass,
    findings_count: actionableGaps.length,
    total_flows: summary.total_flows,
    covered: summary.covered,
    uncovered: summary.uncovered,
    critical_gap_count: criticalGaps.length,
    ship_blocker: summary.ship_blocker ?? criticalGaps.length > 0,
  };

  console.log(JSON.stringify(result));
  process.exit(0);
}

main();
