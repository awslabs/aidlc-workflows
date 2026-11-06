// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// A lead's "no thin slice first" holds for team work from the moment they said
// it (#3634). The team's `## Walking Skeleton` answer was read only on the
// first Construction stage, so team work that met a team step before it (teams
// picked in Inception, then a share and a teammate's claim) or past it (a jump
// to Code Generation) held every Unit behind a walking skeleton the lead had
// ruled out. Now, on the lead's checkout, the first step after the work is team
// work has the agent read the answer through the round-trip it already runs on
// that stage, once; with no answer of the team's own, the scope's default holds.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unitParticipantPath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { claimsOpenHere } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000003634",
  AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
};
delete ENV.AWS_AIDLC_DEFAULT_SCOPE;

const HANDOUT_LINE = "No team has taken a Unit yet, so this session builds them here, starting with the alpha " +
  "Unit. To hand Units to teams instead, share this work through git; each team then runs `/aidlc` in its own " +
  "clone to take one.";
const SKELETON_HANDOUT_LINE = "No team has taken a Unit yet, so this session builds them here, starting with the " +
  "alpha Unit, the walking skeleton the others build on. To hand the others to teams, share this work through " +
  "git once it is built and approved; each team then runs `/aidlc` in its own clone to take one.";
const OFF_GATE_REFUSAL = "is not the skeleton-gate stage";

const NO = "We do not build a thin end-to-end slice first: every Unit starts as soon as what it depends on is done.";
const ALWAYS = "We always build a thin end-to-end slice first, before any other Unit.";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

type Directive = Record<string, unknown> & {
  kind?: string;
  ask_type?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  gate_note?: string;
  message?: string;
  choices?: Array<{ label: string; command?: string }>;
  change_notices?: string[];
};

// The Stage Progress separator the state file uses.
const D = String.fromCharCode(0x2014);
const CONSTRUCTION = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation", "build-and-test"];

// A feature plan of two Units: Delivery Planning in progress, or Functional
// Design just entered with nothing built.
function stateFile(at: "delivery-planning" | "functional-design", ownership: "team" | "solo" | null): string {
  const inception = at === "delivery-planning";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: team skeleton answer test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial
${ownership ? `- **Unit Ownership**: ${ownership}\n` : ""}
## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] units-generation ${D} EXECUTE
- ${inception ? "[-]" : "[x]"} delivery-planning ${D} EXECUTE

### CONSTRUCTION PHASE
${CONSTRUCTION.map((slug) => `- ${!inception && slug === at ? "[-]" : "[ ]"} ${slug} ${D} EXECUTE`).join("\n")}

## Current Status
- **Lifecycle Phase**: ${inception ? "INCEPTION" : "CONSTRUCTION"}
- **Current Stage**: ${at}
- **Status**: Running
`;
}

// The team's answer, as Practices Discovery's promotion writes it into team.md:
// the section's body replaced by the team's words. Null keeps the shipped
// comment-only section, which says nothing.
function project(
  at: Parameters<typeof stateFile>[0],
  ownership: "team" | "solo" | null,
  answer: string | null,
): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), stateFile(at, ownership));
  seedBoltDag(proj, ["alpha", "beta"]);
  const units = join(seededRecordDir(proj), "inception", "units-generation");
  mkdirSync(units, { recursive: true });
  writeFileSync(
    join(units, "unit-of-work-dependency.md"),
    "# Unit dependencies\n\n```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n",
  );
  if (answer !== null) {
    const team = join(proj, "aidlc", "spaces", "default", "memory", "team.md");
    const body = readFileSync(team, "utf-8");
    const next = body.replace(/## Walking Skeleton\r?\n[\s\S]*?(?=\r?\n## )/, `## Walking Skeleton\n\n${answer}\n`);
    expect(next, "team.md has a Walking Skeleton section").not.toBe(body);
    writeFileSync(team, next);
  }
  return proj;
}

