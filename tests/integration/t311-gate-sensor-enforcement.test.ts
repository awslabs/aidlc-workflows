// covers: subcommand:aidlc-state:gate-start, subcommand:aidlc-sensor:fire,
//         audit:SENSOR_FIRED, audit:SENSOR_FAILED
//
// Gate-bound sensor integration: state dispatches outside its transaction,
// blocking failures refuse the transition, the explicit override is audited,
// and advisory failures preserve the historical non-blocking behavior.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  BLOCKING_SENSOR_OVERRIDE_CHOICE,
  BLOCKING_SENSOR_OVERRIDE_DECISION,
  BLOCKING_SENSOR_OVERRIDE_OPTIONS,
} from "../../core/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
const externalPaths: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  for (const path of externalPaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

interface Fixture {
  project: string;
  graph: string;
  outputDir: string;
  sensors: string;
  scripts: string;
}

function setupFixture(
  severity: "advisory" | "blocking",
  matches = "**/*",
  pass = false,
): Fixture {
  const project = createTestProject();
  projects.push(project);
  const sensors = join(project, ".test-sensors");
  const scripts = join(project, ".test-scripts");
  mkdirSync(sensors, { recursive: true });
  mkdirSync(scripts, { recursive: true });

  const id = "gate-probe";
  writeFileSync(
    join(sensors, `aidlc-${id}.md`),
    [
      "---",
      `id: ${id}`,
      "kind: deterministic",
      `command: bun .claude/tools/aidlc-sensor-${id}.ts`,
      `default_severity: ${severity}`,
      "fire_on: gate",
      "description: gate enforcement fixture",
      "category: test",
      `matches: "${matches}"`,
      "timeout_seconds: 5",
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(scripts, `aidlc-sensor-${id}.ts`),
    [
      `process.stdout.write(JSON.stringify({ pass: ${pass}, findings_count: ${pass ? 0 : 1} }) + "\\n");`,
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf-8",
  );

  const graph = join(project, "stage-graph.json");
  writeFileSync(
    graph,
    `${JSON.stringify([
      {
        slug: "probe",
        number: "1.0",
        name: "Probe",
        phase: "inception",
        execution: "ALWAYS",
        lead_agent: "aidlc-product-agent",
        support_agents: [],
        mode: "inline",
        produces: ["one", "two"],
        optional_produces: [],
        consumes: [],
        requires_stage: [],
        sensors: [id],
        scopes: ["bugfix"],
        inputs: "",
        outputs: "",
        rules_in_context: [],
        sensors_applicable: [
          {
            id,
            path: `.claude/sensors/aidlc-${id}.md`,
            fire_on: "gate",
            default_severity: severity,
            category: "test",
            matches,
          },
        ],
      },
    ], null, 2)}\n`,
    "utf-8",
  );

  writeFileSync(
    seededStateFile(project),
    [
      "# AI-DLC State Tracking",
      "",
      "- **Workflow**: bugfix",
      "- **State Version**: 8",
      "- **Scope**: bugfix",
      "- **Phase**: inception",
      "- **Current Stage**: probe",
      "",
      "- [-] probe — EXECUTE",
      "",
    ].join("\n"),
    "utf-8",
  );
  seedAuditFile(project);

  const outputDir = join(seededRecordDir(project), "inception", "probe");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "one.md"), "# One\n", "utf-8");
  writeFileSync(join(outputDir, "two.md"), "# Two\n", "utf-8");
  return { project, graph, outputDir, sensors, scripts };
}

function stateCommand(
  fixture: Fixture,
  command: string,
  extra: string[] = [],
  envOverrides: Record<string, string> = {},
): { status: number; out: string } {
  const result = spawnSync(
    BUN,
    [
      STATE,
      command,
      "probe",
      ...extra,
      "--project-dir",
      fixture.project,
    ],
    {
      cwd: fixture.project,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        AIDLC_STAGE_GRAPH: fixture.graph,
        AIDLC_SENSORS_DIR: fixture.sensors,
        AIDLC_SENSOR_SCRIPT_DIR: fixture.scripts,
        ...envOverrides,
      },
    },
  );
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function gate(
  fixture: Fixture,
  extra: string[] = [],
  envOverrides: Record<string, string> = {},
): { status: number; out: string } {
  return stateCommand(fixture, "gate-start", extra, envOverrides);
}

function reportRevised(
  fixture: Fixture,
  extra: string[] = [],
): { status: number; out: string } {
  const result = spawnSync(
    BUN,
    [
      ORCHESTRATE,
      "report",
      "--stage",
      "probe",
      "--result",
      "revised",
      ...extra,
      "--project-dir",
      fixture.project,
    ],
    {
      cwd: fixture.project,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        AIDLC_STAGE_GRAPH: fixture.graph,
        AIDLC_SENSORS_DIR: fixture.sensors,
        AIDLC_SENSOR_SCRIPT_DIR: fixture.scripts,
      },
    },
  );
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function audit(project: string): string {
  const dir = seededAuditDir(project);
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8"))
    .join("\n");
}

function eventCount(content: string, event: string): number {
  return content
    .split("\n")
    .filter((line) => line === `**Event**: ${event}`).length;
}

function appendAuditEvent(
  project: string,
  event: string,
  fields: Record<string, string> = {},
): void {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const body = [
    "",
    `## ${event}`,
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    ...Object.entries(fields).map(([name, value]) => `**${name}**: ${value}`),
    "",
    "---",
    "",
  ].join("\n");
  appendFileSync(seededAuditShard(project), body, "utf-8");
}

function authorizeOverride(
  fixture: Fixture,
  options = BLOCKING_SENSOR_OVERRIDE_OPTIONS.join(","),
  includeHumanTurn = true,
): void {
  appendAuditEvent(fixture.project, "DECISION_RECORDED", {
    Stage: "probe",
    Decision: BLOCKING_SENSOR_OVERRIDE_DECISION,
    Options: options,
  });
  if (includeHumanTurn) appendAuditEvent(fixture.project, "HUMAN_TURN");
  appendAuditEvent(fixture.project, "QUESTION_ANSWERED", {
    Stage: "probe",
    Details: BLOCKING_SENSOR_OVERRIDE_CHOICE,
  });
}

function overrideArgs(): string[] {
  return [
    "--override-blocking-sensors",
    "--user-input",
    BLOCKING_SENSOR_OVERRIDE_CHOICE,
  ];
}

function setAutonomous(fixture: Fixture): void {
  appendFileSync(
    seededStateFile(fixture.project),
    "- **Construction Autonomy Mode**: autonomous\n",
    "utf-8",
  );
}

function dispatcherStub(
  fixture: Fixture,
  mode: "exit-2" | "malformed" | "timeout",
): string {
  const path = join(fixture.project, `.dispatcher-${mode}.ts`);
  const body =
    mode === "exit-2"
      ? '#!/usr/bin/env bun\nprocess.stderr.write("dispatcher exploded\\n");\nprocess.exit(2);\n'
      : mode === "malformed"
        ? '#!/usr/bin/env bun\nprocess.stdout.write("not-json\\n");\n'
        : '#!/usr/bin/env bun\nawait Bun.sleep(1000);\n';
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

describe("t311 gate-bound sensor enforcement", () => {
  test("fires once per deliverable, blocks, overrides with audit, and leaves advisory failures non-blocking", () => {
    const blocking = setupFixture("blocking");
    const refused = gate(blocking);
    const firstAudit = audit(blocking.project);
    expect(refused.status).toBe(1);
    expect(eventCount(firstAudit, "SENSOR_FIRED")).toBe(2);
    expect(eventCount(firstAudit, "SENSOR_FAILED")).toBe(2);
    expect(readFileSync(seededStateFile(blocking.project), "utf-8")).toContain(
      "- [-] probe",
    );
    expect(refused.out).toContain("gate-probe");
    expect(refused.out).toContain(".aidlc-sensors/probe/gate-probe-");
    expect(refused.out).toContain("--override-blocking-sensors");

    const unauthorized = gate(blocking, overrideArgs());
    expect(unauthorized.status).toBe(1);
    expect(unauthorized.out).toContain("no fresh authorization receipt");
    const firesBeforeAuthorizedRetry = eventCount(
      audit(blocking.project),
      "SENSOR_FIRED",
    );

    authorizeOverride(blocking);
    const overridden = gate(blocking, overrideArgs());
    const overrideAudit = audit(blocking.project);
    expect(overridden.status).toBe(0);
    expect(readFileSync(seededStateFile(blocking.project), "utf-8")).toContain(
      "- [?] probe",
    );
    expect(eventCount(overrideAudit, "SENSOR_FIRED")).toBe(
      firesBeforeAuthorizedRetry + 2,
    );
    expect(overrideAudit).toContain("**Blocking Sensor Override**: true");
    expect(overrideAudit).toContain("**Blocking Sensor IDs**: gate-probe");
    expect(overrideAudit).toContain("**Blocking Sensor Detail Paths**:");
    expect(overrideAudit).toContain("**Blocking Sensor Reasons**:");

    const advisory = setupFixture("advisory");
    const advisoryGate = gate(advisory);
    const advisoryAudit = audit(advisory.project);
    expect(advisoryGate.status).toBe(0);
    expect(readFileSync(seededStateFile(advisory.project), "utf-8")).toContain(
      "- [?] probe",
    );
    expect(eventCount(advisoryAudit, "SENSOR_FIRED")).toBe(2);
    expect(eventCount(advisoryAudit, "SENSOR_FAILED")).toBe(2);
    expect(advisoryAudit).not.toContain("**Blocking Sensor Override**:");
  }, 30_000);

  test("revise re-fires gate sensors, enforces blocking failures, and accepts the report override", () => {
    const fixture = setupFixture("blocking");
    authorizeOverride(fixture);
    expect(gate(fixture, overrideArgs()).status).toBe(0);
    expect(eventCount(audit(fixture.project), "SENSOR_FIRED")).toBe(2);

    const rejected = stateCommand(
      fixture,
      "reject",
      ["--feedback", "revise the deliverables"],
    );
    expect(rejected.status).toBe(0);
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
      "- [R] probe",
    );
    // Reject backfill/decision paths never dispatch gate sensors.
    expect(eventCount(audit(fixture.project), "SENSOR_FIRED")).toBe(2);

    const refused = stateCommand(fixture, "revise");
    const refusedAudit = audit(fixture.project);
    expect(refused.status).toBe(1);
    expect(eventCount(refusedAudit, "SENSOR_FIRED")).toBe(4);
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
      "- [R] probe",
    );
    expect(refused.out).toContain("--result revised");
    expect(refused.out).toContain("--override-blocking-sensors");

    authorizeOverride(fixture);
    const overridden = reportRevised(fixture, overrideArgs());
    const overrideAudit = audit(fixture.project);
    expect(overridden.status).toBe(0);
    expect(overridden.out).toContain('"kind":"print"');
    expect(eventCount(overrideAudit, "SENSOR_FIRED")).toBe(6);
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
      "- [?] probe",
    );
    const gateRows = overrideAudit
      .split("\n---\n")
      .filter((block) =>
        block.includes("**Event**: STAGE_AWAITING_APPROVAL")
      );
    const reviseRow = gateRows[gateRows.length - 1] ?? "";
    expect(reviseRow).toContain("**Details**: Re-entering gate after revision");
    expect(reviseRow).toContain("**Blocking Sensor Override**: true");
    expect(reviseRow).toContain("**Blocking Sensor IDs**: gate-probe");
    expect(reviseRow).toContain("**Blocking Sensor Detail Paths**:");
    expect(reviseRow).toContain("**Blocking Sensor Reasons**:");
  }, 30_000);

  test("override requires the offered choice, a human turn, and non-autonomous mode", () => {
    const missingChoice = setupFixture("blocking");
    authorizeOverride(
      missingChoice,
      "Fix findings",
    );
    const notOffered = gate(missingChoice, overrideArgs());
    expect(notOffered.status).toBe(1);
    expect(notOffered.out).toContain("no fresh authorization receipt");

    const noHuman = setupFixture("blocking");
    authorizeOverride(noHuman, BLOCKING_SENSOR_OVERRIDE_OPTIONS.join(","), false);
    const unbacked = gate(noHuman, overrideArgs());
    expect(unbacked.status).toBe(1);
    expect(unbacked.out).toContain("no fresh authorization receipt");

    const autonomous = setupFixture("blocking");
    authorizeOverride(autonomous);
    setAutonomous(autonomous);
    const refused = gate(autonomous, overrideArgs());
    expect(refused.status).toBe(1);
    expect(refused.out).toContain("Autonomy Mode is autonomous");
    expect(readFileSync(seededStateFile(autonomous.project), "utf-8")).toContain(
      "- [-] probe",
    );
  }, 30_000);

  test("blocking dispatch exits, malformed verdicts, and dispatcher timeouts fail closed", () => {
    for (const mode of ["exit-2", "malformed", "timeout"] as const) {
      const fixture = setupFixture("blocking");
      const result = gate(fixture, [], {
        AIDLC_COMPILED_EXECUTABLE: dispatcherStub(fixture, mode),
        AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: "100",
      });
      expect(result.status).toBe(1);
      expect(result.out).toContain("Blocking gate sensor evaluation did not pass");
      expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
        "- [-] probe",
      );
    }
  }, 30_000);

  test("gate dispatch skips deliverables outside the sensor matches capability", () => {
    const fixture = setupFixture("blocking", "**/one.md", true);
    const result = gate(fixture);
    const finalAudit = audit(fixture.project);
    expect(result.status).toBe(0);
    expect(eventCount(finalAudit, "SENSOR_FIRED")).toBe(1);
    expect(finalAudit).toContain("one.md");
    expect(finalAudit).not.toContain("two.md");
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
      "- [?] probe",
    );
  }, 30_000);

  test("blocking verdicts cannot authorize bytes changed during evaluation", () => {
    const fixture = setupFixture("blocking", "**/*", true);
    writeFileSync(
      join(fixture.scripts, "aidlc-sensor-gate-probe.ts"),
      [
        'import { appendFileSync } from "node:fs";',
        'const index = process.argv.indexOf("--output-path");',
        'appendFileSync(process.argv[index + 1], "\\nchanged after check\\n");',
        'process.stdout.write(JSON.stringify({ pass: true, findings_count: 0 }) + "\\n");',
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = gate(fixture);
    expect(result.status).toBe(1);
    expect(result.out).toContain("artifact changed during sensor evaluation");
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
      "- [-] probe",
    );
  }, 30_000);

  test("explicit and symlinked artifacts cannot escape canonical produce directories", () => {
    const explicit = setupFixture("blocking");
    const explicitRoot = join(
      dirname(explicit.project),
      `${basename(explicit.project)}-external`,
    );
    externalPaths.push(explicitRoot);
    mkdirSync(explicitRoot, { recursive: true });
    const externalOne = join(explicitRoot, "one.md");
    writeFileSync(externalOne, "# External\n", "utf-8");
    const externalResult = gate(explicit, ["--artifacts", externalOne]);
    expect(externalResult.status).toBe(1);
    expect(externalResult.out).toContain(
      "outside the stage's resolved produce directories",
    );
    expect(eventCount(audit(explicit.project), "SENSOR_FIRED")).toBe(0);

    if (process.platform !== "win32") {
      const linked = setupFixture("blocking");
      const linkedRoot = join(
        dirname(linked.project),
        `${basename(linked.project)}-linked`,
      );
      externalPaths.push(linkedRoot);
      mkdirSync(linkedRoot, { recursive: true });
      const linkedExternal = join(linkedRoot, "one.md");
      writeFileSync(linkedExternal, "# Linked external\n", "utf-8");
      const linkedOne = join(linked.outputDir, "one.md");
      unlinkSync(linkedOne);
      symlinkSync(linkedExternal, linkedOne);
      const linkedResult = gate(linked);
      expect(linkedResult.status).toBe(1);
      expect(linkedResult.out).toContain(
        "outside the stage's resolved produce directories",
      );
      expect(eventCount(audit(linked.project), "SENSOR_FIRED")).toBe(0);
    }
  }, 30_000);

  test("approve-time revision recovery re-fires blocking sensors before re-entry", () => {
    const fixture = setupFixture("blocking");
    authorizeOverride(fixture);
    expect(gate(fixture, overrideArgs()).status).toBe(0);
    const firesAtGate = eventCount(audit(fixture.project), "SENSOR_FIRED");

    appendAuditEvent(fixture.project, "HUMAN_TURN");
    appendAuditEvent(fixture.project, "ARTIFACT_UPDATED", {
      File: join(fixture.outputDir, "one.md"),
    });
    appendAuditEvent(fixture.project, "HUMAN_TURN");

    const approval = stateCommand(
      fixture,
      "approve",
      ["--user-input", "Approve"],
      { AIDLC_SKIP_REVISION_BACKSTOP: "0" },
    );
    const finalAudit = audit(fixture.project);
    expect(approval.status).toBe(1);
    expect(approval.out).toContain("Blocking gate sensor evaluation did not pass");
    expect(eventCount(finalAudit, "SENSOR_FIRED")).toBe(firesAtGate + 2);
    expect(eventCount(finalAudit, "GATE_REJECTED")).toBe(1);
    expect(eventCount(finalAudit, "GATE_APPROVED")).toBe(0);
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
      "- [R] probe",
    );
    const recoveredGateRows = finalAudit
      .split("\n---\n")
      .filter((block) =>
        block.includes("**Event**: STAGE_AWAITING_APPROVAL") &&
        block.includes("**Recovered**: true")
    );
    expect(recoveredGateRows).toHaveLength(0);
  }, 30_000);

  test("an already-open gate audits and consumes its blocking override", () => {
    const fixture = setupFixture("blocking");
    authorizeOverride(fixture);
    expect(gate(fixture, overrideArgs()).status).toBe(0);

    authorizeOverride(fixture);
    const revalidated = gate(fixture, overrideArgs());
    const revalidatedAudit = audit(fixture.project);
    expect(revalidated.status).toBe(0);
    expect(revalidated.out).toContain('"already_awaiting_approval":true');
    const gateRows = revalidatedAudit
      .split("\n---\n")
      .filter((block) =>
        block.includes("**Event**: STAGE_AWAITING_APPROVAL")
      );
    const revalidationRow = gateRows[gateRows.length - 1] ?? "";
    expect(revalidationRow).toContain("**Revalidated**: true");
    expect(revalidationRow).toContain("**Blocking Sensor Override**: true");

    const reused = gate(fixture, overrideArgs());
    expect(reused.status).toBe(1);
    expect(reused.out).toContain("no fresh authorization receipt");
  }, 30_000);
});
