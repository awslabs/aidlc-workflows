// covers: subcommand:aidlc-orchestrate:next, function:switchAnswersOpenCheck, audit:QUESTION_ANSWERED, audit:CEREMONY_SET
//
// #3644: the person answers a team's blocking check's question by switching the
// checks off for the piece of work. The switch is their answer: the step the
// agent gets from `next --sensors off` turns the checks off, records that
// answer on the check's question with their words, and goes on to the next
// step in the same turn, with the "Sensors changed" line said once. Driven with
// no model (tests/harness/scope-run.ts), in solo work built Unit by Unit
// (classic): at a Unit's checkpoint (the question under the stage whose file
// failed, which need not be Current Stage) and at the stage gate after the last
// Unit, under each Guard Policy. Where the open question is not the check's (a
// question logged after it), the step reads as it always has, and no answer
// lands on either question; an agent that runs the switch again finds nothing
// left to answer; a setter that refuses leaves the question open.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockingSensorPicks, hasBlockingSensorOverrideAuthorization } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  AgentStandIn, auditEvents, createScopeProject, type Directive, field, PersonScript,
  SCOPE_RUN_TIMEOUT_MS, ScopeRunRefused,
} from "../harness/scope-run.ts";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
];
const SWITCH = "Switch all checks off for this work";
const WORDS = "switch the checks off for this work and carry on";
const DECISION = "Blocking gate sensor failure";
const BLOCKING = /Blocking gate sensor evaluation did not pass|Refusing blocking sensor override/;

// The team's blocking check, failing on core's output of `stage` (its file `file`).
function installCheck(proj: string, stage: string, file: string): void {
  writeFileSync(join(proj, ".claude", "sensors", "aidlc-retention.md"), [
    "---", "id: retention", "kind: deterministic", "command: bun .claude/tools/aidlc-sensor-retention.ts",
    "default_severity: blocking", "description: The team's check on a Unit's document", "category: document-shape",
    "fire_on: gate", 'matches: "**/intents/**"', "input_schema:", "  output_path: string", "  stage_slug: string",
    "output_schema:", "  pass: boolean", "  findings: string[]", "  findings_count: number", "timeout_seconds: 60",
    "---", "", "# retention", "",
  ].join("\n"));
  writeFileSync(join(proj, ".claude", "tools", "aidlc-sensor-retention.ts"), [
    "export function main(argv: string[]): void {",
    '  const out = argv[argv.indexOf("--output-path") + 1];',
    `  const core = /[\\\\/]core[\\\\/]${stage}[\\\\/]${file.replace(".", "\\.")}$/.test(out);`,
    '  const findings = core ? ["no retention line"] : [];',
    "  console.log(JSON.stringify({ pass: findings.length === 0, findings, findings_count: findings.length }));",
    "}",
    "if (import.meta.main) main(process.argv.slice(2));",
    "",
  ].join("\n"));
  const stageFile = join(proj, ".claude", "aidlc-common", "stages", "construction", `${stage}.md`);
  const text = readFileSync(stageFile, "utf-8");
  const bound = text.replace(/^sensors:\n/m, "sensors:\n  - retention\n");
  expect(bound).not.toBe(text);
  writeFileSync(stageFile, bound);
}

type SwitchStep = { message: string; outputs: string[]; ranNext: boolean };

