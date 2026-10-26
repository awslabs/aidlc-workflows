// covers: subcommand:aidlc-state:gate-start, subcommand:aidlc-sensor:fire,
//         audit:SENSOR_FIRED, audit:SENSOR_FAILED, subcommand:aidlc-orchestrate:next,
//         function:hasBlockingSensorOverrideAuthorization
//
// Gate-bound sensor integration: state dispatches outside its transaction,
// blocking failures refuse the transition, the explicit override is audited,
// and advisory failures preserve non-blocking behavior. After the person's
// Override pick, `next` names the report that carries it, and the gate opens
// with the override on its row.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, describe, expect, test } from "bun:test";
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
  createOrchestrationTestProject,
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
  blockingSensorPicks,
  codekbDir,
  codekbRepoName,
  readAuditShardEvents,
  setField,
  setGuardPolicyLine,
} from "../../core/tools/aidlc-lib.ts";
import { LOG, env, exec, next, reviewedStage, say } from "../harness/aidlc-input-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
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

// `laterConstructionStage` places the probe as the second Construction stage,
// behind a completed anchor, so a Construction autonomy grant makes its gate
// one the engine approves itself (the first Construction approval is never
// the grant's).
function setupFixture(
  severity: "advisory" | "blocking",
  matches = "**/*",
  pass = false,
  scope = "bugfix",
  laterConstructionStage = false,
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
      `timeout_seconds: ${NATIVE_STARTUP_TIMEOUT_MS / 1000}`,
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

  const phase = laterConstructionStage ? "construction" : "inception";
  const graph = join(project, "stage-graph.json");
  const anchor = {
    slug: "anchor",
    number: "0.9",
    name: "Anchor",
    phase,
    execution: "ALWAYS",
    lead_agent: "aidlc-product-agent",
    support_agents: [],
    mode: "inline",
    produces: [],
    optional_produces: [],
    consumes: [],
    requires_stage: [],
    sensors: [],
    scopes: [scope],
    inputs: "",
    outputs: "",
    rules_in_context: [],
    sensors_applicable: [],
  };
  writeFileSync(
    graph,
    `${JSON.stringify([
      ...(laterConstructionStage ? [anchor] : []),
      {
        slug: "probe",
        number: "1.0",
        name: "Probe",
        phase,
        execution: "ALWAYS",
        lead_agent: "aidlc-product-agent",
        support_agents: [],
        mode: "inline",
        produces: ["one", "two"],
        optional_produces: [],
        consumes: [],
        requires_stage: [],
        sensors: [id],
        scopes: [scope],
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

  const probeLine = "- [-] probe — EXECUTE";
  writeFileSync(
    seededStateFile(project),
    [
      "# AI-DLC State Tracking",
      "",
      `- **Workflow**: ${scope}`,
      "- **State Version**: 8",
      `- **Scope**: ${scope}`,
      `- **Phase**: ${phase}`,
      "- **Current Stage**: probe",
      "",
      ...(laterConstructionStage ? [probeLine.replace("[-] probe", "[x] anchor")] : []),
      probeLine,
      "",
    ].join("\n"),
    "utf-8",
  );
  seedAuditFile(project);

  const outputDir = join(seededRecordDir(project), phase, "probe");
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
        AIDLC_DISABLE_SENSORS: "0",
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        AIDLC_STAGE_GRAPH: fixture.graph,
        AIDLC_SENSORS_DIR: fixture.sensors,
        AIDLC_SENSOR_SCRIPT_DIR: fixture.scripts,
        AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: String(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
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
        AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: String(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
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
  details: string = BLOCKING_SENSOR_OVERRIDE_CHOICE,
): void {
  appendAuditEvent(fixture.project, "DECISION_RECORDED", {
    Stage: "probe",
    Decision: BLOCKING_SENSOR_OVERRIDE_DECISION,
    Options: options,
  });
  if (includeHumanTurn) appendAuditEvent(fixture.project, "HUMAN_TURN");
  appendAuditEvent(fixture.project, "QUESTION_ANSWERED", {
    Stage: "probe",
    Details: details,
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
  for (const transition of ["gate-start", "revise", "approve"] as const) {
    test(`an explicit off override skips classic sensors at ${transition}; a resumed intent can opt back in`, () => {
      for (const enabled of [false, true]) {
        const fixture = setupFixture("blocking", "**/*", false, "classic");
        const path = seededStateFile(fixture.project);
        appendFileSync(path, "- **Sensors**: off (set by you)\n");
        if (transition !== "gate-start") {
          expect(gate(fixture).status).toBe(0);
          expect(eventCount(audit(fixture.project), "SENSOR_FIRED")).toBe(0);
          if (transition === "revise") {
            expect(stateCommand(
              fixture, "reject", ["--feedback", "revise the deliverables"],
            ).status).toBe(0);
          } else {
            appendAuditEvent(fixture.project, "HUMAN_TURN");
            appendAuditEvent(fixture.project, "ARTIFACT_UPDATED", {
              File: join(fixture.outputDir, "one.md"),
            });
            appendAuditEvent(fixture.project, "HUMAN_TURN");
          }
        }
        if (enabled) {
          writeFileSync(path, setField(readFileSync(path, "utf-8"), "Sensors", "on (set by you)"));
        }
        const result = stateCommand(
          fixture,
          transition,
          transition === "approve" ? ["--user-input", "Approve"] : [],
          { AIDLC_SKIP_REVISION_BACKSTOP: "0" },
        );
        const finalAudit = audit(fixture.project);
        const state = readFileSync(seededStateFile(fixture.project), "utf-8");
        expect(result.status).toBe(enabled ? 1 : 0);
        expect(eventCount(finalAudit, "SENSOR_FIRED")).toBe(enabled ? 2 : 0);
        expect(eventCount(finalAudit, "SENSOR_FAILED")).toBe(enabled ? 2 : 0);
        expect(eventCount(finalAudit, "SENSOR_PASSED")).toBe(0);
        if (enabled) {
          expect(state).toContain(transition === "gate-start" ? "- [-] probe" : "- [R] probe");
        } else {
          expect(state).toContain(transition === "approve" ? "- [x] probe" : "- [?] probe");
        }
        if (transition === "approve") {
          expect(eventCount(finalAudit, "GATE_REJECTED")).toBe(1);
          expect(eventCount(finalAudit, "GATE_APPROVED")).toBe(enabled ? 0 : 1);
          expect(finalAudit).toContain("**Recovered**: true");
        }
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test.each(["classic", "feature"])("a global sensor kill switch permits a %s gate without synthesizing a verdict", (scope) => {
    const fixture = setupFixture("blocking", "**/*", false, scope);
    expect(gate(fixture, [], { AIDLC_DISABLE_SENSORS: "1" }).status).toBe(0);
    const offAudit = audit(fixture.project);
    expect(eventCount(offAudit, "SENSOR_FIRED")).toBe(0);
    expect(eventCount(offAudit, "SENSOR_PASSED")).toBe(0);
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain("- [?] probe");

    expect(gate(fixture).status).toBe(1);
    expect(eventCount(audit(fixture.project), "SENSOR_FIRED")).toBe(2);
    expect(eventCount(audit(fixture.project), "SENSOR_FAILED")).toBe(2);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    expect(refused.out).toContain(".aidlc-engine/sensors/probe/gate-probe-");
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Advisory gate sensors are evidence for whoever answers the gate. A gate the
  // engine approves itself under Construction autonomy has no reader, so only
  // its blocking sensors (which halt an unattended run) fire; the same gate
  // with a person answering keeps every sensor.
  test("a gate the engine approves itself fires no advisory sensor; blocking ones and a person's gate are unchanged", () => {
    const selfApproved = setupFixture("advisory", "**/*", false, "bugfix", true);
    setAutonomous(selfApproved);
    expect(gate(selfApproved).status).toBe(0);
    expect(eventCount(audit(selfApproved.project), "SENSOR_FIRED")).toBe(0);
    expect(readFileSync(seededStateFile(selfApproved.project), "utf-8")).toContain("- [?] probe");

    const blocking = setupFixture("blocking", "**/*", false, "bugfix", true);
    setAutonomous(blocking);
    expect(gate(blocking).status).toBe(1);
    expect(eventCount(audit(blocking.project), "SENSOR_FIRED")).toBe(2);
    expect(eventCount(audit(blocking.project), "SENSOR_FAILED")).toBe(2);

    // The same gate with a person answering: unchanged, and a revise re-entry
    // after the grant arrives fires nothing advisory.
    const answered = setupFixture("advisory", "**/*", false, "bugfix", true);
    expect(gate(answered).status).toBe(0);
    expect(eventCount(audit(answered.project), "SENSOR_FIRED")).toBe(2);
    expect(stateCommand(answered, "reject", ["--feedback", "revise the deliverables"]).status).toBe(0);
    setAutonomous(answered);
    expect(stateCommand(answered, "revise").status).toBe(0);
    expect(eventCount(audit(answered.project), "SENSOR_FIRED")).toBe(2);
    expect(readFileSync(seededStateFile(answered.project), "utf-8")).toContain("- [?] probe");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    // The refusal names the step that lets the person's override through:
    // Construction stops for approval at each Bolt again, and the same
    // override is then accepted.
    expect(refused.out).toContain("set-autonomy --mode gated");
    const statePath = seededStateFile(autonomous.project);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(
        "- **Construction Autonomy Mode**: autonomous",
        "- **Construction Autonomy Mode**: gated",
      ),
    );
    const accepted = gate(autonomous, overrideArgs());
    expect(accepted.out).not.toContain("Autonomy Mode is autonomous");
    expect(accepted.status, accepted.out).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("an answer recorded as an option's number authorizes only that option", () => {
    const byNumber = setupFixture("blocking");
    authorizeOverride(byNumber, BLOCKING_SENSOR_OVERRIDE_OPTIONS.join(","), true, "2");
    const overridden = gate(byNumber, overrideArgs());
    expect(overridden.status, overridden.out).toBe(0);

    const fixFirst = setupFixture("blocking");
    authorizeOverride(fixFirst, BLOCKING_SENSOR_OVERRIDE_OPTIONS.join(","), true, "1");
    expect(gate(fixFirst, overrideArgs()).out).toContain("no fresh authorization receipt");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Another question for the stage logged after the check's own takes its open
  // place; an answer naming one of the check's labels still answers the check's
  // question, after a person's turn, so a Fix findings answer there is a pick
  // too. One reply recorded for both questions (stage-protocol.md's
  // `Q1: ...; Q2: ...`) is read the same way, by the first label its parts
  // name. An answer by number reads only the open question's own options, and
  // the look-back stops at the stage's last boundary.
  test("an Override after a second question for the stage still authorizes", () => {
    const ask = (fixture: Fixture, decision: string, options: string) =>
      appendAuditEvent(fixture.project, "DECISION_RECORDED", { Stage: "probe", Decision: decision, Options: options });
    const askCheck = (fixture: Fixture) =>
      ask(fixture, BLOCKING_SENSOR_OVERRIDE_DECISION, BLOCKING_SENSOR_OVERRIDE_OPTIONS.join(","));
    const askOther = (fixture: Fixture) =>
      ask(fixture, "Override only the traceability finding, or every finding?", "Only traceability,Every finding");
    const turn = (fixture: Fixture) => appendAuditEvent(fixture.project, "HUMAN_TURN");
    const answer = (fixture: Fixture, details: string) =>
      appendAuditEvent(fixture.project, "QUESTION_ANSWERED", { Stage: "probe", Details: details });
    const shapes: Array<(fixture: Fixture) => void> = [
      (f) => {
        askCheck(f); askOther(f); turn(f);
        answer(f, BLOCKING_SENSOR_OVERRIDE_CHOICE);
      },
      (f) => {
        askCheck(f); turn(f); askOther(f); turn(f);
        answer(f, "Every finding"); answer(f, BLOCKING_SENSOR_OVERRIDE_CHOICE);
      },
      (f) => {
        askCheck(f); askOther(f); turn(f);
        answer(f, "Every finding"); answer(f, BLOCKING_SENSOR_OVERRIDE_CHOICE);
      },
    ];
    for (const shape of shapes) {
      const fixture = setupFixture("blocking");
      shape(fixture);
      const overridden = gate(fixture, overrideArgs());
      expect(overridden.status, overridden.out).toBe(0);
    }

    const byNumber = setupFixture("blocking");
    askCheck(byNumber); askOther(byNumber); turn(byNumber);
    answer(byNumber, "2");
    expect(gate(byNumber, overrideArgs()).out).toContain("no fresh authorization receipt");

    const fixAfter = setupFixture("blocking");
    askCheck(fixAfter); askOther(fixAfter); turn(fixAfter);
    answer(fixAfter, "Fix findings");
    expect([...blockingSensorPicks(readAuditShardEvents(fixAfter.project), "probe").values()]).toEqual(["Fix findings"]);

    const combined = setupFixture("blocking");
    askCheck(combined); askOther(combined); turn(combined);
    answer(combined, `Q1: ${BLOCKING_SENSOR_OVERRIDE_CHOICE}; Q2: Every finding`);
    const accepted = gate(combined, overrideArgs());
    expect(accepted.status, accepted.out).toBe(0);
    const picksFor = (details: string, checkFirst = true): string[] => {
      const fixture = setupFixture("blocking");
      if (checkFirst) {
        askCheck(fixture); askOther(fixture);
      } else {
        askOther(fixture); askCheck(fixture);
      }
      turn(fixture);
      answer(fixture, details);
      return [...blockingSensorPicks(readAuditShardEvents(fixture.project), "probe").values()];
    };
    expect(picksFor("Q1: Fix findings; Q2: Every finding")).toEqual(["Fix findings"]);
    expect(picksFor(`Q1: Fix findings; Q2: ${BLOCKING_SENSOR_OVERRIDE_CHOICE}`)).toEqual(["Fix findings"]);
    expect(picksFor(`Fix findings; ${BLOCKING_SENSOR_OVERRIDE_CHOICE}`, false)).toEqual(["Fix findings"]);
    expect(picksFor(`Q1: Every finding; Q2: ${BLOCKING_SENSOR_OVERRIDE_CHOICE}`, false))
      .toEqual([BLOCKING_SENSOR_OVERRIDE_CHOICE]);

    const beforeBoundary = setupFixture("blocking");
    askCheck(beforeBoundary); askOther(beforeBoundary);
    appendAuditEvent(beforeBoundary.project, "STAGE_STARTED", { Stage: "probe" });
    turn(beforeBoundary);
    answer(beforeBoundary, BLOCKING_SENSOR_OVERRIDE_CHOICE);
    expect(gate(beforeBoundary, overrideArgs()).out).toContain("no fresh authorization receipt");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("blocking dispatch exits, malformed verdicts, and dispatcher timeouts fail closed", () => {
    for (const mode of ["exit-2", "malformed", "timeout"] as const) {
      const fixture = setupFixture("blocking");
      const result = gate(fixture, [], {
        AIDLC_COMPILED_EXECUTABLE: dispatcherStub(fixture, mode),
        AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: mode === "timeout"
          ? "100" : String(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(result.status).toBe(1);
      expect(result.out).toContain("Blocking gate sensor evaluation did not pass");
      expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
        "- [-] probe",
      );
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // A check whose script crashed checked nothing: it is recorded as could not
  // run, never as a pass. A blocking one still needs a verified pass, so the
  // gate stops as it always has and names why; an advisory one stops nothing.
  test("a check whose script crashes is recorded as could not run; blocking stops the gate, advisory does not", () => {
    for (const severity of ["blocking", "advisory"] as const) {
      const fixture = setupFixture(severity);
      writeFileSync(join(fixture.scripts, "aidlc-sensor-gate-probe.ts"), 'process.stderr.write("boom\\n");\nprocess.exit(1);\n', "utf-8");
      const result = gate(fixture);
      const trail = audit(fixture.project);
      expect(eventCount(trail, "SENSOR_COULD_NOT_RUN"), trail).toBe(2);
      expect(eventCount(trail, "SENSOR_PASSED")).toBe(0);
      expect(eventCount(trail, "SENSOR_FAILED")).toBe(0);
      expect(trail).toContain("**Note**: script-error: exit-1");
      if (severity === "blocking") {
        expect(result.status, result.out).toBe(1);
        expect(result.out).toContain("Blocking gate sensor evaluation did not pass");
        expect(result.out).toContain("could not run (script-error: exit-1)");
        expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain("- [-] probe");
      } else {
        expect(result.status, result.out).toBe(0);
        expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain("- [?] probe");
      }
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The executable fixture requires /bin/sh, which native Windows cannot launch.
  test.skipIf(process.platform === "win32")("compiled dispatch fires sensors through the engine namespace", () => {
    const fixture = setupFixture("blocking", "**/*", true);
    const seen = join(fixture.project, "native-argv.log");
    const executable = join(fixture.project, "aidlc-native-stub");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(seen)}\nexec ${JSON.stringify(BUN)} ${JSON.stringify(DISPATCHER)} "$@"\n`,
      { mode: 0o755 },
    );
    const result = gate(fixture, [], { AIDLC_COMPILED_EXECUTABLE: executable });
    expect(result.status).toBe(0);
    const calls = readFileSync(seen, "utf-8").trim().split("\n");
    const fires = calls.filter((call) => call.includes("sensor fire "));
    expect(fires).toHaveLength(2);
    for (const call of fires) expect(call.startsWith("engine sensor fire gate-probe ")).toBe(true);
    expect(eventCount(audit(fixture.project), "SENSOR_FIRED")).toBe(2);
    expect(readFileSync(seededStateFile(fixture.project), "utf-8")).toContain(
      "- [?] probe",
    );
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// At a code knowledge base stage the required-sections check fires once over
// every repository's files (the paths on stdin), so a blocking binding holds
// every file that fire reads, not only the one it is named for: a sibling that
// changes while the check runs is refused and named, and the retry passes.
describe("t311 a blocking check over every repository's files", () => {
  test("a sibling changed during the one fire is refused once and named; the retry passes", () => {
    const project = createTestProject();
    projects.push(project);
    const sensors = join(project, ".test-sensors");
    const scripts = join(project, ".test-scripts");
    mkdirSync(sensors, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    const id = "required-sections";
    const matches = "**/codekb/**";
    writeFileSync(join(sensors, `aidlc-${id}.md`), [
      "---", `id: ${id}`, "kind: deterministic", `command: bun .claude/tools/aidlc-sensor-${id}.ts`,
      "default_severity: blocking", "fire_on: gate", "description: codekb gate fixture", "category: test",
      `matches: "${matches}"`, `timeout_seconds: ${NATIVE_STARTUP_TIMEOUT_MS / 1000}`, "---", "",
    ].join("\n"), "utf-8");
    // Changes the second path it is handed, once, then passes.
    const once = join(project, ".changed-once");
    writeFileSync(join(scripts, `aidlc-sensor-${id}.ts`), [
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const paths = JSON.parse(readFileSync(0, "utf-8"));',
      `if (!existsSync(${JSON.stringify(once)})) {`,
      '  appendFileSync(paths[1], "\\nchanged during the check\\n");',
      `  writeFileSync(${JSON.stringify(once)}, "");`,
      "}",
      'process.stdout.write(JSON.stringify({ pass: true, findings_count: 0, failed_outputs: [] }) + "\\n");',
      "",
    ].join("\n"), "utf-8");
    const graph = join(project, "stage-graph.json");
    writeFileSync(graph, `${JSON.stringify([{
      slug: "reverse-engineering", number: "2.1", name: "Reverse Engineering", phase: "inception",
      execution: "ALWAYS", lead_agent: "aidlc-product-agent", support_agents: [], mode: "inline",
      produces: ["architecture", "dependencies"], optional_produces: [], consumes: [], requires_stage: [],
      sensors: [id], scopes: ["bugfix"], inputs: "", outputs: "", rules_in_context: [],
      sensors_applicable: [{ id, path: `.claude/sensors/aidlc-${id}.md`, fire_on: "gate", default_severity: "blocking", category: "test", matches }],
    }], null, 2)}\n`, "utf-8");
    writeFileSync(seededStateFile(project), [
      "# AI-DLC State Tracking", "", "- **Workflow**: bugfix", "- **State Version**: 8", "- **Scope**: bugfix",
      "- **Phase**: inception", "- **Current Stage**: reverse-engineering", "", "- [-] reverse-engineering \u2014 EXECUTE", "",
    ].join("\n"), "utf-8");
    seedAuditFile(project);
    const store = codekbDir(project, codekbRepoName(project));
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "architecture.md"), "# Architecture\n", "utf-8");
    writeFileSync(join(store, "dependencies.md"), "# Dependencies\n", "utf-8");
    const gateStart = (): { status: number; out: string } => {
      const result = spawnSync(BUN, [STATE, "gate-start", "reverse-engineering", "--project-dir", project], {
        cwd: project,
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_DISABLE_SENSORS: "0",
          AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1",
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
          AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
          AIDLC_STAGE_GRAPH: graph,
          AIDLC_SENSORS_DIR: sensors,
          AIDLC_SENSOR_SCRIPT_DIR: scripts,
          AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: String(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
        },
      });
      return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    };

    const refused = gateStart().out;
    expect(refused).toMatch(/required-sections@[^;]*dependencies\.md: artifact changed during sensor evaluation/);
    expect(eventCount(audit(project), "SENSOR_FIRED")).toBe(1);
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain("- [-] reverse-engineering");

    const retried = gateStart();
    expect(retried.status, retried.out).toBe(0);
    const finalAudit = audit(project);
    expect(eventCount(finalAudit, "SENSOR_FIRED")).toBe(2);
    const gateRow = finalAudit.split("\n---\n").find((block) => block.includes("**Event**: STAGE_AWAITING_APPROVAL")) ?? "";
    const rel = `aidlc/spaces/default/codekb/${basename(store)}`;
    expect(gateRow).toContain(`**Sensor State**: required-sections@${rel}/architecture.md=passed`);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// A team's own blocking check on Requirements Analysis that finds something,
// through the graph and sensor seams setupFixture uses, over the stage as a run
// leaves it before its gate: summary confirmed, the reviewer's READY on record.
describe("t311 after the person picks Override blocking sensors", () => {
  const RA = "requirements-analysis";
  const SEAMS = ["AIDLC_STAGE_GRAPH", "AIDLC_SENSORS_DIR", "AIDLC_SENSOR_SCRIPT_DIR", "AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS"];
  afterAll(() => {
    for (const key of SEAMS) delete process.env[key];
  });

  function teamBlockingCheck(project: string): void {
    const sensors = join(project, ".test-sensors");
    const scripts = join(project, ".test-scripts");
    mkdirSync(sensors, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    const id = "gate-probe";
    const matches = "**/requirements.md";
    writeFileSync(join(sensors, `aidlc-${id}.md`), [
      "---", `id: ${id}`, "kind: deterministic", `command: bun .claude/tools/aidlc-sensor-${id}.ts`,
      "default_severity: blocking", "fire_on: gate", "description: a team's blocking check", "category: test",
      `matches: "${matches}"`, `timeout_seconds: ${NATIVE_STARTUP_TIMEOUT_MS / 1000}`, "---", "",
    ].join("\n"), "utf-8");
    writeFileSync(join(scripts, `aidlc-sensor-${id}.ts`),
      'process.stdout.write(JSON.stringify({ pass: false, findings_count: 1 }) + "\\n");\n', "utf-8");
    const stages = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8")) as Array<Record<string, unknown>>;
    const stage = stages.find((entry) => entry.slug === RA);
    if (stage === undefined) throw new Error(`no ${RA} in the shipped graph`);
    stage.sensors = [id];
    stage.sensors_applicable = [{ id, path: `.claude/sensors/aidlc-${id}.md`, fire_on: "gate", default_severity: "blocking", category: "test", matches }];
    const graph = join(project, "stage-graph.json");
    writeFileSync(graph, `${JSON.stringify(stages, null, 2)}\n`, "utf-8");
    Object.assign(process.env, {
      AIDLC_STAGE_GRAPH: graph,
      AIDLC_SENSORS_DIR: sensors,
      AIDLC_SENSOR_SCRIPT_DIR: scripts,
      AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: String(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
    });
  }

  for (const policy of ["strict", "off"] as const) {
    test(`Guard Policy ${policy}: next names the override report the refusal named, and the gate opens with the override on its row`, async () => {
      const project = createOrchestrationTestProject();
      projects.push(project);
      teamBlockingCheck(project);
      await reviewedStage(project);
      const statePath = seededStateFile(project);
      writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${policy} (set by you)`), "utf-8");
      const run = (tool: string, args: string[]) =>
        exec([BUN, tool, ...args, "--project-dir", project], { cwd: project, env: env(project) });

      const refused = await run(ORCHESTRATE, ["report", "--stage", RA, "--result", "awaiting-approval"]);
      const refusal = refused.stdout + refused.stderr;
      expect(refusal).toContain("Blocking gate sensor evaluation did not pass");
      expect(readFileSync(statePath, "utf-8")).toContain(`- [-] ${RA}`);
      const asked = await run(LOG, ["decision", "--stage", RA, "--decision", BLOCKING_SENSOR_OVERRIDE_DECISION,
        "--options", BLOCKING_SENSOR_OVERRIDE_OPTIONS.join(",")]);
      expect(asked.status, asked.stdout + asked.stderr).toBe(0);
      await say(project, "just approve it", "claude");
      const answered = await run(LOG, ["answer", "--stage", RA, "--details", BLOCKING_SENSOR_OVERRIDE_CHOICE]);
      expect(answered.status, answered.stdout + answered.stderr).toBe(0);

      const step = await next(project, []);
      expect(step.directive?.kind, step.out).toBe("print");
      const command = /`([^`]*--override-blocking-sensors[^`]*)`/.exec(String(step.directive?.message ?? ""))?.[1];
      expect(command, step.out).toBeDefined();
      // One spelling: the step names the report the refusal already named.
      expect(refusal.replaceAll('\\"', '"')).toContain(command as string);
      const argv = ((command as string).match(/"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^"|"$/g, ""));
      const reported = await run(ORCHESTRATE, argv.slice(2));
      expect(reported.status, reported.stdout + reported.stderr).toBe(0);
      expect(reported.stdout).not.toContain('"ask_type":"guard-recovery"');
      expect(readFileSync(statePath, "utf-8")).toContain(`- [?] ${RA}`);
      const gateRow = audit(project).split("\n---\n").filter((block) => block.includes("**Event**: STAGE_AWAITING_APPROVAL")).at(-1) ?? "";
      expect(gateRow).toContain("**Blocking Sensor Override**: true");
      expect(gateRow).toContain("**Blocking Sensor IDs**: gate-probe");
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
