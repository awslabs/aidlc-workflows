// covers: subcommand:aidlc-state:checkpoint-checks, function:overrodeAtEarlierUnits, function:enforceBlockingGateSensors
//
// #3644: the person met a team's blocking check at the first Unit, asked to
// switch that one check off, was asked once whether that meant this Unit or
// every check, and picked the Override for that Unit. At a later Unit failing
// the same check, the same words are that same pick: the refusal names the
// answer to record and the retry, and the work's switch is not run. Its
// structure is read from the record, never from the person's words: the first
// Unit's question offered the work's switch and was answered with the
// Override, and the verification that carried that answer overrode this check.
// A plain Override, a Fix, another check, or a check failing beside the one
// they clarified (the Override would cover it too) read as before; an Override
// later undone keeps their answer. The lines the person hears name the Unit by its plain name and leave
// the check's name to the agent ("the <check>"), never a slug or a check id.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const OVERRIDE = "Override blocking sensors";
const FIX = "Fix findings";
const DECISION = "Blocking gate sensor failure";
const WORDS = "switch that check off for this work";
const OK = "RETENTION-OK";
const BLOCKING = /Blocking gate sensor evaluation did not pass|Refusing blocking sensor override/;

// A blocking check on Code Generation, failing on the code summary of each Unit in `failOn`.
function installCheck(proj: string, id: string, failOn: string[]): void {
  writeFileSync(join(proj, ".claude", "sensors", `aidlc-${id}.md`), [
    "---", `id: ${id}`, "kind: deterministic", `command: bun .claude/tools/aidlc-sensor-${id}.ts`,
    "default_severity: blocking", "description: A team check on a Unit's summary", "category: document-shape",
    "fire_on: gate", 'matches: "**/intents/**"', "input_schema:", "  output_path: string", "  stage_slug: string",
    "output_schema:", "  pass: boolean", "  findings: string[]", "  findings_count: number", "timeout_seconds: 60",
    "---", "", `# ${id}`, "",
  ].join("\n"));
  writeFileSync(join(proj, ".claude", "tools", `aidlc-sensor-${id}.ts`), [
    'import { readFileSync } from "node:fs";',
    "export function main(argv: string[]): void {",
    '  const out = argv[argv.indexOf("--output-path") + 1];',
    `  const hit = /[\\\\/](${failOn.join("|")})[\\\\/]code-generation[\\\\/]code-summary\\.md$/.test(out);`,
    `  const findings = hit && !readFileSync(out, "utf-8").includes("${OK}-${id}") ? ["no ${id} line"] : [];`,
    "  console.log(JSON.stringify({ pass: findings.length === 0, findings, findings_count: findings.length }));",
    "}",
    "if (import.meta.main) main(process.argv.slice(2));",
    "",
  ].join("\n"));
  const stageFile = join(proj, ".claude", "aidlc-common", "stages", "construction", "code-generation.md");
  const text = readFileSync(stageFile, "utf-8");
  const bound = text.replace(/^sensors:\n/m, `sensors:\n  - ${id}\n`);
  expect(bound).not.toBe(text);
  writeFileSync(stageFile, bound);
}

// The first Unit's move: the one ask (the work's switch offered beside the check's
// two choices) or the plain question, then the pick. `undo`: after an Override the
// agent fixes the file and verifies again, so the Unit passes as it is approved.
type First = { offerSwitch: boolean; pick: typeof OVERRIDE | typeof FIX; undo?: boolean };