function next(proj: string, args: string[] = []): Directive {
  const result = runOrchestrateNext(ORCH, proj, args, { env: ENV });
  if (!result.directive) throw new Error(`next failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.directive as Directive;
}

function run(tool: string, proj: string, args: string[]): { rc: number; out: string; json: Directive | null } {
  const result = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: ENV,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let json: Directive | null = null;
  try {
    json = JSON.parse((result.stdout ?? "").trim()) as Directive;
  } catch {
    json = null;
  }
  return { rc: result.status ?? -1, out, json };
}

const report = (proj: string, stance: string) => run(ORCH, proj, ["report", "--skeleton-stance", stance]);
const teams = (proj: string) => {
  const ran = run(STATE, proj, ["set-unit-ownership", "team"]);
  expect(ran.rc, ran.out).toBe(0);
};
const stance = (proj: string) =>
  /^- \*\*Skeleton Stance\*\*: ?(.*)$/m.exec(readFileSync(seededStateFile(proj), "utf-8"))?.[1]?.trim();
const settles = (d: Directive) => d.kind === "run-stage" && d.gate === "unresolved";

function expectSettleStep(d: Directive, stage: string): void {
  expect(d.kind, JSON.stringify(d)).toBe("run-stage");
  expect(d.stage).toBe(stage);
  expect(d.gate).toBe("unresolved");
  expect(d.gate_note ?? "").toContain("## Walking Skeleton");
  expect(d.gate_note ?? "").toContain("report --skeleton-stance");
}

function expectRecorded(proj: string, value: string): void {
  const ran = report(proj, value);
  expect(ran.rc, ran.out).toBe(0);
  expect(ran.json?.kind, ran.out).not.toBe("error");
  expect(stance(proj)).toBe(value);
}

function expectRefused(proj: string, value: string): void {
  const ran = report(proj, value);
  expect(ran.json?.kind, ran.out).toBe("error");
  expect(String(ran.json?.message)).toContain(OFF_GATE_REFUSAL);
}

// The person jumps from Delivery Planning to Code Generation and is asked who
// builds the Units there; the pick is the next step's command.
function jumpThenTeams(proj: string): void {
  const ask = next(proj, ["--stage", "code-generation"]);
  expect(ask.kind === "ask" && ask.ask_type === "construction-staffing", JSON.stringify(ask)).toBe(true);
  teams(proj);
}

describe("the team's walking-skeleton answer is read before a team step decides", () => {
  test("teams picked in Inception: the answer is read first, and a no opens every Unit", () => {
    const proj = project("delivery-planning", null, NO);
    teams(proj);
    expect(claimsOpenHere(proj)).toBe(false);
    const reading = runOrchestrateNext(ORCH, proj, [], { env: ENV });
    const settle = reading.directive as Directive;
    expectSettleStep(settle, "delivery-planning");
    // The memory text the agent reads the answer from comes with the step, in
    // it or in the parts ahead of it, as with any chat's first stage step.
    const rules = [settle, ...reading.steering].flatMap((part) =>
      Array.isArray(part.rules_content) ? (part.rules_content as Array<{ path?: string }>) : []
    );
    expect(rules.map((entry) => entry.path), JSON.stringify(Object.keys(settle)))
      .toContain("aidlc/spaces/default/memory/team.md");
    expectRecorded(proj, "off");
    expect(claimsOpenHere(proj)).toBe(true);
    const after = next(proj);
    expect(after.stage, JSON.stringify(after)).toBe("delivery-planning");
    expect(after.gate).toBe(true);
  });

  test("a jump past the first Construction stage, then Several teams: a no names no walking skeleton", () => {
    const proj = project("delivery-planning", null, NO);
    jumpThenTeams(proj);
    expectSettleStep(next(proj), "code-generation");
    expectRecorded(proj, "off");
    const step = next(proj);
    expect(step.unit, JSON.stringify(step)).toBe("alpha");
    expect(step.change_notices ?? []).toContain(HANDOUT_LINE);
    expect(step.change_notices ?? []).not.toContain(SKELETON_HANDOUT_LINE);
  });

  test("a team that always builds the slice first keeps today's walking skeleton", () => {
    const proj = project("delivery-planning", null, ALWAYS);
    jumpThenTeams(proj);
    expectSettleStep(next(proj), "code-generation");
    expectRecorded(proj, "on");
    const step = next(proj);
    expect(step.change_notices ?? [], JSON.stringify(step)).toContain(SKELETON_HANDOUT_LINE);
    expect(claimsOpenHere(proj)).toBe(false);
  });

  test("no answer of the team's own keeps the scope's default, with no extra step", () => {
    const inInception = project("delivery-planning", "team", null);
    const step = next(inInception);
    expect(settles(step), JSON.stringify(step)).toBe(false);
    expectRefused(inInception, "off");
    expect(stance(inInception)).toBeUndefined();
    expect(claimsOpenHere(inInception)).toBe(false);

    const jumped = project("delivery-planning", null, null);
    jumpThenTeams(jumped);
    const there = next(jumped);
    expect(settles(there), JSON.stringify(there)).toBe(false);
    expect(there.change_notices ?? []).toContain(SKELETON_HANDOUT_LINE);
  });

  test("read once: after the report the step never comes back, and a second report is refused", () => {
    const proj = project("delivery-planning", "team", NO);
    expectSettleStep(next(proj), "delivery-planning");
    expectRecorded(proj, "off");
    for (let i = 0; i < 3; i++) {
      const step = next(proj);
      expect(settles(step), JSON.stringify(step)).toBe(false);
    }
    expectRefused(proj, "on");
    expect(stance(proj)).toBe("off");
  });

  test("a stage awaiting approval shows its gate first; never answered, the work still moves on", () => {
    const proj = project("delivery-planning", "team", NO);
    const opened = run(ORCH, proj, ["report", "--stage", "delivery-planning", "--result", "awaiting-approval"]);
    expect(opened.rc, opened.out).toBe(0);
    const gate = next(proj);
    expect(settles(gate), JSON.stringify(gate)).toBe(false);
    const approved = run(ORCH, proj, [
      "report", "--stage", "delivery-planning", "--result", "approved", "--user-input", "Approve",
    ]);
    expect(approved.rc, approved.out).toBe(0);
    expect(approved.json?.kind, approved.out).not.toBe("error");
    expectSettleStep(next(proj), "functional-design");
    expectRecorded(proj, "off");
    const step = next(proj);
    expect(settles(step), JSON.stringify(step)).toBe(false);
    expect(step.stage).toBe("functional-design");
  });

  test("a jump that lands on the step keeps its own line there", () => {
    const proj = project("functional-design", "team", NO);
    const jump = next(proj, ["--stage", "code-generation"]);
    expectSettleStep(jump, "code-generation");
    expect((jump.change_notices ?? []).some((line) => line.startsWith("Moved to Code Generation")), JSON.stringify(jump))
      .toBe(true);
    expectRecorded(proj, "off");
    expect(next(proj).change_notices ?? []).toContain(HANDOUT_LINE);
  });

  test("a team's clone reads the lead's record and never records the stance", () => {
    const proj = project("delivery-planning", "team", NO);
    writeFileSync(unitParticipantPath(proj), "participant\n");
    const step = next(proj);
    expect(settles(step), JSON.stringify(step)).toBe(false);
    expectRefused(proj, "off");
    expect(stance(proj)).toBeUndefined();
  });

  test("teams picked on the first Construction stage: one step, the one that stage already has", () => {
    const proj = project("functional-design", null, NO);
    const ask = next(proj);
    expect(ask.kind === "ask" && ask.ask_type === "construction-staffing", JSON.stringify(ask)).toBe(true);
    teams(proj);
    expectSettleStep(next(proj), "functional-design");
    expectRecorded(proj, "off");
    const step = next(proj);
    expect(settles(step), JSON.stringify(step)).toBe(false);
    expect(step.unit).toBe("alpha");
    expect(step.change_notices ?? []).toContain(HANDOUT_LINE);
  });

  test("solo work is not asked off the first Construction stage", () => {
    const proj = project("delivery-planning", "solo", NO);
    const step = next(proj);
    expect(settles(step), JSON.stringify(step)).toBe(false);
    expectRefused(proj, "off");
  });
});
