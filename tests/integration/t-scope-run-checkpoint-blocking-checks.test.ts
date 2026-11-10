// covers: subcommand:aidlc-state:checkpoint-checks, subcommand:aidlc-bolt:checkpoint, function:hasBlockingSensorOverrideAuthorization
// covers: function:blockingSensorOverrideVerify, audit:CHECKPOINT_VERIFICATION_RECORDED, function:overrodeAtEarlierUnits
//
// A team's blocking gate check in solo work built Unit by Unit (classic,
// unit-major with Construction checkpoints), driven with no model
// (tests/harness/scope-run.ts). The check runs at each Unit's checkpoint, on
// that Unit's own files, before the person is asked to approve it: a failing
// Unit is met there, before the next Unit is built on it, and the late stage
// gate the engine approves itself does not check or ask about it again. A Unit
// whose approval carries no checks (approved with the checks off, as under an
// earlier AI-DLC) is checked once at that late gate (the matrix's upgrade cell). A checkpoint no
// person answers (Construction autonomy) runs no check: the run halts at the late gate, as it
// always has, and an Override is refused there. Two Units failing the same check are each
// asked, and the second Unit's refusal gives the line saying where the person overrode it.
// One ask that also offers the work's switch (the person named one check to switch off)
// takes either reach: the Override for this Unit, or every check off for the work. Work
// built stage by stage keeps its checks at the stage gate, its skeleton checkpoint
// included, so the person is asked there, as before, and not first at the skeleton. An
// advisory check still failing on a Unit's files is said once beside that Unit's
// checkpoint question, with no stop.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  AgentStandIn, auditEvents, createScopeProject, type Directive, field, PersonScript,
  SCOPE_RUN_TIMEOUT_MS, ScopeRunRefused, type ScopeHost,
} from "../harness/scope-run.ts";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
];
const OK = "RETENTION-OK";

// The team's check on Code Generation (blocking unless said), failing on the code summary
// of each Unit named (core by default) until it carries the line the team wants.
function installBlockingCheck(proj: string, failOn: string[] = ["core"], severity = "blocking"): void {
  writeFileSync(join(proj, ".claude", "sensors", "aidlc-retention.md"), [
    "---", "id: retention", "kind: deterministic", "command: bun .claude/tools/aidlc-sensor-retention.ts",
    `default_severity: ${severity}`, "description: The team's check on a Unit's summary", "category: document-shape",
    "fire_on: gate", 'matches: "**/intents/**"', "input_schema:", "  output_path: string", "  stage_slug: string",
    "output_schema:", "  pass: boolean", "  findings: string[]", "  findings_count: number", "timeout_seconds: 60",
    "---", "", "# retention", "",
  ].join("\n"));
  writeFileSync(join(proj, ".claude", "tools", "aidlc-sensor-retention.ts"), [
    'import { readFileSync } from "node:fs";',
    "export function main(argv: string[]): void {",
    '  const file = argv[argv.indexOf("--output-path") + 1];',
    `  const core = /[\\\\/](${failOn.join("|")})[\\\\/]code-generation[\\\\/]code-summary\\.md$/.test(file);`,
    `  const findings = core && !readFileSync(file, "utf-8").includes("${OK}") ? ["no retention line"] : [];`,
    "  console.log(JSON.stringify({ pass: findings.length === 0, findings, findings_count: findings.length }));",
    "}",
    "if (import.meta.main) main(process.argv.slice(2));",
    "",
  ].join("\n"));
  const stageFile = join(proj, ".claude", "aidlc-common", "stages", "construction", "code-generation.md");
  const text = readFileSync(stageFile, "utf-8");
  const bound = text.replace(/^sensors:\n/m, "sensors:\n  - retention\n");
  expect(bound).not.toBe(text);
  writeFileSync(stageFile, bound);
}

type Stop = { where: string; slug: string; unit: string | null; said: string };
const BLOCKING = /Blocking gate sensor evaluation did not pass|Refusing blocking sensor override/;

// Drive to the end, taking the person's pick at each blocking check: the stop
// is a refusal at a Unit's checkpoint, or the late gate's error.
const SWITCH_OFF = "Switch all checks off for this work";

