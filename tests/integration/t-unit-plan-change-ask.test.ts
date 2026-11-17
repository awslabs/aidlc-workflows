// covers: subcommand:aidlc-orchestrate:next, function:unitPlanChangeAsk, function:teamsClone, file:tools/aidlc-jump.ts
//
// A person past Units Generation asks to add, split or drop a Unit. The agent
// reads that and hands `next compose --unit-plan` (the tool never reads their
// words). The composer only reshapes stages still ahead, so it cannot make a
// Unit; the engine instead offers what they asked for first: go back to Units
// Generation, with separate work as the other choice. The same ask serves a
// team main and a solo walk, and picking the go-back runs the jump `next
// --stage units-generation` makes. Every other compose keeps the composer: no
// flag, Units Generation still ahead, and a team's own clone (the Unit plan is
// main's).

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seededAuditDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import { cleanupTempDirs, clone, ORCH, runMergeTool, tempDirs, UNIT } from "../harness/team-unit-merge.ts";
import { currentStage, makeReplanSeed } from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const WORDS = 'We need one more function: wave(name) returns "Hi, <name>!". Add it to the plan as its own Unit for a third team.';

type Choice = { label: string; detail?: string; command?: string };

function compose(checkout: string, args: string[]): Record<string, unknown> {
  const run = runOrchestrateNext(ORCH, checkout, ["compose", ...args, "--", WORDS], { cwd: checkout, env: process.env });
  expect(run.status, run.out).toBe(0);
  return run.directive ?? {};
}

function soloProject(fixture: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, join(FIXTURES_DIR, fixture));
  return proj;
}

function jumpRows(checkout: string): string[] {
  const dir = seededAuditDir(checkout);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => readFileSync(join(dir, name), "utf-8").replace(/\r\n/g, "\n").split("\n---\n"))
    .filter((block) => block.includes("**Event**: STAGE_JUMPED"));
}

// The engine's offer, and what its first choice does when the person picks it:
// on a team main the jump keeps each Unit's own work, as the offer leans on.
function expectGoBackOffered(checkout: string, teamMain: boolean): void {
  const ask = compose(checkout, ["--unit-plan"]);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("unit-plan-change");
  expect(ask.response_route).toBe("command");
  expect(String(ask.question)).toBe(
    "Changing the Units means changing the Unit plan that Units Generation made. How would you like to do it?",
  );
  const choices = ask.choices as Choice[];
  expect(choices.map((choice) => choice.label)).toEqual(["Go back to Units Generation", "Run it as separate work"]);
  expect(choices[0].detail).toBe("Units Generation runs again with your change, then the stages after it.");
  expect(choices[0].command).toMatch(/ next --stage units-generation$/);
  expect(choices[1].command).toMatch(/ next --new-intent --request-file \S+$/);
  const file = /--request-file (\S+)$/.exec(choices[1].command ?? "")?.[1] ?? "";
  expect(readFileSync(join(checkout, file), "utf-8")).toBe(WORDS);
  // Nothing moved before the person picks.
  expect(currentStage(checkout)).toBe("functional-design");

  const command = choices[0].command ?? "";
  const picked = runMergeTool(ORCH, command.slice(command.indexOf(" next ") + 1).split(" "), checkout);
  expect(picked.status, picked.out).toBe(0);
  expect(currentStage(checkout)).toBe("units-generation");
  const step = JSON.parse(picked.stdout) as Record<string, unknown>;
  expect(step.stage, picked.out).toBe("units-generation");
  expect(step.change_notices).toEqual(["Moved back to Units Generation. You can return to Functional Design any time."]);
  const jumps = jumpRows(checkout);
  expect(jumps.length).toBe(1);
  expect(jumps[0].includes("**Unit Work**: kept")).toBe(teamMain);
}

function expectComposer(directive: Record<string, unknown>): void {
  expect(directive.kind, JSON.stringify(directive)).toBe("print");
  expect(String(directive.message)).toContain("aidlc-composer-agent");
  expect(String(directive.message)).toContain("mode in-flight");
}

describe("t-unit-plan-change-ask: a Unit change past Units Generation is offered the go-back first", () => {
  test("a team main mid-Construction", () => {
    expectGoBackOffered(makeReplanSeed().seed, true);
  });

  test("a solo walk mid-Construction", () => {
    expectGoBackOffered(soloProject("state-construction.md"), false);
  });
});

describe("t-unit-plan-change-ask: every other compose keeps the composer", () => {
  test("a reshape that is not a Unit change", () => {
    expectComposer(compose(soloProject("state-construction.md"), []));
  });

  test("a Unit change while Units Generation is still ahead", () => {
    expectComposer(compose(soloProject("state-mid-ideation.md"), ["--unit-plan"]));
  });

  test("a Unit change asked in a team's own clone", () => {
    const { remote } = makeReplanSeed();
    const team = clone(remote, "beta-team");
    const claim = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], team);
    expect(claim.status, claim.out).toBe(0);
    expectComposer(compose(team, ["--unit-plan"]));
  });
});
