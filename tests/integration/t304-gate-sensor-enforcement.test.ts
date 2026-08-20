// covers: subcommand:aidlc-state:gate-start, subcommand:aidlc-sensor:fire,
//         audit:SENSOR_FIRED, audit:SENSOR_FAILED
//
// Gate-bound sensor integration: state dispatches outside its transaction,
// blocking failures refuse the transition, the explicit override is audited,
// and advisory failures preserve the historical non-blocking behavior.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

interface Fixture {
  project: string;
  graph: string;
  sensors: string;
  scripts: string;
}

function setupFixture(severity: "advisory" | "blocking"): Fixture {
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
      'matches: "**/*"',
      "timeout_seconds: 5",
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(scripts, `aidlc-sensor-${id}.ts`),
    [
      'process.stdout.write(JSON.stringify({ pass: false, findings_count: 1 }) + "\\n");',
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
            matches: "**/*",
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
  return { project, graph, sensors, scripts };
}

function gate(
  fixture: Fixture,
  extra: string[] = [],
): { status: number; out: string } {
  const result = spawnSync(
    BUN,
    [
      STATE,
      "gate-start",
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

describe("t304 gate-bound sensor enforcement", () => {
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

    const overridden = gate(blocking, ["--override-blocking-sensors"]);
    const overrideAudit = audit(blocking.project);
    expect(overridden.status).toBe(0);
    expect(readFileSync(seededStateFile(blocking.project), "utf-8")).toContain(
      "- [?] probe",
    );
    expect(eventCount(overrideAudit, "SENSOR_FIRED")).toBe(4);
    expect(overrideAudit).toContain("**Blocking Sensor Override**: true");
    expect(overrideAudit).toContain("**Blocking Sensor IDs**: gate-probe");
    expect(overrideAudit).toContain("**Blocking Sensor Detail Paths**:");

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
});
