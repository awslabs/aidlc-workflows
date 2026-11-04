// Fixture for changing a team-owned intent's Unit plan in the middle of
// Construction (tests/integration/t-team-unit-replan-*.test.ts): a team main
// whose Inception is done, the move back to Units Generation, a revised Unit
// DAG, and the re-approval of Units Generation and Delivery Planning through
// the engine's own review request and gate reports.

import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, seededRecordDir, seededStateFile } from "./fixtures.ts";
import { git, makeSeed, ORCH, parallelDependencyBody, runMergeTool } from "./team-unit-merge.ts";

export const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
export const UNITS_GENERATION_REVIEWER = "aidlc-architecture-reviewer-agent";

export type PlannedUnit = { name: string; depends_on: string[]; kind?: string };

// Inception done, as main has it once Construction started. Contract Design
// is off the plan so Units Generation's approval leads to Delivery Planning.
const INCEPTION_BLOCK = "### INCEPTION PHASE\n" +
  "- [x] requirements-analysis — EXECUTE\n" +
  "- [x] user-stories — EXECUTE\n" +
  "- [x] domain-design — EXECUTE\n" +
  "- [x] units-generation — EXECUTE\n" +
  "- [S] contract-design — SKIP\n" +
  "- [x] delivery-planning — EXECUTE\n\n";

export function unitsGenerationDir(checkout: string): string {
  return join(seededRecordDir(checkout), "inception", "units-generation");
}

export function dagBody(units: PlannedUnit[]): string {
  const entries = units.map((unit) =>
    `  - name: ${unit.name}\n` +
    (unit.kind ? `    kind: ${unit.kind}\n` : "") +
    `    depends_on: [${unit.depends_on.join(", ")}]\n`
  ).join("");
  return `# Unit dependencies\n\n\`\`\`yaml\nunits:\n${entries}\`\`\`\n`;
}

/** Units Generation's documents for a plan: the DAG, the Units and their stories. */
export function writeUnitPlan(checkout: string, units: PlannedUnit[], stories: Record<string, string[]> = {}): void {
  const dir = unitsGenerationDir(checkout);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "unit-of-work-dependency.md"), dagBody(units));
  writeFileSync(
    join(dir, "unit-of-work.md"),
    `# Units of Work\n\n${units.map((unit) => `## ${unit.name}\n\nBuilds ${unit.name}.\n`).join("\n")}`,
  );
  writeFileSync(
    join(dir, "unit-of-work-story-map.md"),
    "# Story Map\n\n| unit | stories |\n| --- | --- |\n" +
      units.map((unit) => `| ${unit.name} | ${(stories[unit.name] ?? [`US-${unit.name}`]).join(", ")} |`).join("\n") + "\n",
  );
  writeFileSync(join(dir, "traceability.md"), "# Traceability\n\nEvery story maps to one Unit.\n");
}

/**
 * Records a done Inception in a seed's state (Units Generation's documents
 * too), committed and pushed. Works on any team seed, `makePrSeed`'s included.
 */
export function addDoneInception(seed: string, skeletonStance: "on" | "off" = "off"): void {
  const statePath = seededStateFile(seed);
  // A main past its first Construction stage has recorded its walking-skeleton
  // stance; without it `next` asks for the stance instead of walking the Units.
  let state = readFileSync(statePath, "utf-8").replace("## Stage Progress\n\n", `## Stage Progress\n\n${INCEPTION_BLOCK}`);
  if (!state.includes("**Skeleton Stance**")) {
    state = state.replace("## Project Information\n", `## Project Information\n- **Skeleton Stance**: ${skeletonStance}\n`);
  }
  writeFileSync(statePath, state);
  // The engine's per-checkout records a jump and the gate reports write; the
  // shipped template ignores all of .aidlc-engine/, the team seed only some.
  const ignore = join(seed, ".gitignore");
  writeFileSync(
    ignore,
    readFileSync(ignore, "utf-8") +
      "**/.aidlc-engine/state-writes.json\n**/.aidlc-engine/engine-touch\n**/.aidlc-engine/active-directive.json\n",
  );
  const dir = unitsGenerationDir(seed);
  mkdirSync(dir, { recursive: true });
  for (const name of ["unit-of-work.md", "unit-of-work-story-map.md", "traceability.md"]) {
    writeFileSync(join(dir, name), "# Units\n\nThe Units in unit-of-work-dependency.md.\n");
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "Inception done"]);
  git(seed, ["push", "origin", git(seed, ["branch", "--show-current"])]);
}

