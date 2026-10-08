// covers: subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:recompose, function:usesStageLevelPerUnitArtifacts
//
// #1401: a scope change (or recompose) with Unit work in flight. The person
// asked for the new plan, so the change always goes through, under any Unit
// Ownership and Guard Policy. Unit work the new plan keeps carries on per
// Unit, and Unit work at a stage the new plan drops is named in one line.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  activeIntentUuid,
  claimRegistryCachePath,
  getField,
  latestMainWorkflowStageRunFloorForProject,
  loadStageGraph,
  readAllAuditShards,
  setCheckbox,
  setField,
  setStageSuffix,
  usesStageLevelPerUnitArtifacts,
  writeUnitClaimRegistryCache,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seedBoltDag,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();
const projects: string[] = [];
afterEach(() => { while (projects.length) cleanupTestProject(projects.pop()); });
const stage = "nfr-requirements";
const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
const DROPPED = "no longer part of the plan";

// A feature run in Construction: Units Generation ran (alpha and beta), the
// cursor reads functional-design, and later stages have not started.
function fixture(ownership = "team", iteration = "unit-major", dag = true): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  const stages = loadStageGraph().map((node) => {
    const box = node.slug === "functional-design" ? "-"
      : node.phase === "construction" || node.phase === "operation" ? " "
      : node.slug === "units-generation" && !dag ? " " : "x";
    const action = node.slug === "units-generation" && !dag ? "SKIP" : "EXECUTE";
    return `- [${box}] ${node.slug} \u2014 ${action}`;
  }).join("\n");
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Unit plan safety
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: ${iteration}
- **Unit Ownership**: ${ownership}
- **Unit Gate Rhythm**: per-stage

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Total Stages**: 33
- **Completed**: 0