// Drive to the first blocking check, put its question to the person, who
// answers by switching the checks off, and follow the switch's step as the
// agent does: each command it names in order (their message for '<id>'), then
// `next` when the step goes on. `beforeAnswer` runs after the question is
// asked (a question logged after it); `again` runs the switch a second time
// instead of `next`.
function walk(options: {
  stage?: string;
  file?: string;
  skipped?: string[];
  flags?: string[];
  late?: boolean;
  beforeAnswer?: (agent: AgentStandIn, stop: { slug: string; unit: string | null }) => void;
  again?: boolean;
  setterMessage?: string;
  finish?: boolean;
}) {
  const stage = options.stage ?? "code-generation";
  const file = options.file ?? "code-summary.md";
  const { proj, host } = createScopeProject("empty");
  projects.push(proj);
  if (!options.late) installCheck(proj, stage, file);
  expect(host.engine("graph", "compile").status).toBe(0);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["core", "extra"],
    until: (d: Directive) => BLOCKING.test(JSON.stringify(d)),
    answers: { autonomy: () => "Review each checkpoint" },
    // At the stage gate after the last Unit: the check goes in once every Unit's checkpoint is behind.
    afterCheckpoint: (unit) => {
      if (options.late && unit === "extra") {
        installCheck(proj, stage, file);
        expect(host.engine("graph", "compile").status).toBe(0);
      }
    },
  });
  let d = agent.begin("build the classic work", [
    "--scope", "classic", "--skip", (options.skipped ?? SKIPPED).join(","), "--plan-approval", "on", ...(options.flags ?? []),
  ]);
  let said = "";
  try {
    d = agent.drive(d);
    said = String(d.message ?? JSON.stringify(d));
  } catch (error) {
    if (!(error instanceof ScopeRunRefused) || !BLOCKING.test(error.refusal)) throw error;
    said = error.refusal;
  }
  expect(said, "the walk met the team's check").toMatch(BLOCKING);
  const m = /did not pass for \\?"([^"\\]+)\\?"(?: for unit \\?"([^"\\]+)\\?")?/.exec(said);
  const stop = { slug: m?.[1] ?? "", unit: m?.[2] ?? null };
  agent.must("log", "decision", "--stage", stop.slug, ...(stop.unit ? ["--unit", stop.unit] : []), "--decision", DECISION,
    "--options", "Fix findings,Override blocking sensors");
  options.beforeAnswer?.(agent, stop);
  agent.askPerson("blocking check", stop.slug, "A check failed. What next?", ["Fix findings", "Override blocking sensors"], WORDS);
  const id = options.setterMessage ?? agent.latestMessageId();
  const follow = (step: Directive): SwitchStep => {
    const message = String(step.message ?? "");
    const commands = [...message.matchAll(/`([^`]+)`/g)].map((x) => x[1])
      .filter((command) => !/orchestrate(\.ts)? next\b/.test(command));
    const outputs: string[] = [];
    for (const command of commands) {
      const ran = host.bash(command.replaceAll("'<id>'", id).replaceAll("<id>", id));
      outputs.push(`${ran.stdout}${ran.stderr}`);
      if (ran.status !== 0) return { message, outputs, ranNext: false };
    }
    return { message, outputs, ranNext: !/\bstop\.?$/.test(message.trim()) && /run `[^`]*next`/.test(message) };
  };
  const first = follow(agent.next("--sensors", "off"));
  const second = options.again ? follow(agent.next("--sensors", "off")) : null;
  if (options.finish !== false) {
    try {
      d = agent.drive(agent.next());
    } catch (error) {
      if (!(error instanceof ScopeRunRefused)) throw error;
      d = { kind: "refused", message: error.refusal };
    }
  }
  const rows = auditEvents(proj);
  const checkQuestion = rows.filter((row) => row.event === "DECISION_RECORDED" && field(row.block, "Decision") === DECISION);
  const answers = rows.filter((row) => row.event === "QUESTION_ANSWERED" && field(row.block, "Details") === SWITCH);
  return { proj, host, agent, d, stop, first, second, rows, checkQuestion, answers, id };
}

const sensorsLines = (outputs: string[]): number =>
  outputs.join("\n").split("\n").filter((line) => /Sensors changed:/.test(line)).length;

