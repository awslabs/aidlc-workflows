// covers: scope:classic, scope:workshop, subcommand:aidlc-utility:intent-create,
// subcommand:aidlc-utility:status, subcommand:aidlc-utility:config-change,
// subcommand:aidlc-utility:scope-change, subcommand:aidlc-orchestrate:next,
// subcommand:aidlc-state:lookup

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getField,
  loadStageGraph,
  parseCheckboxes,
  setCheckbox,
  setField,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
} from "../harness/fixtures.ts";

const TOOLS = join(AIDLC_SRC, "tools");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const ORCHESTRATE = join(TOOLS, "aidlc-orchestrate.ts");
const STATE = join(TOOLS, "aidlc-state.ts");
const OPERATION_STAGES = [
  "deployment-pipeline",
  "environment-provisioning",
  "deployment-execution",
  "observability-setup",
  "incident-response",
  "performance-validation",
  "feedback-optimization",
];
const env = {
  ...process.env,
  AWS_AIDLC_DEFAULT_SCOPE: "",
  AIDLC_DISABLE_SENSORS: "0",
  AIDLC_DISABLE_LEARNINGS: "0",
  AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
};
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function run(tool: string, project: string, args: string[]) {
  const result = spawnSync(process.execPath, [tool, ...args, "--project-dir", project], {
    cwd: project,
    env,
    encoding: "utf-8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

function next(project: string): Record<string, unknown> {
  const result = runOrchestrateNext(ORCHESTRATE, project, [], { cwd: project, env });
  expect(result.status, result.out).toBe(0);
  expect(result.directive?.kind, result.out).toBe("run-stage");
  return result.directive!;
}

function legacyClassic() {
  const project = createOrchestrationTestProject();
  projects.push(project);
  // Workshop preserves the old classic membership, including all seven
  // Operation EXECUTEs. Only the state shape is downgraded, never dist data.
  run(UTILITY, project, ["intent-create", "--scope", "workshop", "--arguments", "in-flight classic upgrade", "--label", "classic-upgrade"]);
  const path = stateFilePath(project);
  let content = readFileSync(path, "utf-8");
  content = setField(content, "Scope", "classic");
  content = setField(content, "Change Control", "relaxed (from scope classic)");
  content = setField(content, "Review Override", "");
  content = setField(content, "Test Strategy", "Standard");
  content = content.replace(/^- \*\*(Sensors|Learnings|Summary Confirmation)\*\*:.*\n/gm, "");
  // Seed completed history through the end of Construction with the same state
  // helpers as existing deterministic routing fixtures. CI Pipeline is already
  // complete so the next-stage lookup after Build and Test reaches Operation.
  const planned = new Map(parseCheckboxes(content).map((entry) => [entry.slug, entry]));
  for (const stage of loadStageGraph()) {
    if (stage.phase !== "operation" && planned.get(stage.slug)?.suffix === "EXECUTE") {
      content = setCheckbox(content, stage.slug, "completed");
    }
  }
  for (const [field, value] of [
    ["Current Stage", "build-and-test"],
    ["Last Completed Stage", "build-and-test"],
    ["Next Stage", "deployment-pipeline"],
    ["Lifecycle Phase", "CONSTRUCTION"],
    ["Status", "Running"],
  ]) content = setField(content, field, value);
  writeFileSync(path, content);
  return { project, path, content };
}

describe("t339 upgrading an in-flight classic intent", () => {
  test("routing, lookup, and status retain recorded Operation membership", () => {
    const { project, path, content } = legacyClassic();
    const recorded = parseCheckboxes(content).filter((entry) => OPERATION_STAGES.includes(entry.slug));
    expect(recorded.map((entry) => entry.slug)).toEqual(OPERATION_STAGES);
    expect(recorded.every((entry) => entry.suffix === "EXECUTE")).toBe(true);

    const directive = next(project);
    expect(directive.stage).toBe("deployment-pipeline");
    expect(run(STATE, project, ["lookup", "next-stage", "build-and-test", "classic"]).trim()).toBe("deployment-pipeline");
    const status = run(UTILITY, project, ["status"]);
    expect(status).toMatch(/^\s*OPERATION\s+\S+\s+0\/7$/m);
    expect(status).toContain("Next Stage:     deployment-pipeline\n");
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  test("missing ceremony rows adopt new defaults and one config update restores ceremonies", () => {
    const { project, path } = legacyClassic();
    const status = run(UTILITY, project, ["status"]);
    for (const field of ["Sensors", "Learnings", "Summary Confirmation"]) {
      expect(status).toContain(`${field}: off (from scope classic)\n`);
      expect(getField(readFileSync(path, "utf-8"), field)).toBeNull();
    }
    expect(next(project).ceremony).toEqual({ sensors: "off", learnings: "off", summary_confirmation: "off" });

    run(UTILITY, project, ["config-change", "--sensors", "on", "--learnings", "on", "--summary-confirmation", "on"]);
    for (const field of ["Sensors", "Learnings", "Summary Confirmation"]) {
      expect(getField(readFileSync(path, "utf-8"), field)).toBe("on (set by you)");
    }
    const restored = next(project);
    expect(restored.stage).toBe("deployment-pipeline");
    expect(restored.ceremony).toEqual({ sensors: "on", learnings: "on", summary_confirmation: "on" });
    expect(restored.sensors_applicable).toEqual(["required-sections", "upstream-coverage"]);
    expect(restored.protocol_modules).toContain("learnings");
  });

  test("classic reviewer cap wins over an advisory override until scope changes to workshop", () => {
    const { project, path } = legacyClassic();
    run(UTILITY, project, ["config-change", "--review", "advisory"]);
    expect(getField(readFileSync(path, "utf-8"), "Review Override")).toBe("advisory");
    // Revisit a reviewer-bearing stage without asking an isolated runner, which
    // deliberately ignores the active intent's saved overrides.
    let content = setCheckbox(readFileSync(path, "utf-8"), "requirements-analysis", "in-progress");
    for (const [field, value] of [
      ["Current Stage", "requirements-analysis"],
      ["Lifecycle Phase", "INCEPTION"],
      ["Last Completed Stage", "practices-discovery"],
      ["Next Stage", "user-stories"],
    ]) content = setField(content, field, value);
    writeFileSync(path, content);
    const classic = next(project);
    expect(classic.stage).toBe("requirements-analysis");
    expect(classic.reviewer).toBeUndefined();
    expect(classic.review_class).toBeUndefined();

    run(UTILITY, project, ["scope-change", "--scope", "workshop"]);
    const workshop = next(project);
    expect(workshop.stage).toBe("requirements-analysis");
    expect(workshop.reviewer).toBe("aidlc-product-lead-agent");
    expect(workshop.review_class).toBe("advisory");
    expect(getField(readFileSync(path, "utf-8"), "Review Override")).toBe("advisory");
  });
});
