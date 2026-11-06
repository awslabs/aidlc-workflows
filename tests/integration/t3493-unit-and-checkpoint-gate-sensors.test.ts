// covers: subcommand:aidlc-state:unit, subcommand:aidlc-bolt:checkpoint

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  latestMainWorkflowStageRunFloorForProject,
  readAllAuditShards,
  readAuditShardEvents,
  reviewArtifactFingerprint,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const PART = (name: string): string => join(AIDLC_SRC, "tools", `aidlc-${name}.ts`);
const SENSOR_ID = "unit-probe";
const STAGE = "functional-design";
const PRODUCES = ["entities", "rules", "functional-spec", "traceability"];
const CONSTRUCTION_STAGES = [
  STAGE,
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
];

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop()!);
});

function graphWithSensor(proj: string, severity: "blocking" | "advisory"): string {
  const graph = JSON.parse(
    readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8"),
  ) as Array<{
    slug: string;
    sensors?: string[];
    sensors_applicable?: Array<Record<string, string>>;
  }>;
  const stage = graph.find((entry) => entry.slug === STAGE);
  if (!stage) throw new Error(`the stage graph has no ${STAGE}`);
  stage.sensors = [...(stage.sensors ?? []), SENSOR_ID];
  stage.sensors_applicable = [
    ...(stage.sensors_applicable ?? []),
    {
      id: SENSOR_ID,
      path: `.claude/sensors/aidlc-${SENSOR_ID}.md`,
      fire_on: "gate",
      default_severity: severity,
      category: "test",
      matches: "**/traceability.json",
    },
  ];
  const path = join(proj, "stage-graph.json");
  writeFileSync(path, JSON.stringify(graph), "utf-8");
  return path;
}

function writeSensor(proj: string, pass: boolean): void {
  const sensors = join(proj, ".test-sensors");
  const scripts = join(proj, ".test-scripts");
  mkdirSync(sensors, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(sensors, `aidlc-${SENSOR_ID}.md`),
    [
      "---",
      `id: ${SENSOR_ID}`,
      "kind: deterministic",
      `command: bun .claude/tools/aidlc-sensor-${SENSOR_ID}.ts`,
      "default_severity: blocking",
      "fire_on: gate",
      "description: unit completion gate-check fixture",
      "category: test",
      'matches: "**/traceability.json"',
      `timeout_seconds: ${NATIVE_STARTUP_TIMEOUT_MS / 1000}`,
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(scripts, `aidlc-sensor-${SENSOR_ID}.ts`),
    `process.stdout.write(JSON.stringify({ pass: ${pass}, findings_count: ${pass ? 0 : 1} }) + "\\n");\n`,
    "utf-8",
  );
}

function sensorEnv(proj: string, graph: string | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_DISABLE_SENSORS: "0",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SENSORS_DIR: join(proj, ".test-sensors"),
    AIDLC_SENSOR_SCRIPT_DIR: join(proj, ".test-scripts"),
    AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: String(NATIVE_STARTUP_TIMEOUT_MS),
  };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  if (graph !== null) env.AIDLC_STAGE_GRAPH = graph;
  return env;
}

