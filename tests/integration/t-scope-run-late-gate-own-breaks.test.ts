// covers: function:blockingSensorPicks, function:hasBlockingSensorOverrideAuthorization, audit:SENSOR_FAILED
//
// A person move in a scope run, with no model (tests/harness/scope-run.ts): a
// team's blocking check at the end of Code Generation in solo work built Unit
// by Unit with Construction checkpoints, the gate the engine settles itself
// once every Unit is approved (the late gate). The check is added after the
// last Unit's approval, so the late gate is the first place it runs (as for a
// Unit edited after its approval, work begun before an update, or Continue
// automatically, where a Unit's checkpoint runs no check). There the refusal is
// the agent's step, never an engine error a hook shows the person; the
// person's Override counts when they replied after the refusal put the
// question, even when the agent recorded the question after their reply; once
// overridden the gate is settled and the check is not asked again; under
// Continue automatically the turn ends at the question. An Override no reply
// of the person's stands behind still does not count, and a Fix reopens only
// the Unit the check named.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  ScopeRunRefused,
  type ScopeHost,
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
const OPTIONS = ["Fix findings", "Override blocking sensors"];
const BLOCKING = /Blocking gate sensor evaluation did not pass|Refusing blocking sensor override/;

// The team's check, blocking on Code Generation, failing on core's code
// summary until it carries the line the team wants.
function installBlockingCheck(proj: string, host: ScopeHost): void {
  writeFileSync(join(proj, ".claude", "sensors", "aidlc-retention.md"), [
    "---", "id: retention", "kind: deterministic", "command: bun .claude/tools/aidlc-sensor-retention.ts",
    "default_severity: blocking", "description: The team's check on a Unit's summary", "category: document-shape",
    "fire_on: gate", 'matches: "**/intents/**"', "input_schema:", "  output_path: string", "  stage_slug: string",
    "output_schema:", "  pass: boolean", "  findings: string[]", "  findings_count: number", "timeout_seconds: 60",
    "---", "", "# retention", "",
  ].join("\n"));
  writeFileSync(join(proj, ".claude", "tools", "aidlc-sensor-retention.ts"), [
    'import { readFileSync } from "node:fs";',
    "export function main(argv: string[]): void {",
    '  const file = argv[argv.indexOf("--output-path") + 1];',
    "  const core = /[\\\\/]core[\\\\/]code-generation[\\\\/]code-summary\\.md$/.test(file);",
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
  expect(host.engine("graph", "compile").status).toBe(0);
}

type Policy = "default" | "strict" | "relaxed" | "off" | "locked";

// The team's own lock: strict in team.md holds for every intent.
function lockStrict(proj: string): void {
  const team = join(proj, "aidlc", "spaces", "default", "memory", "team.md");
  expect(existsSync(team)).toBe(true);
  const text = readFileSync(team, "utf-8");
  expect(text).toContain("## Guard Policy\n");
  writeFileSync(team, text.replace("## Guard Policy\n", "## Guard Policy\n\n- Mode: strict\n"));
}

interface LateGate {
  proj: string;
  host: ScopeHost;
  person: PersonScript;
  agent: AgentStandIn;
  // The step the late gate handed the agent (null when a command refused in the stand-in's hands).
  step: Directive | null;
  said: string;
}

// Solo classic work with two Units, unit-major with checkpoints, walked to the
// late gate the team's check stops; under Continue automatically the check is
// there from the start, since no person answers a checkpoint there.
function toLateGate(options: { policy?: Policy; autonomy?: boolean } = {}): LateGate {
  const policy = options.policy ?? "default";
  const { proj, host } = createScopeProject("empty");
  projects.push(proj);
  if (policy === "locked") lockStrict(proj);
  if (options.autonomy) installBlockingCheck(proj, host);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["core", "extra"],
    until: (d: Directive) => BLOCKING.test(JSON.stringify(d)),
    answers: { autonomy: () => (options.autonomy ? "Continue automatically" : "Review each checkpoint") },
    afterCheckpoint: (unit: string) => {
      if (unit === "extra" && !options.autonomy) installBlockingCheck(proj, host);
    },
  });
  const flags = ["--scope", "classic", "--skip", SKIPPED.join(","), "--plan-approval", "on"];
  if (policy === "strict" || policy === "relaxed" || policy === "off") flags.push("--guard-policy", policy);
  let step: Directive | null = null;
  let said = "";
  try {
    step = agent.drive(agent.begin("build the classic work", flags));
    said = String(step.message ?? JSON.stringify(step));
  } catch (error) {
    if (!(error instanceof ScopeRunRefused) || !BLOCKING.test(error.refusal)) throw error;
    said = error.refusal;
  }
  expect(said).toMatch(/Blocking gate sensor evaluation did not pass for \\?"code-generation\\?"/);
  return { proj, host, person, agent, step, said };
}

