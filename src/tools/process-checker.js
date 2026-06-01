#!/usr/bin/env node
/**
 * process-checker.js — Verifies artifacts and contributions for the current active stage.
 *
 * Only checks the current active stage (not complete, not pending).
 * Checks:
 *   1. If outputs declared, do the files exist on disk?
 *   2. If contributions declared and stage is past the contribution step, did all contributors contribute?
 *
 * If there's nothing to check, says so and passes.
 *
 * Usage:
 *   node process-checker.js <intent-dir>
 *
 * Exit codes:
 *   0 — PASS
 *   1 — FAIL
 *   2 — ERROR (missing files, bad arguments)
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node process-checker.js <intent-dir>");
  process.exit(2);
}

const intentDir = args[0];
const stateFile = path.join(intentDir, "state", "state.json");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function fileExists(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

// --- Main ---

const failures = [];
const details = [];

const state = readJson(stateFile);
if (!state) {
  console.log(JSON.stringify({ status: "FAIL", failures: ["state.json missing or invalid"], details: [] }, null, 2));
  process.exit(1);
}

// Find the current active stage (not pending, not complete)
const activeStage = state.stages.find(s => s.status !== "pending" && s.status !== "complete");

if (!activeStage) {
  const allComplete = state.stages.every(s => s.status === "complete");
  if (allComplete) {
    console.log(JSON.stringify({ status: "PASS", failures: [], details: ["All stages complete"] }, null, 2));
  } else {
    console.log(JSON.stringify({ status: "PASS", failures: [], details: ["No active stage — nothing to check"] }, null, 2));
  }
  process.exit(0);
}

details.push(`Active stage: '${activeStage.stage}' at '${activeStage.status}'`);

// 1. If outputs declared, verify files exist on disk
if (activeStage.outputs && activeStage.outputs.length > 0) {
  for (const output of activeStage.outputs) {
    const outputPath = path.join(intentDir, output.locationRelativeToIntentRoot, output.name);
    if (!fileExists(outputPath)) {
      failures.push(`Output '${output.name}' at '${output.locationRelativeToIntentRoot}' missing or empty`);
    } else {
      details.push(`Output '${output.name}' exists`);
    }
  }
}

// 2. If contributions declared and stage is past the contribution step, verify all contributed
if (activeStage.contributions && activeStage.contributions.length > 0 && ["refined", "presented", "changes-requested", "complete"].includes(activeStage.status)) {
  for (const contribution of activeStage.contributions) {
    if (contribution.contributed) {
      details.push(`${contribution.persona} contributed`);
    } else {
      failures.push(`${contribution.persona} has not contributed but stage is at '${activeStage.status}'`);
    }
  }
}

// Nothing to check yet
if (failures.length === 0 && details.length === 1) {
  details.push("Nothing to check at this status");
}

const result = {
  status: failures.length === 0 ? "PASS" : "FAIL",
  stage: activeStage.stage,
  failures,
  details,
};

console.log(JSON.stringify(result, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