function walk(options: {
  units?: string[];
  checks: Array<{ id: string; failOn: string[] }>;
  first: First;
  // At the later Unit: the person says the same words again, and the agent takes
  // what the refusal names (the same pick), or, with no such line, picks the Override.
  later?: "same words" | "override";
}) {
  const units = options.units ?? ["core", "extra"];
  const { proj, host } = createScopeProject("empty");
  projects.push(proj);
  for (const check of options.checks) installCheck(proj, check.id, check.failOn);
  expect(host.engine("graph", "compile").status).toBe(0);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units,
    until: (d: Directive) => BLOCKING.test(JSON.stringify(d)),
    answers: { autonomy: () => "Review each checkpoint" },
  });
  let d = agent.begin("build the classic work", [
    "--scope", "classic", "--skip", SKIPPED.join(","), "--plan-approval", "on",
  ]);
  const refusals: Array<{ unit: string; said: string }> = [];
  for (let round = 0; round < 6; round++) {
    let said: string;
    try {
      d = agent.drive(d);
      if (!BLOCKING.test(JSON.stringify(d))) break;
      said = String(d.message ?? JSON.stringify(d));
    } catch (error) {
      if (!(error instanceof ScopeRunRefused) || !BLOCKING.test(error.refusal)) throw error;
      said = error.refusal;
    }
    said = said.replaceAll('\\"', '"');
    const unit = /for unit "([^"]+)"/.exec(said)?.[1] ?? "";
    refusals.push({ unit, said });
    const isFirst = refusals.length === 1;
    const offered = [FIX, OVERRIDE, ...(isFirst && options.first.offerSwitch ? [SWITCH] : [])];
    agent.must("log", "decision", "--stage", "code-generation", "--unit", unit, "--decision", DECISION, "--options", offered.join(","));
    const retry = /Then retry: (.+?)\. Autonomous mode cannot override\./.exec(said)?.[1];
    if (isFirst) {
      agent.askPerson("blocking check", "code-generation", "A check failed. What next?", offered, options.first.pick);
      agent.must("log", "answer", "--stage", "code-generation", "--unit", unit, "--details", options.first.pick);
      if (options.first.pick === FIX) {
        const rel = /@([^:;"]+?code-summary\.md): reported findings/.exec(said)?.[1] ?? "";
        host.write(rel, `${readFileSync(join(proj, rel), "utf-8")}\n${options.checks.map((c) => `${OK}-${c.id}`).join("\n")}\n`);
      } else {
        expect(host.bash(retry!).status).toBe(0);
        if (options.first.undo) {
          const rel = /@([^:;"]+?code-summary\.md): reported findings/.exec(said)?.[1] ?? "";
          host.write(rel, `${readFileSync(join(proj, rel), "utf-8")}\n${options.checks.map((c) => `${OK}-${c.id}`).join("\n")}\n`);
          expect(host.bash(retry!.replace(/ --override-blocking-sensors --user-input "[^"]*"/, "")).status).toBe(0);
        }
      }
    } else if (options.later === "same words") {
      agent.askPerson("blocking check", "code-generation", "A check failed. What next?", offered, WORDS);
      const answer = /run `([^`]*log(\.ts)? answer[^`]*--details "Override blocking sensors"[^`]*)`/.exec(said)?.[1];
      expect(answer, said).toBeDefined();
      expect(host.bash(answer!.replaceAll("'<id>'", agent.latestMessageId())).status).toBe(0);
      expect(host.bash(retry!).status).toBe(0);
    } else {
      agent.askPerson("blocking check", "code-generation", "A check failed. What next?", offered, OVERRIDE);
      agent.must("log", "answer", "--stage", "code-generation", "--unit", unit, "--details", OVERRIDE);
      expect(host.bash(retry!).status).toBe(0);
    }
    d = agent.next();
  }
  const rows = auditEvents(proj);
  const verified = (unit: string) => rows.filter((row) =>
    row.event === "CHECKPOINT_VERIFICATION_RECORDED" && field(row.block, "Unit") === unit && field(row.block, "Verified") === "true").at(-1);
  const switched = rows.some((row) => row.event === "CEREMONY_SET" && field(row.block, "Key") === "sensors");
  const asked = agent.asked.filter((a) => a.what === "blocking check").length;
  const questions = rows.filter((row) => row.event === "DECISION_RECORDED" && field(row.block, "Decision") === DECISION);
  return { d, refusals, rows, verified, switched, asked, questions };
}

// The quoted lines the refusal hands the agent to say.
const quoted = (said: string): string[] => [...said.matchAll(/"((?:You overrode|Same as for)[^"]*)"/g)].map((x) => x[1]);
const SAME_PICK = /a request to switch this check off again is that same pick/;

describe("a later Unit, the same words: the person's earlier pick", () => {
  test("the one ask answered with the Override at core: extra's refusal takes the same pick, and the work's switch is not run", () => {
    const r = walk({ checks: [{ id: "retention", failOn: ["core", "extra"] }], first: { offerSwitch: true, pick: OVERRIDE }, later: "same words" });
    expect(r.refusals.map((x) => x.unit)).toEqual(["core", "extra"]);
    expect(r.refusals[0].said).not.toMatch(SAME_PICK);
    expect(r.refusals[1].said).toMatch(SAME_PICK);
    expect(r.refusals[1].said).toContain("--unit extra --details \"Override blocking sensors\"");
    // The answer it names takes their reply itself: no message id for the agent to look up.
    expect(/run `([^`]*log(\.ts)? answer[^`]*)`/.exec(r.refusals[1].said)?.[1]).not.toContain("--message");
    const extraAnswer = r.rows.filter((row) => row.event === "QUESTION_ANSWERED" && field(row.block, "Unit") === "extra").at(-1);
    expect(field(extraAnswer!.block, "Person Reply")).toBe(WORDS);
    expect(field(extraAnswer!.block, "Message Id")).not.toBeNull();
    expect(r.refusals[1].said).toContain("\"Same as for the core Unit: I've overridden the <check> for this one too.\"");
    expect(r.d).toMatchObject({ kind: "done" });
    expect(field(r.verified("extra")!.block, "Blocking Checks")).toMatch(/:retention@[0-9a-f]{12}=overridden$/);
    expect(r.switched).toBe(false);
    expect(r.asked).toBe(2);
    // The one ask was at core only; extra's question is the check's own two choices.
    expect(r.questions.length).toBe(2);
    expect(field(r.questions[0].block, "Options")).toContain(SWITCH);
    expect(field(r.questions[1].block, "Options")).not.toContain(SWITCH);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("the Override at core later undone (its file fixed and verified again): extra still takes the same pick", () => {
    const r = walk({ checks: [{ id: "retention", failOn: ["core", "extra"] }], first: { offerSwitch: true, pick: OVERRIDE, undo: true }, later: "same words" });
    expect(field(r.verified("core")!.block, "Blocking Checks")).toMatch(/=passed$/);
    expect(r.refusals[1].said).toMatch(SAME_PICK);
    expect(r.d).toMatchObject({ kind: "done" });
  }, SCOPE_RUN_TIMEOUT_MS);

  for (const [name, first] of [
    ["a plain Override at core (no one ask)", { offerSwitch: false, pick: OVERRIDE }],
    ["the one ask answered with Fix at core", { offerSwitch: true, pick: FIX }],
  ] as const) {
    test(`${name}: extra's refusal reads as before`, () => {
      const r = walk({ checks: [{ id: "retention", failOn: ["core", "extra"] }], first, later: "override" });
      expect(r.refusals[1].said).not.toMatch(SAME_PICK);
      expect(r.d).toMatchObject({ kind: "done" });
    }, SCOPE_RUN_TIMEOUT_MS);
  }

  test("a new check failing at extra beside the one they clarified at core: no shortcut, both get extra's own question", () => {
    const r = walk({
      checks: [{ id: "retention", failOn: ["core", "extra"] }, { id: "rollback", failOn: ["extra"] }],
      first: { offerSwitch: true, pick: OVERRIDE },
      later: "override",
    });
    expect(r.refusals.map((x) => x.unit)).toEqual(["core", "extra"]);
    expect(r.refusals[1].said).toMatch(/Sensors: (retention, rollback|rollback, retention)\./);
    expect(r.refusals[1].said).not.toMatch(/that same pick/);
    // What they overrode at core is still said, for that check alone.
    expect(quoted(r.refusals[1].said)).toEqual(["You overrode the <check> for the core Unit."]);
    expect(r.d).toMatchObject({ kind: "done" });
  }, SCOPE_RUN_TIMEOUT_MS);

  test("both checks failing at both Units, both overridden at core after the one ask: extra takes the same pick for both", () => {
    const r = walk({
      checks: [{ id: "retention", failOn: ["core", "extra"] }, { id: "rollback", failOn: ["core", "extra"] }],
      first: { offerSwitch: true, pick: OVERRIDE },
      later: "same words",
    });
    expect(r.refusals[1].said).toMatch(/a request to switch these checks off again is that same pick/);
    expect(r.refusals[1].said).toContain("(<check>: the retention check");
    expect(r.refusals[1].said).toContain("(<check>: the rollback check");
    expect(r.d).toMatchObject({ kind: "done" });
    const checks = field(r.verified("extra")!.block, "Blocking Checks") ?? "";
    expect(checks).toMatch(/:retention@[0-9a-f]{12}=overridden/);
    expect(checks).toMatch(/:rollback@[0-9a-f]{12}=overridden/);
    expect(r.switched).toBe(false);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("another check failing at extra after the one ask at core: extra's refusal reads as before for it", () => {
    const r = walk({
      checks: [{ id: "retention", failOn: ["core"] }, { id: "rollback", failOn: ["extra"] }],
      first: { offerSwitch: true, pick: OVERRIDE },
      later: "override",
    });
    expect(r.refusals.map((x) => x.unit)).toEqual(["core", "extra"]);
    expect(r.refusals[1].said).not.toMatch(SAME_PICK);
    expect(quoted(r.refusals[1].said)).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);
});

describe("the earlier-Override line, as a colleague says it", () => {
  test("names the Unit by its plain name and leaves the check's name to the agent, with no slug or check id", () => {
    const r = walk({
      units: ["u1-parser", "u2-report"],
      checks: [{ id: "retention", failOn: ["u1-parser", "u2-report"] }],
      first: { offerSwitch: false, pick: OVERRIDE },
      later: "override",
    });
    const lines = quoted(r.refusals[1].said);
    expect(lines).toEqual(["You overrode the <check> for the parser Unit."]);
    expect(r.refusals[1].said).toContain("(<check>: the retention check, named by what it checks");
    for (const line of lines) {
      expect(line).not.toContain("u1-parser");
      expect(line).not.toContain("retention");
    }
  }, SCOPE_RUN_TIMEOUT_MS);

  test("two checks overridden at core: one line for each, each with its own <check>", () => {
    const r = walk({
      checks: [{ id: "retention", failOn: ["core", "extra"] }, { id: "rollback", failOn: ["core", "extra"] }],
      first: { offerSwitch: false, pick: OVERRIDE },
      later: "override",
    });
    expect(quoted(r.refusals[1].said)).toEqual([
      "You overrode the <check> for the core Unit.",
      "You overrode the <check> for the core Unit.",
    ]);
    expect(r.refusals[1].said).toContain("(<check>: the retention check");
    expect(r.refusals[1].said).toContain("(<check>: the rollback check");
  }, SCOPE_RUN_TIMEOUT_MS);
});