function tool(
  name: string,
  args: string[],
  proj: string,
  env: NodeJS.ProcessEnv,
): { rc: number; out: string; stdout: string } {
  const result = spawnSync(BUN, [PART(name), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { rc: result.status ?? -1, out, stdout: result.stdout ?? "" };
}

function unitProject(severity: "blocking" | "advisory" = "blocking"): { proj: string; graph: string } {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const graph = graphWithSensor(proj, severity);
  writeSensor(proj, false);
  writeFileSync(
    seededStateFile(proj),
    `# AI-DLC State Tracking

## Project Information
- **Project**: unit completion gate checks
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: solo
- **Skeleton Stance**: on
- **Construction Iteration**: unit-major

## Runtime State
- **Revision Count**: 0

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] ${STAGE} — EXECUTE
- [S] nfr-requirements — EXECUTE
- [S] nfr-design — EXECUTE
- [S] infrastructure-design — EXECUTE
- [S] code-generation — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${STAGE}
- **Status**: Running
- **Last Updated**: 2026-07-30T00:00:00Z
`,
    "utf-8",
  );
  seedBoltDag(proj, ["unit-a", "unit-b"]);
  return { proj, graph };
}

function writeUnitArtifacts(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, STAGE);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name}\nstub\n`, "utf-8");
  }
}

function sensorRows(proj: string, event: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === event);
}

describe("t3493 a Unit's completion fires the stage's blocking gate checks", () => {
  test("a failing check refuses the completion and names its finding", () => {
    const { proj, graph } = unitProject();
    const env = sensorEnv(proj, graph);
    const started = tool("state", ["unit", "start", "--stage", STAGE, "--unit", "unit-a"], proj, env);
    expect(started.rc, started.out).toBe(0);
    writeUnitArtifacts(proj, "unit-a");
    writeUnitArtifacts(proj, "unit-b");

    const refused = tool("state", ["unit", "complete", "--stage", STAGE, "--unit", "unit-a"], proj, env);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("Blocking gate sensor evaluation did not pass");
    expect(refused.out).toContain("unit-a");
    expect(refused.out).toContain(STAGE);
    expect(refused.out).toContain(`Sensors: ${SENSOR_ID}`);
    expect(refused.out).toContain("reported findings");
    expect(unitCompletedReceipts(proj, STAGE).has("unit-a")).toBe(false);

    const fired = sensorRows(proj, "SENSOR_FIRED");
    expect(fired).toHaveLength(1);
    expect(auditBlockField(fired[0].block, "Unit")).toBe("unit-a");
    expect(auditBlockField(fired[0].block, "Stage slug")).toBe(STAGE);
    expect(auditBlockField(fired[0].block, "Output path") ?? "").toContain("traceability.json");
    expect(sensorRows(proj, "SENSOR_FAILED")).toHaveLength(1);
    expect(readAllAuditShards(proj)).not.toContain("**Event**: UNIT_COMPLETED");

    writeSensor(proj, true);
    const done = tool("state", ["unit", "complete", "--stage", STAGE, "--unit", "unit-a"], proj, env);
    expect(done.rc, done.out).toBe(0);
    expect(unitCompletedReceipts(proj, STAGE).has("unit-a")).toBe(true);
    expect(sensorRows(proj, "SENSOR_PASSED")).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Sensors off, and an advisory check, leave the completion as it was", () => {
    const off = unitProject();
    const offEnv = sensorEnv(off.proj, off.graph);
    expect(tool("state", ["unit", "start", "--stage", STAGE, "--unit", "unit-a"], off.proj, offEnv).rc).toBe(0);
    writeUnitArtifacts(off.proj, "unit-a");
    writeFileSync(
      seededStateFile(off.proj),
      `${readFileSync(seededStateFile(off.proj), "utf-8")}- **Sensors**: off (set by you)\n`,
      "utf-8",
    );
    const offDone = tool("state", ["unit", "complete", "--stage", STAGE, "--unit", "unit-a"], off.proj, offEnv);
    expect(offDone.rc, offDone.out).toBe(0);
    expect(sensorRows(off.proj, "SENSOR_FIRED")).toHaveLength(0);

    const advisory = unitProject("advisory");
    const advisoryEnv = sensorEnv(advisory.proj, advisory.graph);
    expect(tool("state", ["unit", "start", "--stage", STAGE, "--unit", "unit-a"], advisory.proj, advisoryEnv).rc).toBe(0);
    writeUnitArtifacts(advisory.proj, "unit-a");
    const advisoryDone = tool("state", ["unit", "complete", "--stage", STAGE, "--unit", "unit-a"], advisory.proj, advisoryEnv);
    expect(advisoryDone.rc, advisoryDone.out).toBe(0);
    expect(unitCompletedReceipts(advisory.proj, STAGE).has("unit-a")).toBe(true);
    expect(sensorRows(advisory.proj, "SENSOR_FIRED")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

let checkpointGraph = "";

function checkpointProject(): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  checkpointGraph = graphWithSensor(proj, "blocking");
  writeSensor(proj, false);
  writeFileSync(
    seededStateFile(proj),
    `# AI-DLC State Tracking
## Project Information
- **Project**: unit checkpoint gate checks
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: none
- **Guard Policy**: relaxed
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${CONSTRUCTION_STAGES.map((slug) => `- [${slug === STAGE ? "-" : " "}] ${slug} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${STAGE}
- **Status**: Running
`,
    "utf-8",
  );
  seedBoltDag(proj, ["alpha", "beta"]);
  mkdirSync(join(proj, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) {
    writeFileSync(join(proj, "src", `${unit}.ts`), `export const ${unit} = 1;\n`, "utf-8");
  }
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, proj);
  return proj;
}

function buildUnit(proj: string, unit: string): void {
  for (const slug of CONSTRUCTION_STAGES) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(proj), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`, "utf-8");
    }
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
      }), "utf-8");
    }
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(proj, slug, true, unit),
      "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, unit, {
        requireRequiredArtifacts: true,
      })!,
    }, proj);
  }
}

function humanTurn(proj: string, prompt: string, session: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8", cwd: proj, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function recordVerificationCommand(proj: string): void {
  if (readFileSync(seededStateFile(proj), "utf-8").includes("- **Construction Verification Command**:")) return;
  const script = join(seededRecordDir(proj), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit)) process.exit(1);", "utf-8");
  const quote = (value: string): string => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t3493-command"];
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  const decision = tool("log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], proj, env);
  expect(decision.rc, decision.out).toBe(0);
  humanTurn(proj, "Approve", "t3493-command");
  for (const [name, args] of [
    ["log", ["answer", ...identity, "--details", "Approve"]],
    ["state", ["set-construction-verification-command", command]],
  ] as Array<[string, string[]]>) {
    const result = tool(name, args, proj, env);
    expect(result.rc, result.out).toBe(0);
  }
}

describe("t3493 a Unit's checkpoint fires the blocking gate checks of the stages it covers", () => {
  test("a failing check refuses the approval; fixing it lets the person approve", () => {
    const proj = checkpointProject();
    buildUnit(proj, "alpha");
    const env = sensorEnv(proj, checkpointGraph);
    recordVerificationCommand(proj);

    const verified = tool("bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "verify"], proj, env);
    expect(verified.rc, verified.out).toBe(0);
    expect(JSON.parse(verified.stdout).verified).toBe(true);

    const session = "t3493-unit-approve";
    const asked = tool("bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "ask", "--session", session], proj, env);
    expect(asked.rc, asked.out).toBe(0);
    humanTurn(proj, "Approve", session);

    const refused = tool("bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "approve",
      "--session", session, "--user-input", "Approve"], proj, env);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("Blocking gate sensor evaluation did not pass");
    expect(refused.out).toContain("alpha");
    expect(refused.out).toContain(STAGE);
    expect(refused.out).toContain(`Sensors: ${SENSOR_ID}`);
    expect(sensorRows(proj, "SENSOR_FAILED")).toHaveLength(1);
    expect(sensorRows(proj, "GATE_APPROVED")).toHaveLength(0);

    writeSensor(proj, true);
    const approved = tool("bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "approve",
      "--session", session, "--user-input", "Approve"], proj, env);
    expect(approved.rc, approved.out).toBe(0);
    expect(JSON.parse(approved.stdout).approved).toBe(true);
    expect(sensorRows(proj, "SENSOR_PASSED")).toHaveLength(1);
    expect(sensorRows(proj, "GATE_APPROVED")).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