function run(options: {
  move: "Fix findings" | "Override blocking sensors" | typeof SWITCH_OFF;
  failOn?: string[];
  // The check's question also offers the work's switch, as the sensors module asks
  // when the person named one check to switch off.
  offerSwitch?: boolean;
  severity?: "blocking" | "advisory";
  // What each Unit's checkpoint question was said beside (check_findings on its ask).
  findings?: Map<string, string[]>;
  flags?: string[];
  // Stage by stage, with the walking skeleton on (its checkpoint still asks the person).
  stageMajorSkeleton?: boolean;
  autonomy?: "Continue automatically" | "Review each checkpoint";
  beforeCore?: (host: ScopeHost, agent: AgentStandIn) => void;
}) {
  const { proj, host } = createScopeProject("empty");
  projects.push(proj);
  installBlockingCheck(proj, options.failOn, options.severity);
  if (options.findings) {
    const engine = host.engine.bind(host);
    host.engine = (...args: string[]) => {
      const ran = engine(...args);
      const unit = args[args.indexOf("--unit") + 1];
      if (args[0] === "bolt" && args.includes("ask") && ran.status === 0) {
        const said = (JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "{}") as { check_findings?: string }).check_findings;
        options.findings?.set(unit, [...(options.findings.get(unit) ?? []), ...(said === undefined ? [] : [said])]);
      }
      return ran;
    };
  }
  if (options.stageMajorSkeleton) {
    // The team's practice says skeleton on: the stance the agent reports.
    const engine = host.engine.bind(host);
    host.engine = (...args: string[]) =>
      engine(...args.map((arg, i) => (args[i - 1] === "--skeleton-stance" ? "on" : arg)));
  }
  expect(host.engine("graph", "compile").status).toBe(0);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["core", "extra"],
    until: (d: Directive) => BLOCKING.test(JSON.stringify(d)),
    answers: { autonomy: () => options.autonomy ?? "Review each checkpoint" },
    // The person asks for stage by stage once the Units are approved, in that message.
    afterApproval: (stage, self) => {
      if (options.stageMajorSkeleton && stage === "units-generation") {
        self.must("state", "set-construction-iteration", "stage-major", "--message", self.latestMessageId());
      }
      return undefined;
    },
  });
  const stops: Stop[] = [];
  let d = agent.begin("build the classic work", [
    "--scope", "classic", "--skip", SKIPPED.join(","), "--plan-approval", "on", ...(options.flags ?? []),
  ]);
  for (let round = 0; round < 8; round++) {
    let said: string;
    try {
      d = agent.drive(d);
      if (!BLOCKING.test(JSON.stringify(d))) break;
      said = String(d.message ?? JSON.stringify(d));
    } catch (error) {
      if (!(error instanceof ScopeRunRefused) || !BLOCKING.test(error.refusal)) throw error;
      said = error.refusal;
    }
    const m = /did not pass for \\?"([^"\\]+)\\?"(?: for unit \\?"([^"\\]+)\\?")?/.exec(said);
    const stop: Stop = { where: m?.[2] ? `checkpoint ${m[2]}` : `late gate ${m?.[1]}`, slug: m?.[1] ?? "", unit: m?.[2] ?? null, said };
    stops.push(stop);
    if (/Refusing blocking sensor override/.test(said)) break;
    const unitArgs = stop.unit ? ["--unit", stop.unit] : [];
    const offered = ["Fix findings", "Override blocking sensors", ...(options.offerSwitch ? [SWITCH_OFF] : [])];
    agent.must("log", "decision", "--stage", stop.slug, ...unitArgs, "--decision", "Blocking gate sensor failure",
      "--options", offered.join(","));
    agent.askPerson("blocking check", stop.slug, "A check failed on a code summary. What next?", offered, options.move);
    agent.must("log", "answer", "--stage", stop.slug, ...unitArgs, "--details", options.move);
    if (options.move === SWITCH_OFF) {
      // The switch is recorded with the message the person picked it in, as `next --sensors off` asks.
      const step = agent.next("--sensors", "off");
      const command = /Run `(.+? --message) '<id>'`/.exec(String(step.message ?? ""))?.[1];
      expect(command, JSON.stringify(step)).toBeDefined();
      expect(host.bash(`${command} ${agent.latestMessageId()}`).status).toBe(0);
      d = agent.next();
      continue;
    }
    if (options.move === "Fix findings") {
      const files = [...new Set([...said.matchAll(/@([^:;"\\]+?\.md): reported findings/g)].map((x) => x[1]))];
      for (const rel of files) host.write(rel, `${readFileSync(join(proj, rel), "utf-8")}\n${OK}\n`);
    } else {
      const retry = /Then retry: (.+?)\. Autonomous mode cannot override\./.exec(said)?.[1]?.replaceAll('\\"', '"');
      expect(retry, said).toBeDefined();
      const ran = host.bash(retry!);
      // A refused override comes back as the report's error step, or the verify's failure.
      if (ran.status !== 0 || /Refusing blocking sensor override/.test(`${ran.stdout}${ran.stderr}`)) {
        stops.push({ where: "override refused", slug: stop.slug, unit: stop.unit, said: `${ran.stdout}${ran.stderr}` });
        break;
      }
    }
    d = agent.next();
  }
  const rows = auditEvents(proj);
  const approvals = (unit: string) => rows.filter((r) =>
    r.event === "GATE_APPROVED" && field(r.block, "Checkpoint") === "construction-unit" && field(r.block, "Unit") === unit).length;
  const checkAsked = agent.asked.filter((a) => a.what === "blocking check").length;
  return { proj, host, agent, d, stops, rows, approvals, checkAsked };
}

describe("a team's blocking check in solo work built Unit by Unit", () => {
  test("Fix findings: core's check is met at core's checkpoint, before extra is built, and never at the late gate", () => {
    const r = run({ move: "Fix findings" });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops.map((s) => s.where)).toEqual(["checkpoint core"]);
    // extra's work had not started when the check stopped core.
    const firstStop = r.rows.findIndex((row) => row.event === "SENSOR_FAILED" && field(row.block, "Sensor ID") === "retention");
    const extraStarted = r.rows.findIndex((row) => row.event === "UNIT_STARTED" && field(row.block, "Unit") === "extra");
    expect(firstStop).toBeGreaterThan(-1);
    expect(extraStarted === -1 || extraStarted > firstStop).toBe(true);
    // Each Unit is approved once, and the check's question is asked once.
    expect(r.approvals("core")).toBe(1);
    expect(r.approvals("extra")).toBe(1);
    expect(r.checkAsked).toBe(1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("Override at core's checkpoint is recorded with the Unit and not asked again at the late gate", () => {
    const r = run({ move: "Override blocking sensors" });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops.map((s) => s.where)).toEqual(["checkpoint core"]);
    expect(r.checkAsked).toBe(1);
    expect(r.approvals("core")).toBe(1);
    const verified = r.rows.filter((row) =>
      row.event === "CHECKPOINT_VERIFICATION_RECORDED" && field(row.block, "Unit") === "core" && field(row.block, "Verified") === "true");
    expect(field(verified.at(-1)!.block, "Blocking Checks")).toMatch(/^code-generation:retention@[0-9a-f]{12}=overridden$/);
    expect(field(verified.at(-1)!.block, "Blocking Sensor Override")).toBe("true");
    // The late gate checked nothing of core's.
    const lateFires = r.rows.filter((row) =>
      row.event === "SENSOR_FIRED" && field(row.block, "Sensor ID") === "retention" && field(row.block, "Unit") === null);
    expect(lateFires.length).toBe(0);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("Override at two failing Units: each is asked, and extra's refusal says the person overrode the check at core", () => {
    const r = run({ move: "Override blocking sensors", failOn: ["core", "extra"] });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops.map((s) => s.where)).toEqual(["checkpoint core", "checkpoint extra"]);
    expect(r.checkAsked).toBe(2);
    expect(r.stops[0].said).not.toContain("You overrode");
    expect(r.stops[1].said).toMatch(/Say to the person, just before the question: \\?"You overrode the <check> for the core Unit\.\\?"/);
    const overridden = (unit: string) => r.rows.filter((row) =>
      row.event === "CHECKPOINT_VERIFICATION_RECORDED" && field(row.block, "Unit") === unit && field(row.block, "Verified") === "true")
      .at(-1);
    expect(field(overridden("core")!.block, "Blocking Checks")).toMatch(/=overridden$/);
    expect(field(overridden("extra")!.block, "Blocking Checks")).toMatch(/=overridden$/);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("Fix at core says nothing of an Override at extra's refusal", () => {
    const r = run({ move: "Fix findings", failOn: ["core", "extra"] });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops.map((s) => s.where)).toEqual(["checkpoint core", "checkpoint extra"]);
    expect(r.stops.map((s) => s.said).join("\n")).not.toContain("You overrode");
  }, SCOPE_RUN_TIMEOUT_MS);

  test("one ask offering the work's switch beside the Override: picking the Override covers core's findings, asked once", () => {
    const r = run({ move: "Override blocking sensors", offerSwitch: true });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops.map((s) => s.where)).toEqual(["checkpoint core"]);
    expect(r.checkAsked).toBe(1);
    const verified = r.rows.filter((row) =>
      row.event === "CHECKPOINT_VERIFICATION_RECORDED" && field(row.block, "Unit") === "core" && field(row.block, "Verified") === "true");
    expect(field(verified.at(-1)!.block, "Blocking Sensor Override")).toBe("true");
  }, SCOPE_RUN_TIMEOUT_MS);

  test("one ask offering the work's switch: picking the switch turns every check off for the work, and no later Unit is asked", () => {
    const r = run({ move: SWITCH_OFF, offerSwitch: true, failOn: ["core", "extra"] });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops.map((s) => s.where)).toEqual(["checkpoint core"]);
    expect(r.checkAsked).toBe(1);
    expect(r.approvals("core")).toBe(1);
    expect(r.approvals("extra")).toBe(1);
    // After the switch no check fires again, at extra's checkpoint or the late gate.
    const switched = r.rows.findIndex((row) => row.event === "QUESTION_ANSWERED" && field(row.block, "Details") === SWITCH_OFF);
    expect(switched).toBeGreaterThan(-1);
    expect(r.rows.slice(switched).filter((row) => row.event === "SENSOR_FIRED" && field(row.block, "Sensor ID") === "retention"))
      .toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("stage by stage with the skeleton on: the check is met at the stage gate, as before, never at the skeleton's checkpoint", () => {
    const r = run({ move: "Fix findings", stageMajorSkeleton: true });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.rows.some((row) => row.event === "GATE_APPROVED" && field(row.block, "Checkpoint") === "walking-skeleton"))
      .toBe(true);
    expect(r.stops.map((s) => s.where)).toEqual(["late gate code-generation"]);
    expect(r.checkAsked).toBe(1);
    // The skeleton's checkpoint fired no check: the stage gate is the one place.
    const verification = r.rows.find((row) => row.event === "CHECKPOINT_VERIFICATION_RECORDED" && field(row.block, "Unit") === "core");
    expect(field(verification!.block, "Blocking Checks")).toBeNull();
  }, SCOPE_RUN_TIMEOUT_MS);

  test("an advisory check still failing on core's summary is said once beside core's checkpoint question, with no stop", () => {
    const findings = new Map<string, string[]>();
    const r = run({ move: "Fix findings", severity: "advisory", findings });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops).toEqual([]);
    expect(r.checkAsked).toBe(0);
    expect(r.approvals("core")).toBe(1);
    expect(r.approvals("extra")).toBe(1);
    expect(findings.get("core")).toHaveLength(1);
    expect(findings.get("core")?.[0]).toMatch(/retention/);
    expect(findings.get("core")?.[0]).toMatch(/code-summary\.md/);
    // extra's summary passes the team's check: its line, if any, is about another check.
    expect((findings.get("extra") ?? []).join(" ")).not.toMatch(/retention/);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("with the checks off for the work, nothing fires and nothing is asked, at the checkpoint or the late gate", () => {
    const r = run({
      move: "Fix findings",
      flags: ["--sensors", "off"],
    });
    expect(r.d).toMatchObject({ kind: "done" });
    expect(r.stops).toEqual([]);
    const fires = r.rows.filter((row) => row.event === "SENSOR_FIRED" && field(row.block, "Sensor ID") === "retention");
    expect(fires.length).toBe(0);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("under Continue automatically no person answers a checkpoint: the run halts at the late gate as it always has, and an Override is refused there", () => {
    const r = run({ move: "Override blocking sensors", autonomy: "Continue automatically" });
    expect(r.stops[0]?.where).toBe("late gate code-generation");
    expect(r.stops.at(-1)?.where).toBe("override refused");
    expect(r.stops.at(-1)?.said).toContain("Construction Autonomy Mode is autonomous");
    expect(r.stops.at(-1)?.said).toContain("set-autonomy --mode gated");
    // No checkpoint ran the check: nobody was there to answer it.
    expect(r.rows.filter((row) => row.event === "SENSOR_FIRED" && field(row.block, "Sensor ID") === "retention" &&
      field(row.block, "Unit") !== null)).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);
});
