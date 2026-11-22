// covers: scope:classic, function:blockingSensorFixes, audit:SENSOR_FAILED
//
// A person move in a scope run, with no model (tests/harness/scope-run.ts):
// solo classic work with three Units (unit-major with Construction
// checkpoints, its defaults), where the team made a gate check blocking on Code
// Generation (the Harness Engineer Guide's no-tbd example). The check fails on
// one Unit's code summary at the late Code Generation gate that `next` settles
// itself, and the person picks Fix findings, logged as the step and the sensors
// module say (no --unit). The agent fixes that file. Only that Unit is reviewed
// again, at its first pass, and only its checkpoint comes back to the person;
// the other Units keep their reviews and approvals, nothing is refused, and the
// run reaches done.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  activeRecord,
  AgentStandIn,
  auditEvents,
  createScopeProject,
  type Directive,
  field,
  PersonScript,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
];

// The team's check: blocking at the gate, failing on core's code summary until
// it has an error handling section.
function installBlockingCheck(proj: string): void {
  writeFileSync(join(proj, ".claude", "sensors", "aidlc-no-tbd.md"), [
    "---", "id: no-tbd", "kind: deterministic", "command: bun .claude/tools/aidlc-sensor-no-tbd.ts",
    "default_severity: blocking", "description: The document has no TBD left in it", "category: document-shape",
    "fire_on: gate", 'matches: "**/intents/**"', "input_schema:", "  output_path: string", "  stage_slug: string",
    "output_schema:", "  pass: boolean", "  findings: string[]", "  findings_count: number", "timeout_seconds: 60",
    "---", "", "# no-tbd", "", "Fails when core's code summary has no error handling section.", "",
  ].join("\n"));
  writeFileSync(join(proj, ".claude", "tools", "aidlc-sensor-no-tbd.ts"), [
    'import { readFileSync } from "node:fs";',
    "export function main(argv: string[]): void {",
    '  const file = argv[argv.indexOf("--output-path") + 1];',
    '  const lines = readFileSync(file, "utf-8").split("\\n");',
    "  const core = /[\\\\/]core[\\\\/]code-generation[\\\\/]code-summary\\.md$/.test(file);",
    '  const findings = core && !lines.some((line) => /error handling/i.test(line)) ? ["no error handling section"] : [];',
    "  console.log(JSON.stringify({ pass: findings.length === 0, findings, findings_count: findings.length }));",
    "}",
    "if (import.meta.main) main(process.argv.slice(2));",
    "",
  ].join("\n"));
  const stageFile = join(proj, ".claude", "aidlc-common", "stages", "construction", "code-generation.md");
  const text = readFileSync(stageFile, "utf-8");
  const bound = text.replace("sensors:\n  - required-sections\n  - traceability\n",
    "sensors:\n  - required-sections\n  - traceability\n  - no-tbd\n");
  expect(bound).not.toBe(text);
  writeFileSync(stageFile, bound);
}

describe("a Fix findings pick at the late Code Generation gate in solo work built Unit by Unit", () => {
  test("only the Unit the check named is reviewed again and asked again, and the run reaches done", () => {
    const { proj, host } = createScopeProject("empty");
    projects.push(proj);
    installBlockingCheck(proj);
    expect(host.engine("graph", "compile").status).toBe(0);
    const person = new PersonScript(host);
    const isBlocking = (d: Directive) => /Blocking gate sensor/.test(JSON.stringify(d));
    const agent = new AgentStandIn(host, person, { units: ["core", "extra", "third"], until: isBlocking });
    const stopped = agent.drive(agent.begin("build the classic work", [
      "--scope", "classic", "--skip", SKIPPED.join(","), "--plan-approval", "on",
    ]));
    expect(isBlocking(stopped)).toBe(true);
    const askedBefore = agent.asked.length;
    const rows = () => auditEvents(proj);
    const reviewsBefore = rows().filter((r) => r.event === "REVIEW_REQUESTED").length;
    const approvals = () => rows().filter((r) =>
      r.event === "GATE_APPROVED" && field(r.block, "Checkpoint") === "construction-unit").map((r) => field(r.block, "Unit"));
    expect(approvals().sort()).toEqual(["core", "extra", "third"]);

    const options = ["Fix findings", "Override blocking sensors"];
    agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
      "--options", options.join(","));
    agent.askPerson("blocking check", "code-generation", "A check failed on core's code summary. What next?",
      options, "Fix findings");
    agent.must("log", "answer", "--stage", "code-generation", "--details", "Fix findings");
    const summary = `${activeRecord(proj).dir.slice(proj.length + 1)}/construction/core/code-generation/code-summary.md`;
    host.write(summary, `${readFileSync(join(proj, summary), "utf-8")}\n## Error handling\n\nErrors are retried twice, then reported.\n`);

    expect(agent.drive(agent.next())).toMatchObject({ kind: "done" });
    const reviews = rows().filter((r) => r.event === "REVIEW_REQUESTED").slice(reviewsBefore)
      .map((r) => `${field(r.block, "Unit")}#${field(r.block, "Iteration")}`);
    expect(reviews).toEqual(["core#1"]);
    expect(approvals().sort()).toEqual(["core", "core", "extra", "third"]);
    // After the check's own question, Code Generation asks only core's approval again.
    const asked = agent.asked.slice(askedBefore + 1).filter((a) => a.stage === "code-generation");
    expect(asked.map((a) => `${a.what} ${a.unit}`)).toEqual(["unit checkpoint core"]);
  }, SCOPE_RUN_TIMEOUT_MS);
});
