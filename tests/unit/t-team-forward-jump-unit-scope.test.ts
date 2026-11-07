// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-jump:execute, subcommand:aidlc-state:skip, audit:UNIT_SKIPPED, audit:STAGE_JUMPED, audit:STAGE_SKIPPED

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv, runOrchestrateNext, seedAidlcMemory, seedBoltDag,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject, parseCheckboxes,
  readAuditShardEvents, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const BLOCK = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};
delete ENV.AWS_AIDLC_DEFAULT_SCOPE;

type Directive = Record<string, unknown> & {
  kind?: string; stage?: string; unit?: string; gate?: boolean; message?: string;
};

function project(ownership: "solo" | "team", documents: string[]): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: team forward jump scope
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: ${ownership}
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Plan Approval**: off (set by you)
- **Review Override**: none
- **Change Control**: strict
- **Unit Gate Rhythm**: per-stage
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${BLOCK.map((slug) => `- [${slug === "functional-design" ? "-" : " "}] ${slug} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  for (const slug of documents) cover(p, "alpha", slug);
  return p;
}

function cover(p: string, unit: string, slug: string): void {
  const stage = findStageBySlug(slug)!;
  const dir = join(seededRecordDir(p), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${unit} ${name}\n`);
  if (stage.workspace_requires) {
    writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
      stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
    }));
  }
  const fingerprint = reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true });
  expect(fingerprint).not.toBeNull();
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: slug, Unit: unit, Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
    "Artifact Fingerprint": fingerprint!,
  }, p);
}

function tool(p: string, name: string, args: string[]) {
  const run = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    cwd: p, encoding: "utf-8", env: ENV,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: `${name} ${args[0]}` }),
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, out: `${run.stdout}${run.stderr}` };
}

function next(p: string, args: string[] = []): Directive {
  const run = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, args, { cwd: p, env: ENV });
  expect(run.directive, run.out).not.toBeNull();
  return run.directive as Directive;
}

const rows = (p: string, event: string) => readAuditShardEvents(p)
  .filter((row) => row.event === event)
  .map((row) => ({ stage: auditBlockField(row.block, "Stage"), unit: auditBlockField(row.block, "Unit"), block: row.block }));
const marks = (p: string) =>
  Object.fromEntries(parseCheckboxes(readFileSync(seededStateFile(p), "utf-8"))
    .filter((row) => BLOCK.includes(row.slug)).map((row) => [row.slug, row.state]));

function printedJump(directive: Directive): string {
  expect(directive.kind, JSON.stringify(directive)).toBe("print");
  const command = /`[^`]*aidlc-jump\.ts (execute [^`]+)`/.exec(String(directive.message))?.[1];
  expect(command, String(directive.message)).toBeDefined();
  return command!;
}

function approveUnitStage(p: string, stage: string, unit: string): void {
  expect(tool(p, "orchestrate", ["report", "--stage", stage, "--unit", unit, "--result", "awaiting-approval"]).status).toBe(0);
  const approved = tool(p, "orchestrate", [
    "report", "--stage", stage, "--unit", unit, "--result", "approved", "--user-input", "Approve",
  ]);
  expect(approved.status, approved.out).toBe(0);
}

describe("t-team-forward-jump-unit-scope: a team main's forward jump names the Unit it moves", () => {
  test("with the first Unit's documents written, the jump moves that Unit on and leaves the later Unit's design stages unmarked", () => {
    const p = project("team", ["functional-design"]);
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha", gate: true });
    const command = printedJump(next(p, ["--stage", "code-generation"]));
    expect(command).toBe(
      "execute --target code-generation --direction forward --units alpha " +
        "--stages nfr-requirements,nfr-design,infrastructure-design --scope feature",
    );
    const ran = tool(p, "jump", command.split(" "));
    expect(ran.status, ran.out).toBe(0);
    expect(JSON.parse(ran.stdout)).toMatchObject({
      direction: "forward", target: "code-generation", units: ["alpha"],
      stages_skipped: ["nfr-requirements", "nfr-design", "infrastructure-design"], stages_reset: [],
    });
    expect(marks(p)).toEqual({
      "functional-design": "in-progress", "nfr-requirements": "pending", "nfr-design": "pending",
      "infrastructure-design": "pending", "code-generation": "pending",
    });
    expect(rows(p, "STAGE_JUMPED")).toHaveLength(0);
    expect(rows(p, "STAGE_SKIPPED")).toHaveLength(0);
    const skipped = rows(p, "UNIT_SKIPPED");
    expect(skipped.map((row) => row.stage)).toEqual(["nfr-requirements", "nfr-design", "infrastructure-design"]);
    expect(skipped.map((row) => row.unit)).toEqual(["alpha", "alpha", "alpha"]);
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha", gate: true });
    approveUnitStage(p, "functional-design", "alpha");
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha", gate: false });
    cover(p, "alpha", "code-generation");
    approveUnitStage(p, "code-generation", "alpha");
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "beta", gate: false });
    expect(marks(p)["functional-design"]).toBe("in-progress");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the same documents in a solo workflow name the same command, so the one-Unit jump is unchanged", () => {
    const solo = project("solo", ["functional-design"]);
    const team = project("team", ["functional-design"]);
    const soloCommand = printedJump(next(solo, ["--stage", "code-generation"]));
    const teamCommand = printedJump(next(team, ["--stage", "code-generation"]));
    expect(teamCommand).toBe(soloCommand);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("every unit asked for keeps the stage-wide jump, which marks the design stages for the workflow", () => {
    const p = project("team", ["functional-design"]);
    const step = next(p, ["--stage", "code-generation", "--every-unit"]);
    expect(step).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
    expect(marks(p)).toEqual({
      "functional-design": "skipped", "nfr-requirements": "skipped", "nfr-design": "skipped",
      "infrastructure-design": "skipped", "code-generation": "pending",
    });
    expect(rows(p, "STAGE_JUMPED")).toHaveLength(1);
    expect(rows(p, "STAGE_SKIPPED").map((row) => row.stage).sort())
      .toEqual(["functional-design", "infrastructure-design", "nfr-design", "nfr-requirements"]);
    expect(rows(p, "UNIT_SKIPPED")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("with no Unit's documents written yet, the jump keeps its stage-wide form", () => {
    for (const ownership of ["solo", "team"] as const) {
      const p = project(ownership, []);
      const step = next(p, ["--stage", "code-generation"]);
      expect(step, ownership).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
      expect(marks(p), ownership).toEqual({
        "functional-design": "skipped", "nfr-requirements": "skipped", "nfr-design": "skipped",
        "infrastructure-design": "skipped",
        "code-generation": ownership === "solo" ? "in-progress" : "pending",
      });
      expect(rows(p, "STAGE_JUMPED"), ownership).toHaveLength(1);
      expect(rows(p, "STAGE_SKIPPED").map((row) => row.stage).sort(), ownership)
        .toEqual(["functional-design", "infrastructure-design", "nfr-design", "nfr-requirements"]);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
