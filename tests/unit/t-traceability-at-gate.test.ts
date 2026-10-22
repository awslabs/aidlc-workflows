// covers: file:sensors/aidlc-traceability.md, subcommand:aidlc-orchestrate:report
//
// The traceability check speaks at a gate about the finished tables. It ran on
// every write, so a table written before its stories or its code said "reports
// N findings" at the gate when the last write's result was a failure, though
// the finished files were fine. Now it runs when the gate opens, on each table
// the stage declares, and says nothing when they are complete; a real gap is
// still said in the same one line, and Approve still goes on.
//
// A later stage starts its table with the tool (`--write-upstream`): the IDs
// come from the same resolver the check uses, so a table the agent fills
// row by row opens a gate with nothing to say. With no Requirements Analysis
// record the check reads requirements.md's FR1 and NFR1 IDs, as before the
// record: one the table leaves out is said, and a team's own form adds no line.
//
// The Requirements Analysis gate open across the update that adds its record to
// what the stage produces: the review receipt it holds lists one more declared
// output, so it reads stale at Approve. Under relaxed and off the person's
// Approve goes through with one line; under strict the agent runs the one
// recovery review it is handed, and the same Approve goes through.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  auditBlockField,
  readAuditShardEvents,
  setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  FIXTURES_DIR,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CHECK_LINE = "The traceability check reports";