// The retry the refusal names, run as the agent's Bash tool runs it.
function retryOverride(r: LateGate): Record<string, unknown> {
  const retry = /Then retry: (.+?)\. Autonomous mode cannot override\./.exec(r.said)?.[1]?.replaceAll('\\"', '"');
  expect(retry, r.said).toBeDefined();
  const ran = r.host.bash(retry!);
  return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

const checkAsks = (r: LateGate) => r.agent.asked.filter((a) => a.what === "blocking check").length;
const stageApproved = (proj: string) => auditEvents(proj).some((row) =>
  row.event === "GATE_APPROVED" && field(row.block, "Stage") === "code-generation" && field(row.block, "Unit") === null);

// The person picks Override at the check's question, logged in the protocol's order.
function overrideInOrder(r: LateGate): Record<string, unknown> {
  r.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
    "--options", OPTIONS.join(","));
  r.agent.askPerson("blocking check", "code-generation", "A check failed on core's code summary. What next?",
    OPTIONS, "Override blocking sensors");
  r.agent.must("log", "answer", "--stage", "code-generation", "--details", "Override blocking sensors");
  return retryOverride(r);
}

// The person answers in their own words before the agent records the question.
function overrideInOwnWordsLogged(r: LateGate): Record<string, unknown> {
  r.agent.asked.push({ what: "blocking check", stage: "code-generation", unit: null });
  r.person.say("approve it anyway, we accept that");
  r.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
    "--options", OPTIONS.join(","));
  r.agent.must("log", "answer", "--stage", "code-generation", "--details", "Override blocking sensors");
  return retryOverride(r);
}

// The agent goes on from the retry's reply as the conductor does: `next`, to done.
function onToDone(r: LateGate): Directive {
  return r.agent.drive(r.agent.next());
}