## Stage Progress
<!-- Checkbox states: [ ] not started -->
${stages}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-09-25T00:00:00Z
`);
  if (dag) seedBoltDag(proj, ["alpha", "beta"]);
  return proj;
}
const state = (p: string) => readFileSync(seededStateFile(p), "utf8");
const putState = (p: string, content: string) => writeFileSync(seededStateFile(p), content);
function lifecycle(p: string, event: "UNIT_STARTED" | "UNIT_PAUSED" | "UNIT_RESUMED" | "UNIT_COMPLETED" | "UNIT_SKIPPED", unit = "alpha", slug = stage) {
  const content = state(p);
  appendAuditEntry(event, {
    Stage: slug, Unit: unit, Reason: "fixture conditional work",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug,
      getField(content, "Construction Iteration") === "unit-major",
      getField(content, "Unit Ownership") === "team" ? unit : undefined),
  }, p);
}
function gate(p: string, event: "STAGE_AWAITING_APPROVAL" | "STAGE_REVISING" | "GATE_REJECTED" | "GATE_APPROVED", unit = "alpha", scope = "per-stage", slug = stage) {
  appendAuditEntry(event, { Stage: slug, Unit: unit, "Gate Scope": scope }, p);
}
function command(p: string, args: string[], tool = join(AIDLC_SRC, "tools", "aidlc-utility.ts"), extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [tool, ...args, "--project-dir", p], {
    encoding: "utf8", env: { ...env, ...extraEnv }, timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  return { status: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
}
// The person's switch: it always goes through and the reply says so.
function switchTo(p: string, scope = "refactor", extra: string[] = [], tool?: string): string {
  const result = command(p, ["scope-change", "--scope", scope, ...extra], tool);
  expect(result.status, result.output).toBe(0);
  expect(result.stdout).toContain(`Switched to ${scope}`);
  expect(state(p)).toContain(`- **Scope**: ${scope}`);
  return result.stdout;
}
function next(p: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), "next", "--project-dir", p], {
    encoding: "utf8", env, timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  const line = result.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  expect(line, result.stdout + result.stderr).toBeDefined();
  return JSON.parse(line!) as Record<string, unknown>;
}

describe("the switch goes through and names the Unit work it drops", () => {
  for (const ownership of ["team", "solo"]) {
    for (const iteration of ownership === "team" ? ["unit-major"] : ["unit-major", "stage-major"]) {
      for (const event of ["UNIT_STARTED", "UNIT_PAUSED", "UNIT_RESUMED"] as const) {
        test(`${ownership}/${iteration} names ${event} work on a later Unit`, () => {
          const p = fixture(ownership, iteration);
          lifecycle(p, "UNIT_COMPLETED", "alpha");
          if (ownership === "team") gate(p, "GATE_APPROVED", "alpha");
          lifecycle(p, event, "beta");
          const out = switchTo(p);
          expect(out).toContain(`The beta Unit's NFR Requirements work is ${DROPPED}.`);
          expect(out).not.toContain("alpha Unit");
        });
      }
    }
  }
  for (const scope of ["per-stage", "unit-end"]) {
    for (const event of ["STAGE_AWAITING_APPROVAL", "STAGE_REVISING", "GATE_REJECTED"] as const) {
      test(`a ${scope} ${event} gate is named even when the aggregate box reads completed`, () => {
        const p = fixture();
        putState(p, setCheckbox(state(p), stage, "completed"));
        gate(p, event, "beta", scope);
        expect(switchTo(p)).toContain(`The beta Unit's NFR Requirements approval is ${DROPPED}.`);
      });
    }
  }
  test("several dropped items read as one line", () => {
    const p = fixture();
    lifecycle(p, "UNIT_STARTED", "alpha");
    gate(p, "STAGE_AWAITING_APPROVAL", "beta");
    expect(switchTo(p)).toContain(
      `The alpha Unit's NFR Requirements work and the beta Unit's NFR Requirements approval are ${DROPPED}.`,
    );
  });
  test("a hand-edited Unit Progress table does not hide a real gate", () => {
    const p = fixture();
    putState(p, `${state(p)}\n## Unit Progress\n| unit | nfr-requirements | gate |\n| --- | --- | --- |\n| alpha | [x] | [x] |\n`);
    gate(p, "STAGE_AWAITING_APPROVAL");
    expect(switchTo(p)).toContain(`The alpha Unit's NFR Requirements approval is ${DROPPED}.`);
  });
  test("a Unit no longer in the DAG with an open gate is still named", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL", "removed-unit");
    expect(switchTo(p)).toContain(`The removed unit Unit's NFR Requirements approval is ${DROPPED}.`);
  });
  test("settled and conditionally skipped Unit work leaves no line", () => {
    const team = fixture();
    for (const unit of ["alpha", "beta"]) {
      lifecycle(team, "UNIT_COMPLETED", unit);
      gate(team, "GATE_APPROVED", unit);
    }
    expect(switchTo(team)).not.toContain(DROPPED);
    const solo = fixture("solo");
    lifecycle(solo, "UNIT_SKIPPED");
    lifecycle(solo, "UNIT_SKIPPED", "beta");
    expect(switchTo(solo)).not.toContain(DROPPED);
  });
  for (const event of ["WORKFLOW_STARTED", "STAGE_JUMPED"] as const) {
    test(`work before a ${event} boundary is not named`, () => {
      const p = fixture();
      lifecycle(p, "UNIT_PAUSED");
      gate(p, "STAGE_AWAITING_APPROVAL");
      appendAuditEntry(event, { Stage: stage, Scope: "feature", Direction: "redo" }, p);
      expect(switchTo(p)).not.toContain(DROPPED);
    });
  }
  test("a change that keeps the Unit's stage leaves its open gate as it was", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL");
    const out = switchTo(p, "mvp");
    expect(out).not.toContain(DROPPED);
    expect(readAllAuditShards(p).match(/\*\*Event\*\*: SCOPE_CHANGED/g)).toHaveLength(1);
    expect(readAllAuditShards(p)).toContain("STAGE_AWAITING_APPROVAL");
  });
  test("the same scope is a byte-identical no-op even with an open Unit gate", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL");
    const before = state(p), audit = readAllAuditShards(p);
    expect(command(p, ["scope-change", "--scope", "feature"]).status).toBe(0);
    expect(state(p)).toBe(before);
    expect(readAllAuditShards(p)).toBe(audit);
  });
});

describe("the Units carry on per Unit after the switch (#1401)", () => {
  test.each(["team", "solo"])("%s: next keeps walking the Units that Units Generation made", (ownership) => {
    const p = fixture(ownership);
    gate(p, "STAGE_AWAITING_APPROVAL", "beta");
    switchTo(p);
    // On main this fell back to one stage-level step that no Unit gate reads.
    const directive = next(p);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
    expect((directive.produces as string[])[0]).toContain("/construction/alpha/functional-design/");
  });
  test("a recompose that skips Units Generation keeps the Units too", () => {
    const p = fixture();
    putState(p, setStageSuffix(state(p), "units-generation", "SKIP"));
    expect(usesStageLevelPerUnitArtifacts("feature", state(p))).toBe(false);
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
  });
  test("a run whose Units Generation never ran keeps its stage-level path", () => {
    const p = fixture("solo", "stage-major", false);
    expect(usesStageLevelPerUnitArtifacts("feature", state(p))).toBe(true);
    switchTo(p);
    const directive = next(p);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    expect(directive.unit).toBeUndefined();
    expect((directive.produces as string[])[0]).toContain("/construction/functional-design/");
  });
  test("fully completed team Construction switches without a line", () => {
    const p = fixture();
    let content = state(p);
    for (const node of loadStageGraph().filter((s) => s.phase === "construction")) {
      content = setCheckbox(content, node.slug, "completed");
    }
    putState(p, setField(content, "Current Stage", "build-and-test"));
    expect(switchTo(p)).not.toContain(DROPPED);
  });
});