const projects: string[] = [];
afterAll(() => {
  for (const dir of projects) cleanupTestProject(dir);
});

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "",
    ...extra,
  };
  // The checks under test run; a session of the chat running the tests is not this project's.
  for (const key of ["AIDLC_DISABLE_SENSORS", "AIDLC_UNATTENDED", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function engine(proj: string, env: NodeJS.ProcessEnv, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), ...args], {
    cwd: proj,
    input,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
  });
  return { status: result.status, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function reply(proj: string, env: NodeJS.ProcessEnv, args: string[]): Record<string, unknown> {
  const result = engine(proj, env, args);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

function recordFile(proj: string, rel: string, body: string): string {
  const path = join(seededRecordDir(proj), ...rel.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

const READY_REVIEW = (reviewer: string, iteration: number): string => [
  "## Review",
  "",
  "**Verdict:** READY",
  `**Reviewer:** ${reviewer}`,
  `**Iteration:** ${iteration}`,
  "",
  "### Findings",
  "",
  "**Prior findings**",
  "",
  "| ID | Now | Severity | Note |",
  "|---|---|---|---|",
  "",
  "**New findings**",
  "",
  "| Severity | Location | Finding | Required action |",
  "|---|---|---|---|",
  "",
].join("\n");

// One READY review of the stage's current output, through the logger.
function review(proj: string, env: NodeJS.ProcessEnv, stage: string, reviewer: string, iteration: number): void {
  const base = ["engine", "log", "review", "--stage", stage, "--reviewer", reviewer, "--iteration", String(iteration)];
  const requested = reply(proj, env, base);
  writeFileSync(join(proj, String(requested.reviewFile)), READY_REVIEW(reviewer, iteration));
  const recorded = engine(proj, env, [...base, "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
}

describe("t-traceability-at-gate: the check reads the finished tables when the gate opens", () => {
  // The checks under test run at the gate; the fixture's other gate checks stand aside.
  const ENV = baseEnv({
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SKIP_REVIEWER_GATE_GUARD: "0",
    AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1",
    AIDLC_DISABLE_COLLABORATORS: "1",
  });
  const STAGE = "user-stories";

  // A feature-scope record at User Stories, Requirements Analysis approved with its record.
  function project(): { proj: string; table: string } {
    const proj = setupIntegrationProject({ stripEnvScope: true });
    projects.push(proj);
    const state = readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
      .replace("**Scope**: bugfix", "**Scope**: feature")
      .replace("- [-] requirements-analysis \u2014 EXECUTE", "- [x] requirements-analysis \u2014 EXECUTE")
      .replace("- [S] user-stories \u2014 SKIP (bugfix scope)", "- [-] user-stories \u2014 EXECUTE")
      .replace("**Current Stage**: requirements-analysis", "**Current Stage**: user-stories")
      .replace("**In Progress**: requirements-analysis", "**In Progress**: user-stories");
    mkdirSync(seededRecordDir(proj), { recursive: true });
    writeFileSync(seededStateFile(proj), state);
    recordFile(proj, "inception/requirements-analysis/requirements.md", "# Requirements\n\n### FR-1: Sign up\n### FR-2: Browse\n### NFR-1: Security\n");
    recordFile(proj, "inception/requirements-analysis/traceability.json", JSON.stringify({
      stage: "requirements-analysis",
      ids: [{ id: "FR-1", kind: "functional" }, { id: "FR-2", kind: "functional" }, { id: "NFR-1", kind: "non-functional" }],
    }));
    recordFile(proj, "inception/user-stories/stories.md", "# Stories\n\n## US1.1 Sign up\n- AC1.1.1 works\n");
    return { proj, table: join(seededRecordDir(proj), "inception", STAGE, "traceability.json") };
  }

  function writeTable(path: string, rows: Array<{ id: string; status: string; target?: string }>): void {
    writeFileSync(path, `${JSON.stringify({ stage: STAGE, upstream_ids: rows.map((row) => row.id), coverage: rows }, null, 2)}\n`);
  }

  function openGate(proj: string): Record<string, unknown> {
    review(proj, ENV, STAGE, "aidlc-product-lead-agent", 1);
    const opened = reply(proj, ENV, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "awaiting-approval"]);
    expect(opened.kind, JSON.stringify(opened)).toBe("print");
    return opened;
  }

  function gateRowSensorState(proj: string): string {
    const row = readAuditShardEvents(proj).filter((event) => event.event === "STAGE_AWAITING_APPROVAL").at(-1);
    return auditBlockField(row?.block ?? "", "Sensor State") ?? "";
  }

  // Approve goes on and the walk moves past User Stories.
  function approveMovesOn(proj: string): void {
    const approved = reply(proj, ENV, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]);
    expect(String(approved.kind), JSON.stringify(approved)).not.toBe("ask");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(/^- \[x\] user-stories/m);
    const next = reply(proj, ENV, ["engine", "orchestrate", "next"]);
    expect(next.stage, JSON.stringify(next)).not.toBe(STAGE);
  }

  test("every stage that imports the check binds it at the gate", () => {
    const { proj } = project();
    const graph = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "stage-graph.json"), "utf-8")) as Array<{
      slug: string;
      sensors_applicable?: Array<{ id: string; fire_on?: string }>;
    }>;
    const bindings = graph.flatMap((stage) =>
      (stage.sensors_applicable ?? []).filter((sensor) => sensor.id === "traceability").map((sensor) => `${stage.slug}:${sensor.fire_on}`));
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.filter((binding) => !binding.endsWith(":gate"))).toEqual([]);
  });

  test("a table checked before its stories were finished reads clean at the gate on the finished files", () => {
    const { proj, table } = project();
    writeTable(table, [
      { id: "FR-1", status: "OK", target: "US1.1" },
      { id: "FR-2", status: "OK", target: "US1.2" },
      { id: "NFR-1", status: "Deferred", target: "nfr-requirements" },
    ]);
    // What the write-time check ran on that write: US1.2 was not written yet.
    const early = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc-sensor.ts"), "fire", "traceability", "--stage", STAGE, "--output-path", table], {
      cwd: proj,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      env: { ...ENV, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    });
    expect(early.stdout, early.stderr).toContain('"result":"failed"');
    recordFile(proj, "inception/user-stories/stories.md", "# Stories\n\n## US1.1 Sign up\n- AC1.1.1 works\n\n## US1.2 Browse\n- AC1.2.1 works\n");

    const opened = openGate(proj);
    expect(String(opened.narration ?? "")).not.toContain(CHECK_LINE);
    const rel = relative(proj, table).replaceAll("\\", "/");
    expect(gateRowSensorState(proj)).toContain(`traceability@${rel}=passed`);
  });

  test("a real gap is said in one line at the gate, and Approve still goes on", () => {
    const { proj, table } = project();
    writeTable(table, [
      { id: "FR-1", status: "OK", target: "US1.1" },
      { id: "FR-2", status: "GAP" },
      { id: "NFR-1", status: "Deferred", target: "nfr-requirements" },
    ]);
    const opened = openGate(proj);
    expect(String(opened.narration ?? "")).toContain("The traceability check reports 1 finding in traceability.json.");
    approveMovesOn(proj);
  });

  test("a table started by the tool and filled row by row opens a gate with nothing to say", () => {
    const { proj, table } = project();
    const started = engine(proj, ENV, ["engine", "sensor-traceability", "--stage", STAGE, "--output-path", table, "--write-upstream"]);
    expect(started.status, started.out).toBe(0);
    expect(JSON.parse(started.stdout.trim()).upstream_ids).toEqual(["FR-1", "FR-2", "NFR-1"]);
    // The agent sets each row's status and target.
    const filled = JSON.parse(readFileSync(table, "utf-8"));
    filled.coverage = filled.coverage.map((row: { id: string }) =>
      row.id === "NFR-1" ? { id: row.id, status: "Deferred", target: "nfr-requirements" } : { id: row.id, status: "OK", target: "US1.1" });
    writeFileSync(table, JSON.stringify(filled, null, 2));
    // Started again, it changes nothing.
    const bytes = readFileSync(table, "utf-8");
    expect(engine(proj, ENV, ["engine", "sensor-traceability", "--stage", STAGE, "--output-path", table, "--write-upstream"]).status).toBe(0);
    expect(readFileSync(table, "utf-8")).toBe(bytes);

    const opened = openGate(proj);
    expect(String(opened.narration ?? "")).not.toContain(CHECK_LINE);
    approveMovesOn(proj);
  });

  // Work begun before Requirements Analysis recorded its IDs: the check reads
  // requirements.md as it did before, so a requirement the table leaves out is
  // said, and a team's own form there adds no line.
  test("with no record, a requirement the table leaves out is said at the gate; a team's own form says nothing", () => {
    const left = project();
    rmSync(join(seededRecordDir(left.proj), "inception", "requirements-analysis", "traceability.json"));
    recordFile(left.proj, "inception/requirements-analysis/requirements.md", "# Requirements\n\n- FR1 Sign up\n- FR2 Browse\n- NFR1 Security\n");
    writeTable(left.table, [
      { id: "FR1", status: "OK", target: "US1.1" },
      { id: "NFR1", status: "Deferred", target: "nfr-requirements" },
    ]);
    expect(String(openGate(left.proj).narration ?? "")).toContain("The traceability check reports 1 finding in traceability.json.");

    const team = project();
    rmSync(join(seededRecordDir(team.proj), "inception", "requirements-analysis", "traceability.json"));
    writeTable(team.table, [
      { id: "FR-1", status: "OK", target: "US1.1" },
      { id: "FR-2", status: "OK", target: "US1.1" },
      { id: "NFR-1", status: "Deferred", target: "nfr-requirements" },
    ]);
    expect(String(openGate(team.proj).narration ?? "")).not.toContain(CHECK_LINE);
  });
});