/**
 * A team main (skeleton landed with the seed) whose state also records a done
 * Inception and its skeleton stance (off unless asked), pushed. `dependencies`
 * is the Unit DAG it starts with; alpha and beta both wait only on the skeleton
 * by default.
 */
export function makeReplanSeed(
  dependencies = parallelDependencyBody(),
  skeletonStance: "on" | "off" = "off",
): { seed: string; remote: string } {
  const { seed, remote } = makeSeed(dependencies);
  addDoneInception(seed, skeletonStance);
  return { seed, remote };
}

/** `next --stage units-generation` on main, as the person asks for it. */
export function reopenUnitsGeneration(main: string): { status: number; stdout: string; out: string } {
  return runMergeTool(ORCH, ["next", "--stage", "units-generation"], main);
}

/** A reviewer's READY pass on a stage, through the engine's review request. */
export function reviewReady(checkout: string, stage: string, reviewer = UNITS_GENERATION_REVIEWER): void {
  const ask = () => runMergeTool(LOG, ["review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1"], checkout);
  let request = ask();
  // The stage's checks may speak first; asking again records the request.
  if (request.status === 0 && JSON.parse(request.stdout).kind === "print") request = ask();
  expect(request.status, request.out).toBe(0);
  const file = JSON.parse(request.stdout).reviewFile as string;
  expect(file, request.out).toBeTruthy();
  writeFileSync(
    file.startsWith("/") ? file : join(checkout, file),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n",
  );
  const done = runMergeTool(
    LOG,
    ["review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1", "--verdict", "READY"],
    checkout,
  );
  expect(done.status, done.out).toBe(0);
}

/** Units Generation reviewed, put to the person and approved. */
export function approveUnitsGeneration(main: string): Record<string, unknown> {
  reviewReady(main, "units-generation");
  const awaiting = runMergeTool(ORCH, ["report", "--stage", "units-generation", "--result", "awaiting-approval"], main);
  expect(awaiting.status, awaiting.out).toBe(0);
  const approved = runMergeTool(
    ORCH,
    ["report", "--stage", "units-generation", "--result", "approved", "--user-input", "Approve"],
    main,
  );
  expect(approved.status, approved.out).toBe(0);
  return JSON.parse(approved.stdout);
}

/** Delivery Planning (no reviewer) written and approved. */
export function approveDeliveryPlanning(main: string): Record<string, unknown> {
  const dir = join(seededRecordDir(main), "inception", "delivery-planning");
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "bolt-plan.md",
    "team-allocation.md",
    "risk-and-sequencing-rationale.md",
    "external-dependency-map.md",
    "delivery-planning-questions.md",
  ]) writeFileSync(join(dir, name), `# ${name}\n\nPlanned.\n`);
  runMergeTool(ORCH, ["report", "--stage", "delivery-planning", "--result", "awaiting-approval"], main);
  const approved = runMergeTool(
    ORCH,
    ["report", "--stage", "delivery-planning", "--result", "approved", "--user-input", "Approve"],
    main,
  );
  expect(approved.status, approved.out).toBe(0);
  return JSON.parse(approved.stdout);
}

/**
 * The whole change on main: back to Units Generation, the revised plan,
 * Units Generation and Delivery Planning approved, committed and pushed.
 */
export function replan(main: string, units: PlannedUnit[], stories: Record<string, string[]> = {}): void {
  const reopened = reopenUnitsGeneration(main);
  expect(reopened.status, reopened.out).toBe(0);
  writeUnitPlan(main, units, stories);
  approveUnitsGeneration(main);
  approveDeliveryPlanning(main);
  git(main, ["add", "-A"]);
  git(main, ["commit", "-m", "Revised Unit plan"]);
  git(main, ["push", "origin", "main"]);
}

/** A Stage Progress line, e.g. "- [x] units-generation — EXECUTE". */
export function stageLine(checkout: string, stage: string): string {
  return readFileSync(seededStateFile(checkout), "utf-8").split("\n")
    .find((line) => line.includes(`] ${stage} `)) ?? "";
}

export function currentStage(checkout: string): string {
  return /\*\*Current Stage\*\*: (\S+)/.exec(readFileSync(seededStateFile(checkout), "utf-8"))?.[1] ?? "";
}

/** The plan with gamma added after alpha: alpha and beta wait on the skeleton. */
export const PLAN_WITH_GAMMA: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: ["skeleton"] },
  { name: "beta", depends_on: ["skeleton"] },
  { name: "gamma", depends_on: ["alpha"] },
];