describe("every harness and every way in", () => {
  const harnesses = [
    ["claude", ".claude"], ["codex", ".codex"], ["copilot", ".aidlc"],
    ["cursor", ".cursor"], ["kiro", ".kiro"], ["kiro-ide", ".kiro"], ["opencode", ".aidlc"],
  ];
  for (const [harness, dir] of harnesses) {
    test(`${harness}'s generated tool switches and names the dropped approval`, () => {
      const p = fixture();
      gate(p, "STAGE_AWAITING_APPROVAL");
      const tool = join(import.meta.dir, "..", "..", "dist", harness, dir, "tools", "aidlc-utility.ts");
      expect(switchTo(p, "refactor", [], tool)).toContain(`The alpha Unit's NFR Requirements approval is ${DROPPED}.`);
    });
  }
  test("recompose skips stages with live Unit work and names it", () => {
    const p = fixture();
    // With no Operation stages on the plan, the NFR stages can leave it as a
    // group: nothing left on the plan reads them.
    let content = state(p);
    for (const node of loadStageGraph().filter((s) => s.phase === "operation")) {
      content = setStageSuffix(content, node.slug, "SKIP");
    }
    putState(p, content);
    lifecycle(p, "UNIT_STARTED");
    const result = command(p, ["recompose", "--skip", "nfr-requirements,nfr-design,infrastructure-design"]);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(`The alpha Unit's NFR Requirements work is ${DROPPED}.`);
    expect(state(p)).toContain("- [ ] nfr-requirements \u2014 SKIP");
  });
  test("settings typed with the switch are applied with it", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL");
    switchTo(p, "refactor", ["--depth", "comprehensive", "--test-strategy", "minimal"]);
    expect(state(p)).toContain("- **Depth**: Comprehensive");
  });
  test("claimed Units do not stop the switch, and no claim is fetched or refreshed", () => {
    const p = fixture();
    writeUnitClaimRegistryCache(p, {
      version: 1, space: "default", intent_uuid: activeIntentUuid(p)!,
      claims: { beta: { status: "claimed", owner: "team-b", generation: 2, nonce: "claim", ref: "refs/heads/claim/00000001/beta", oid: "a".repeat(40) } },
    });
    const cache = claimRegistryCachePath(p);
    const cachedBefore = readFileSync(cache, "utf8");
    switchTo(p);
    expect(readFileSync(cache, "utf8")).toBe(cachedBefore);
  });
  test("an unreachable origin does not stop the switch", () => {
    const p = fixture();
    spawnSync("git", ["init", "-q"], { cwd: p });
    spawnSync("git", ["remote", "add", "origin", join(p, "no-such-remote.git")], { cwd: p });
    putState(p, setField(setCheckbox(state(p), "functional-design", "pending"), "Current Stage", "delivery-planning"));
    switchTo(p);
  });
  test.each(["default", "other"])("an explicit intent in space %s is switched and named from its own record", (space) => {
    const p = fixture("solo");
    const target = "target-0000000000000002";
    const targetUuid = "00000000-0000-4000-8000-000000000002";
    const targetDir = join(p, "aidlc", "spaces", space, "intents", target);
    cpSync(seededRecordDir(p), targetDir, { recursive: true });
    const registryPath = join(dirname(targetDir), "intents.json");
    const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : [];
    writeFileSync(registryPath, JSON.stringify([...registry, { uuid: targetUuid, slug: "target", dirName: target, status: "in-flight" }]));
    const targetStatePath = join(targetDir, "aidlc-state.md");
    writeFileSync(targetStatePath, setField(state(p), "Unit Ownership", "team"));
    appendAuditEntry("STAGE_AWAITING_APPROVAL", { Stage: stage, Unit: "alpha", "Gate Scope": "per-stage" }, p, target, space);
    const unrelated = state(p);
    const result = command(p, ["scope-change", "--scope", "refactor", "--intent", target, "--space", space]);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(`The alpha Unit's NFR Requirements approval is ${DROPPED}.`);
    expect(readFileSync(targetStatePath, "utf8")).toContain("- **Scope**: refactor");
    expect(state(p)).toBe(unrelated);
  });
  test("a person-lowered Guard Policy changes nothing about the switch", () => {
    for (const policy of ["strict", "off"]) {
      const p = fixture();
      putState(p, state(p).replace("## Scope Configuration", `- **Guard Policy**: ${policy} (person)\n\n## Scope Configuration`));
      lifecycle(p, "UNIT_STARTED", "beta");
      expect(switchTo(p)).toContain(`The beta Unit's NFR Requirements work is ${DROPPED}.`);
    }
  });
  test("a damaged audit row does not stop the switch", () => {
    const p = fixture();
    const shard = join(seededAuditDir(p), "damaged.md");
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(shard, `## Unit Started\n**Event**: UNIT_STARTED\n**Stage**: ${stage}\n**Unit**: alpha\n**Run floor**: unstarted#0\n\n---\n`);
    switchTo(p);
  });
});