describe("t-traceability-at-gate: the Requirements Analysis gate open across the update", () => {
  const STAGE = "requirements-analysis";
  const REVIEWER = "aidlc-product-lead-agent";
  const SESSION = "ra-gate-update";
  const ENV = baseEnv({ AIDLC_SKIP_REVIEWER_GATE_GUARD: "0", AIDLC_SKIP_ARTIFACT_GUARD: "0" });
  delete ENV.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;


  function personSays(proj: string, prompt: string): void {
    const result = engine(proj, ENV, ["engine", "hook", "record-human-turn"], JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt,
    }));
    expect(result.status, result.out).toBe(0);
  }

  // The gate opened and reviewed under the graph from before the update, then
  // the update recompiles it with the record in what the stage produces.
  function gateOpenAcrossTheUpdate(policy: "strict" | "relaxed" | "off"): string {
    const proj = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
    projects.push(proj);
    const statePath = seededStateFile(proj);
    writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${policy} (set by you)`));
    const graphPath = join(proj, ".claude", "tools", "data", "stage-graph.json");
    const shipped = readFileSync(graphPath, "utf-8");
    const graph = JSON.parse(shipped) as Array<{ slug: string; produces?: string[]; optional_produces?: string[] }>;
    const stage = graph.find((entry) => entry.slug === STAGE)!;
    expect(stage.optional_produces).toContain("traceability");
    stage.optional_produces = stage.optional_produces!.filter((name) => name !== "traceability");
    writeFileSync(graphPath, JSON.stringify(graph));

    recordFile(proj, `inception/${STAGE}/requirements.md`, "# Requirements\n\n- FR1 Sign up\n");
    recordFile(proj, `inception/${STAGE}/${STAGE}-questions.md`, "# Questions\n");
    review(proj, ENV, STAGE, REVIEWER, 1);
    reply(proj, ENV, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "awaiting-approval"]);

    writeFileSync(graphPath, shipped);
    expect(existsSync(join(seededRecordDir(proj), "inception", STAGE, "traceability.json"))).toBe(false);
    personSays(proj, "Approve");
    return proj;
  }

  const approve = (proj: string) =>
    reply(proj, ENV, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]);

  for (const policy of ["relaxed", "off"] as const) {
    test(`${policy}: the person's Approve goes through, with one line`, () => {
      const proj = gateOpenAcrossTheUpdate(policy);
      const approved = approve(proj);
      expect(approved.kind, JSON.stringify(approved)).toBe("done");
      expect(approved.change_notices).toEqual(["The Requirements Analysis documents changed after they were reviewed; carrying on."]);
      expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(/^- \[x\] requirements-analysis/m);
    });
  }

  test("strict: the agent runs the one recovery review it is handed, and the same Approve goes through", () => {
    const proj = gateOpenAcrossTheUpdate("strict");
    const refused = approve(proj);
    expect(refused.kind, JSON.stringify(refused)).toBe("ask");
    expect(refused.reason_codes).toEqual(["ARTIFACT_REVIEW_STALE"]);
    const remedies = refused.remedies as Array<{ op: string; requiresHuman: boolean }>;
    expect(remedies.map((remedy) => [remedy.op, remedy.requiresHuman])).toEqual([["start-recovery-review", false]]);
    review(proj, ENV, STAGE, REVIEWER, 2);
    const approved = approve(proj);
    expect(approved.kind, JSON.stringify(approved)).toBe("done");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(/^- \[x\] requirements-analysis/m);
  });

  // Work already at Requirements Analysis when the person updates (its
  // documents written, no record yet), or an agent that did not write the
  // record: the record is not a required output, so the review starts, the gate
  // opens and the person's Approve goes through, under every Guard Policy.
  for (const policy of ["strict", "off"] as const) {
    test(`${policy}: with no record, the review starts and the person's Approve goes through`, () => {
      const proj = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
      projects.push(proj);
      const statePath = seededStateFile(proj);
      writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${policy} (set by you)`));
      recordFile(proj, `inception/${STAGE}/requirements.md`, "# Requirements\n\n- FR1 Sign up\n");
      recordFile(proj, `inception/${STAGE}/${STAGE}-questions.md`, "# Questions\n");
      review(proj, ENV, STAGE, REVIEWER, 1);
      const opened = reply(proj, ENV, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "awaiting-approval"]);
      expect(opened.kind, JSON.stringify(opened)).toBe("print");
      personSays(proj, "Approve");
      const approved = approve(proj);
      expect(approved.kind, JSON.stringify(approved)).toBe("done");
      expect(approved.change_notices).toBeUndefined();
      expect(existsSync(join(seededRecordDir(proj), "inception", STAGE, "traceability.json"))).toBe(false);
    });
  }
});
