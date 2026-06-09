#!/usr/bin/env node
/**
 * verifier.js — Markdown/filesystem backend verifier for the artifact repository.
 *
 * Paired with the markdown-fs adapter (conventions/artifact-repository.md). Built into
 * the distribution as tools/process-checker.js. Implements the repository's verifyStage
 * operation out-of-band: it checks PROCESS, never content quality.
 *
 * Only checks the current active stage (not complete, not pending).
 * Checks:
 *   1. If outputs declared, do the resolved files exist on disk and are non-empty?
 *   2. If contributions declared and stage is past the contribution step, did all
 *      contributors contribute?
 *
 * If there's nothing to check, says so and passes.
 *
 * State outputs are addressed by logical type, not by path. Each output is
 * { "type": "<artifact-type>", "address": { container, phase?, stage?, unit?, scope?, type } }.
 * This verifier resolves an address to a path using the same type→representation map
 * the adapter documents. To swap storage backends, swap this file together with the adapter.
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

// --- Type → representation map (mirrors conventions/artifact-repository.md) ---
// Maps an artifact type to the filename(s) it is stored under within its container.
// Collection types map to a directory; their members are checked by directory presence.
const REPRESENTATION = {
  // meta
  intent: { container: "intent-root", file: "intent.md" },
  workflow: { container: "intent-root", file: "workflow.json" },
  state: { container: "state", file: "state.json" },
  audit: { container: "audit", file: "audit.json" },
  // stage working artifacts
  plan: { file: "plan.md" },
  questions: { file: "questions.md" },
  // stage output artifacts
  requirements: { file: "requirements.md" },
  stories: { file: "stories.md" },
  personas: { file: "personas.md" },
  "screen-data-map": { file: "screen-data-map.md" },
  "screen-structure": { file: "screen-structure.md" },
  wireframes: { collection: "wireframes" },
  components: { files: ["components.yaml", "components.md"] },
  units: { file: "units.md" },
  unit: { file: "unit.md" },
  "unit-dependencies": { file: "unit-dependencies.md" },
  "unit-story-map": { file: "unit-story-map.md" },
  contracts: { collection: "contracts" },
  "contract-summary": { file: "contract-summary.md" },
  entities: { file: "entities.yaml" },
  rules: { file: "rules.yaml" },
  "api-specification": { file: "api-specification.md" },
  "functional-spec": { file: "functional-spec.md" },
  "nfr-specification": { file: "nfr-specification.md" },
  "infrastructure-specification": { file: "infrastructure-specification.md" },
  "implementation-map": { file: "implementation-map.md" },
  "business-overview": { file: "business-overview.md" },
  architecture: { file: "architecture.md" },
  "code-structure": { file: "code-structure.md" },
  "api-documentation": { file: "api-documentation.md" },
  "component-inventory": { file: "component-inventory.md" },
  "technology-stack": { file: "technology-stack.md" },
  dependencies: { file: "dependencies.md" },
};

// Resolve a stage scope (phase, stage, unit?, scope?) to a directory relative to the intent root.
function resolveScopeDir(address) {
  const parts = ["stages", address.phase];
  if (address.unit) parts.push(address.unit);
  parts.push(address.stage);
  if (address.scope) parts.push(address.scope);
  return path.join(...parts);
}

// Resolve an address to a container directory relative to the intent root.
function resolveContainerDir(address, rep) {
  const container = address.container || rep.container || "stage";
  switch (container) {
    case "intent-root":
      return ".";
    case "state":
      return "state";
    case "audit":
      return "audit";
    case "stage":
    default:
      return resolveScopeDir(address);
  }
}

// Resolve an output to the list of concrete paths (relative to intent root) that must exist.
// For a known type, derive the filename(s); for a "<persona>-contribution" / "<persona>-review"
// type, derive the filename from the type itself. Returns { paths, collectionDir }.
function resolveOutputPaths(output) {
  const address = output.address || {};
  const type = output.type || address.type;
  const rep = REPRESENTATION[type];
  const containerDir = resolveContainerDir(address, rep || {});

  if (rep && rep.collection) {
    return { paths: [], collectionDir: path.join(containerDir, rep.collection) };
  }
  let files;
  if (rep && rep.files) files = rep.files;
  else if (rep && rep.file) files = [rep.file];
  else if (type && /-(contribution|review)$/.test(type)) files = [`${type}.md`];
  else files = []; // unknown type — cannot resolve, skip with a note
  return { paths: files.map(f => path.join(containerDir, f)), collectionDir: null };
}

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

function dirHasFiles(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return false;
  return fs.readdirSync(dirPath).some(name => {
    const full = path.join(dirPath, name);
    return fs.statSync(full).isFile() && fs.statSync(full).size > 0;
  });
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

// 1. If outputs declared, verify the resolved artifacts exist
if (activeStage.outputs && activeStage.outputs.length > 0) {
  for (const output of activeStage.outputs) {
    const type = output.type || (output.address && output.address.type) || "<unknown>";
    const { paths, collectionDir } = resolveOutputPaths(output);

    if (collectionDir) {
      if (!dirHasFiles(path.join(intentDir, collectionDir))) {
        failures.push(`Output '${type}' (collection at '${collectionDir}') missing or empty`);
      } else {
        details.push(`Output '${type}' collection present`);
      }
      continue;
    }

    if (paths.length === 0) {
      details.push(`Output '${type}' has no known representation — skipped`);
      continue;
    }

    for (const rel of paths) {
      if (!fileExists(path.join(intentDir, rel))) {
        failures.push(`Output '${type}' at '${rel}' missing or empty`);
      } else {
        details.push(`Output '${type}' (${rel}) exists`);
      }
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