describe("a team's blocking check at the late Code Generation gate", () => {
  test("the refusal is the agent's step: a print that ends the turn, never an engine error a hook relays", () => {
    const r = toLateGate();
    expect(r.step).not.toBeNull();
    expect(r.step!.kind).toBe("print");
    expect(r.step!.ends_turn).toBe(true);
    expect(String(r.step!.message)).toContain("Fix findings,Override blocking sensors");
    // No relay line: the PostToolUse hook relays only an engine error.
    const relay = r.host.hook("rebuild-stage-graph", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun .claude/tools/aidlc.ts engine orchestrate next" },
      tool_response: { stdout: `${JSON.stringify(r.step)}\n`, stderr: "" },
    });
    expect(relay.stdout).not.toContain("The workflow stopped with this error");
    // The gate stayed shut: nothing approved it after the refusal.
    expect(stageApproved(r.proj)).toBe(false);
    // The person is there: the turn ends at the question.
    expect(r.host.stop().blocked).toBe(false);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("an Override in the person's own words counts when the agent records the question after their reply", () => {
    const r = toLateGate();
    const reply = overrideInOwnWordsLogged(r);
    expect(JSON.stringify(reply)).not.toMatch(BLOCKING);
    expect(onToDone(r)).toMatchObject({ kind: "done" });
    expect(stageApproved(r.proj)).toBe(true);
    expect(checkAsks(r)).toBe(1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("once overridden, the gate is settled with it: the check is not asked again, nor the gate's approval", () => {
    const r = toLateGate();
    const reply = overrideInOrder(r);
    expect(reply.kind).toBe("print");
    expect(JSON.stringify(reply)).not.toMatch(BLOCKING);
    const asked = r.agent.asked.length;
    expect(onToDone(r)).toMatchObject({ kind: "done" });
    expect(stageApproved(r.proj)).toBe(true);
    expect(checkAsks(r)).toBe(1);
    expect(r.agent.asked.slice(asked).filter((a) => a.stage === "code-generation")).toEqual([]);
    // The stage's own approval carries the Override, by the engine, once.
    const opened = auditEvents(r.proj).filter((row) =>
      row.event === "STAGE_AWAITING_APPROVAL" && field(row.block, "Stage") === "code-generation");
    expect(opened.map((row) => field(row.block, "Blocking Sensor Override"))).toEqual(["true"]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("the agent re-recording the check's question after the person's Override does not spend it", () => {
    const r = toLateGate();
    r.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
      "--options", OPTIONS.join(","));
    r.agent.askPerson("blocking check", "code-generation", "A check failed on core's code summary. What next?",
      OPTIONS, "Override blocking sensors");
    r.agent.must("log", "answer", "--stage", "code-generation", "--details", "Override blocking sensors");
    r.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
      "--options", OPTIONS.join(","));
    const reply = retryOverride(r);
    expect(JSON.stringify(reply)).not.toMatch(BLOCKING);
    expect(onToDone(r)).toMatchObject({ kind: "done" });
    expect(checkAsks(r)).toBe(1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("under Continue automatically the turn ends at the check's question, with no carrying-on line", () => {
    const r = toLateGate({ autonomy: true });
    expect(r.step?.kind).toBe("print");
    expect(r.step?.ends_turn).toBe(true);
    const blocks = [0, 1, 2].map(() => r.host.stop()).filter((verdict) => verdict.blocked);
    expect(blocks).toEqual([]);
    // An Override still needs the person to leave Continue automatically first.
    r.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
      "--options", OPTIONS.join(","));
    r.agent.askPerson("blocking check", "code-generation", "A check failed on core's code summary. What next?",
      OPTIONS, "Override blocking sensors");
    r.agent.must("log", "answer", "--stage", "code-generation", "--details", "Override blocking sensors");
    const reply = retryOverride(r);
    expect(reply.kind).toBe("print");
    expect(String(reply.message)).toContain("set-autonomy --mode gated");
    expect(stageApproved(r.proj)).toBe(false);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("an Override no reply of the person's stands behind does not count", () => {
    // No reply since the refusal: the agent cannot record an Override on its own (the logger's own
    // check), and the retry is refused as the agent's step, never an engine error.
    const alone = toLateGate();
    alone.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
      "--options", OPTIONS.join(","));
    const logged = alone.host.engine("log", "answer", "--stage", "code-generation", "--details", "Override blocking sensors");
    expect(logged.status).not.toBe(0);
    const refused = retryOverride(alone);
    expect(refused.kind).toBe("print");
    expect(refused.ends_turn).toBe(true);
    expect(String(refused.message)).toContain("Refusing blocking sensor override");
    expect(stageApproved(alone.proj)).toBe(false);

    // The person's reply answered another question the agent asked after the refusal.
    const other = toLateGate();
    other.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Which file should I look at first?",
      "--options", "core,extra");
    other.person.say("core");
    other.agent.must("log", "answer", "--stage", "code-generation", "--details", "core");
    other.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
      "--options", OPTIONS.join(","));
    other.host.engine("log", "answer", "--stage", "code-generation", "--details", "Override blocking sensors");
    const refusedToo = retryOverride(other);
    expect(String(refusedToo.message)).toContain("Refusing blocking sensor override");
    expect(stageApproved(other.proj)).toBe(false);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("a Fix pick recorded after the person's reply reopens only the Unit the check named", () => {
    const r = toLateGate();
    const reviewsBefore = auditEvents(r.proj).filter((row) => row.event === "REVIEW_REQUESTED").length;
    r.person.say("fix it please");
    r.agent.must("log", "decision", "--stage", "code-generation", "--decision", "Blocking gate sensor failure",
      "--options", OPTIONS.join(","));
    r.agent.must("log", "answer", "--stage", "code-generation", "--details", "Fix findings");
    const summary = `${activeRecord(r.proj).dir.slice(r.proj.length + 1)}/construction/core/code-generation/code-summary.md`;
    r.host.write(summary, `${readFileSync(join(r.proj, summary), "utf-8")}\n${OK}\n`);
    expect(onToDone(r)).toMatchObject({ kind: "done" });
    const reviews = auditEvents(r.proj).filter((row) => row.event === "REVIEW_REQUESTED").slice(reviewsBefore)
      .map((row) => field(row.block, "Unit"));
    expect(reviews).toEqual(["core"]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("Guard Policy strict: a file changed after the Override opened the gate is checked again as the agent's step, never an error", () => {
    const r = toLateGate({ policy: "strict" });
    expect(JSON.stringify(overrideInOrder(r))).not.toMatch(BLOCKING);
    // The person changes core's summary at the open gate, still without the team's line.
    r.person.say("I added a note to core's summary myself");
    const summary = `${activeRecord(r.proj).dir.slice(r.proj.length + 1)}/construction/core/code-generation/code-summary.md`;
    r.host.write(summary, `${readFileSync(join(r.proj, summary), "utf-8")}\nA note from the person.\n`);
    const step = r.agent.next();
    expect(step.kind).not.toBe("error");
    if (BLOCKING.test(JSON.stringify(step))) expect(step.ends_turn).toBe(true);
  }, SCOPE_RUN_TIMEOUT_MS);

  for (const policy of ["strict", "relaxed", "off", "locked"] as const) {
    test(`Guard Policy ${policy}: an Override in own words is taken once and the gate settles with it`, () => {
      const words = toLateGate({ policy });
      expect(JSON.stringify(overrideInOwnWordsLogged(words))).not.toMatch(BLOCKING);
      expect(onToDone(words)).toMatchObject({ kind: "done" });
      expect(checkAsks(words)).toBe(1);
      const inOrder = toLateGate({ policy });
      expect(JSON.stringify(overrideInOrder(inOrder))).not.toMatch(BLOCKING);
      expect(onToDone(inOrder)).toMatchObject({ kind: "done" });
      expect(checkAsks(inOrder)).toBe(1);
    }, SCOPE_RUN_TIMEOUT_MS * 2);
  }
});