describe("switching the checks off answers the check's open question", () => {
  test("at a Unit's checkpoint: the answer is recorded with their words, the work goes on in the same turn, the line once", () => {
    const r = walk({});
    expect(r.stop).toEqual({ slug: "code-generation", unit: "core" });
    expect(r.first.message).toContain(`--stage code-generation --unit core --details "${SWITCH}"`);
    expect(r.first.ranNext).toBe(true);
    expect(r.answers.length).toBe(1);
    expect(field(r.answers[0].block, "Unit")).toBe("core");
    expect(field(r.answers[0].block, "Message Id")).toBe(r.id);
    expect(field(r.answers[0].block, "Person Reply")).toBe(WORDS);
    expect(sensorsLines(r.first.outputs)).toBe(1);
    expect(r.d).toMatchObject({ kind: "done" });
    // Nothing reads the switch as a pick: no Override and no Fix floor follow from it.
    const picks = blockingSensorPicks(r.rows, "code-generation");
    expect([...picks.keys()].some((row) => field(row.block, "Details") === SWITCH)).toBe(false);
    expect(hasBlockingSensorOverrideAuthorization(r.proj, "code-generation", "core")).toBe(false);
    // The check was asked once in the walk, and nothing fired after the switch.
    expect(r.checkQuestion.length).toBe(1);
    const switched = r.rows.indexOf(r.answers[0]);
    expect(r.rows.slice(switched).filter((row) => row.event === "SENSOR_FIRED" && field(row.block, "Sensor ID") === "retention"))
      .toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("at the stage gate after the last Unit: the answer is recorded with no Unit and the gate goes on", () => {
    const r = walk({ late: true });
    expect(r.stop).toEqual({ slug: "code-generation", unit: null });
    expect(r.first.message).toContain(`--stage code-generation --details "${SWITCH}"`);
    expect(r.first.message).not.toContain("--unit");
    expect(r.first.ranNext).toBe(true);
    expect(r.answers.length).toBe(1);
    expect(field(r.answers[0].block, "Unit")).toBeNull();
    expect(r.d).toMatchObject({ kind: "done" });
  }, SCOPE_RUN_TIMEOUT_MS);

  test("the question under the checkpoint's first stage, not Current Stage: the answer lands on that stage's question", () => {
    const r = walk({
      stage: "functional-design",
      file: "functional-spec.md",
      skipped: SKIPPED.filter((slug) => slug !== "functional-design"),
    });
    expect(r.stop).toEqual({ slug: "functional-design", unit: "core" });
    expect(r.first.message).toContain(`--stage functional-design --unit core --details "${SWITCH}"`);
    expect(r.first.ranNext).toBe(true);
    expect(r.answers.length).toBe(1);
    expect(field(r.answers[0].block, "Stage")).toBe("functional-design");
    expect(r.d).toMatchObject({ kind: "done" });
  }, SCOPE_RUN_TIMEOUT_MS);

  // A Unit walk with a design stage before Code Generation (as classic runs it): the Unit's
  // later stages are started per Unit, with no stage start of their own on the record.
  const WITH_DESIGN = SKIPPED.filter((slug) => slug !== "functional-design");

  test("a Unit walk with a design stage first, the check failing on Code Generation: the answer lands on that question", () => {
    const r = walk({ skipped: WITH_DESIGN });
    expect(r.stop).toEqual({ slug: "code-generation", unit: "core" });
    expect(r.first.message).toContain(`--stage code-generation --unit core --details "${SWITCH}"`);
    expect(r.first.ranNext).toBe(true);
    expect(r.answers.length).toBe(1);
    expect(r.d).toMatchObject({ kind: "done" });
  }, SCOPE_RUN_TIMEOUT_MS);

  test("the stage gate after the last Unit of a walk with a design stage first: the answer is recorded and the gate goes on", () => {
    const r = walk({ late: true, skipped: WITH_DESIGN });
    expect(r.stop).toEqual({ slug: "code-generation", unit: null });
    expect(r.first.message).toContain(`--stage code-generation --details "${SWITCH}"`);
    expect(r.first.ranNext).toBe(true);
    expect(r.answers.length).toBe(1);
    expect(r.d).toMatchObject({ kind: "done" });
  }, SCOPE_RUN_TIMEOUT_MS);

  for (const policy of ["strict", "relaxed", "off"]) {
    test(`under Guard Policy ${policy}: the same answer, the same next step`, () => {
      const r = walk({ flags: ["--guard-policy", policy] });
      expect(r.first.ranNext).toBe(true);
      expect(r.answers.length).toBe(1);
      expect(sensorsLines(r.first.outputs)).toBe(1);
      expect(r.d).toMatchObject({ kind: "done" });
    }, SCOPE_RUN_TIMEOUT_MS);
  }

  test("another question logged after the check's: the step reads as it always has, and no answer lands on either", () => {
    const r = walk({
      beforeAnswer: (agent, stop) => {
        agent.must("log", "decision", "--stage", stop.slug, ...(stop.unit ? ["--unit", stop.unit] : []),
          "--decision", "Keep the summary's format?", "--options", "Yes,No");
      },
      finish: false,
    });
    expect(r.first.message).not.toContain("log answer");
    expect(r.first.message).toMatch(/stop\.?$/);
    expect(r.answers.length).toBe(0);
    expect(r.rows.filter((row) => row.event === "QUESTION_ANSWERED" && field(row.block, "Stage") === "code-generation"))
      .toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("the switch run again instead of next: nothing left to answer, no second answer, the setter says it is already off", () => {
    const r = walk({ again: true });
    expect(r.second?.message).not.toContain("log answer");
    expect(r.second?.outputs.join("\n")).toMatch(/already off/);
    expect(r.answers.length).toBe(1);
    expect(r.d).toMatchObject({ kind: "done" });
  }, SCOPE_RUN_TIMEOUT_MS);

  test("a setter that refuses (a message that is not theirs) leaves the question open and records nothing", () => {
    const r = walk({ setterMessage: "deadbeef", finish: false });
    expect(r.first.ranNext).toBe(false);
    expect(r.answers.length).toBe(0);
    expect(r.rows.filter((row) => row.event === "CEREMONY_SET" && field(row.block, "Key") === "sensors")).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);
});
