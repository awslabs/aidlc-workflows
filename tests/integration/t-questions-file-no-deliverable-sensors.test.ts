// covers: function:gateSensorOutputs, function:stageDeliverablePaths,

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { auditBlockField, readAuditShardEvents } from "../../core/tools/aidlc-record-core.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const SHIPPED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const SENSORS = join(AIDLC_SRC, "sensors");
const TOOLS = join(AIDLC_SRC, "tools");
const STAGE = "intent-capture";

const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

interface Fixture {
  project: string;
  graph: string;
  stageDir: string;
}

function setup(): Fixture {
  const project = createTestProject();
  projects.push(project);

  const shipped = JSON.parse(readFileSync(SHIPPED_GRAPH, "utf-8")) as Array<Record<string, unknown>>;
  const node = shipped.find((stage) => stage.slug === STAGE);
  if (node === undefined) throw new Error(`shipped graph has no ${STAGE} node`);
  const rest = { ...node };
  delete rest.summary_confirmation;
  delete rest.reviewer;
  delete rest.review_artifact;
  const graph = join(project, "stage-graph.json");
  writeFileSync(graph, `${JSON.stringify([rest], null, 2)}\n`, "utf-8");

  writeFileSync(
    seededStateFile(project),
    [
      "# AI-DLC State Tracking",
      "",
      "- **Workflow**: mvp",
      "- **State Version**: 8",
      "- **Scope**: mvp",
      "- **Phase**: ideation",
      `- **Current Stage**: ${STAGE}`,
      "",
      `- [-] ${STAGE} — EXECUTE`,
      "",
    ].join("\n"),
    "utf-8",
  );
  seedAuditFile(project);

  const stageDir = join(seededRecordDir(project), "ideation", STAGE);
  mkdirSync(stageDir, { recursive: true });
  return { project, graph, stageDir };
}

function writeQuestions(fixture: Fixture): string {
  const path = join(fixture.stageDir, `${STAGE}-questions.md`);
  writeFileSync(
    path,
    [
      "# Intent Capture Questions",
      "",
      "## Sources",
      "",
      '- [desc] Initial description: "Echo the text I give it, locally."',
      "",
      "## Q1. Who is this for?",
      "",
      "A. A small team.",
      "X. Other (please specify)",
      "",
      "[Answer]: A. A small team.",
      "",
    ].join("\n"),
    "utf-8",
  );
  return path;
}

function gate(fixture: Fixture): { status: number; out: string } {
  const result = spawnSync(
    BUN,
    [STATE, "gate-start", STAGE, "--project-dir", fixture.project],
    {
      cwd: fixture.project,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_STAGE_GRAPH: fixture.graph,
        AIDLC_SENSORS_DIR: SENSORS,
        AIDLC_SENSOR_SCRIPT_DIR: TOOLS,
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS: String(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
      },
      timeout: NATIVE_RUNTIME_CASE_TIMEOUT_MS,
    },
  );
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

interface SensorRow {
  event: string;
  sensor: string;
  output: string;
  detail: string | null;
}

function sensorRows(project: string): SensorRow[] {
  return readAuditShardEvents(project)
    .filter((row) => row.event.startsWith("SENSOR_"))
    .map((row) => ({
      event: row.event,
      sensor: auditBlockField(row.block, "Sensor ID") ?? "",
      output: auditBlockField(row.block, "Output path") ?? "",
      detail: auditBlockField(row.block, "Detail path"),
    }));
}

describe("#4074 a stage's questions file draws no deliverable sensor", () => {
  test("a questions file written before its deliverables fires nothing on it", () => {
    const fixture = setup();
    const questions = writeQuestions(fixture);

    const opened = gate(fixture);
    expect(opened.status).toBe(0);
    expect(opened.out).toContain("awaiting-approval");

    const rel = (path: string) => relative(fixture.project, path).split("\\").join("/");
    expect(sensorRows(fixture.project).filter((row) => row.output === rel(questions))).toEqual([]);
  });

  test("a deliverable written beside it still draws the check, and still fails on it", () => {
    const fixture = setup();
    const questions = writeQuestions(fixture);
    writeFileSync(
      join(fixture.stageDir, "intent-statement.md"),
      [
        "# Intent Statement",
        "",
        "## Sources",
        "",
        '- [desc] Initial description: "Echo the text I give it, locally."',
        "",
        "## Assumptions & Open Questions",
        "",
        "- The team works offline sometimes.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const opened = gate(fixture);
    expect(opened.status).toBe(0);

    const rows = sensorRows(fixture.project);
    const failed = rows.filter((row) => row.event === "SENSOR_FAILED");
    expect(failed.map((row) => row.sensor)).toContain("claim-sources");
    const claimFailure = failed.filter((row) => row.sensor === "claim-sources");
    expect(claimFailure).toHaveLength(1);
    const rel = (path: string) => relative(fixture.project, path).split("\\").join("/");
    expect(claimFailure[0]?.output).toBe(rel(join(fixture.stageDir, "intent-statement.md")));
    expect(claimFailure[0]?.detail).not.toBeNull();
    expect(rows.some((row) => row.output === rel(questions))).toBe(false);
  });

  test("the untagged-assumption finding carries the fix the issue asks for", () => {
    const fixture = setup();
    writeQuestions(fixture);
    writeFileSync(
      join(fixture.stageDir, "intent-statement.md"),
      [
        "# Intent Statement",
        "",
        "## Assumptions & Open Questions",
        "",
        "- The team works offline sometimes.",
        "",
      ].join("\n"),
      "utf-8",
    );

    gate(fixture);
    const detail = sensorRows(fixture.project).find(
      (row) => row.event === "SENSOR_FAILED" && row.sensor === "claim-sources",
    )?.detail;
    expect(detail).toBeTruthy();
    const body = readFileSync(join(fixture.project, detail as string), "utf-8");
    expect(body).toContain("assumption/open question lacks [assumption]");
    expect(body).toContain("Prefix each assumption or open question with [assumption].");
  });

  test("unreferenced upstream artifacts keep their slugs and gain the way to cover them", () => {
    const project = createTestProject();
    projects.push(project);
    const stageDir = join(seededRecordDir(project), "ideation", STAGE);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "intent-statement.md"), "# Intent Statement\n\nProse only.\n", "utf-8");

    const fired = spawnSync(
      BUN,
      [
        join(TOOLS, "aidlc-sensor-upstream-coverage.ts"),
        "--stage", STAGE,
        "--output-path", join(stageDir, "intent-statement.md"),
        "--consumes", "team-practices:practices-discovery",
        "--deliverables", "intent-statement",
      ],
      { cwd: project, encoding: "utf-8", env: { ...process.env, AIDLC_PROJECT_DIR: project } },
    );
    expect(fired.status).toBe(0);
    const result = JSON.parse(fired.stdout.trim()) as {
      pass: boolean;
      unreferenced: string[];
      message?: string;
    };
    expect(result.pass).toBe(false);
    expect(result.unreferenced).toEqual(["team-practices"]);
    expect(result.message).toContain("Name each one in a deliverable");
  });
});
