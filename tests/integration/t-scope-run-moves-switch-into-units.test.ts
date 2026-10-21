// covers: scope:bugfix, scope:feature, scope:workshop, scope:mvp, scope:classic, scope:enterprise, audit:SCOPE_CHANGED, audit:STAGE_JUMPED, function:usesStageLevelPerUnitArtifacts
//
// Work that never ran Units Generation, moved past it into a plan that runs
// it, with no model (tests/harness/scope-run.ts). A bugfix at its Code
// Generation gate, then a switch to each scope that runs Units Generation;
// a refactor at its Functional Design gate (a summary stage) to enterprise;
// the same with Code Generation still running; a switch to enterprise then a
// jump to Code Generation, and the guide's one-line
// `/aidlc --scope enterprise --stage code-generation`; and a feature run that
// jumps from Requirements Analysis to Code Generation. No Units exist, so Code
// Generation runs once for the whole work: its gate comes back, the Approve is
// recorded, and the run moves on to the next stage, with no refusal and no
// step that names a Unit folder. Going back to Units Generation still splits
// the work into Units.

import { afterAll, describe, expect, test } from "bun:test";
import {
  activeRecord,
  auditEvents,
  cleanupScopeProjects,
  type Directive,
  field,
  runScope,
  type ScopeRun,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";
import { readFileSync } from "node:fs";

afterAll(cleanupScopeProjects);

const CG = "code-generation";
const RA = "requirements-analysis";

interface Moved {
  run: ScopeRun;
  /** The audit rows from the person's line on. */
  rows: ReturnType<typeof auditEvents>;
  /** The directives from the person's line on. */
  after: Directive[];
  /** The stages that started running after `stage`, in order. */
  later: string[];
  /** What the steps the person's lines named printed. */
  said: string;
}

const approvals = (rows: Moved["rows"], stage: string) =>
  rows.filter((e) => e.event === "GATE_APPROVED" && field(e.block, "Stage") === stage);
const unitFolders = (after: Directive[]) =>
  after.filter((d) => JSON.stringify(d).includes("{unit-name}")).map((d) => `${d.kind} ${d.stage}`);
const state = (run: ScopeRun) => readFileSync(activeRecord(run.proj).state, "utf-8");

/**
 * `from` runs to `stage`; the person stops for the day there, at its open gate
 * or (`running`) while it is still being worked. In a new chat they type each
 * of `lines`, then resume. The run stops once `after` + 1 later stages started.
 */
function moveAt(
  from: string,
  stage: string,
  lines: string[],
  options: { running?: boolean; flags?: string[]; after?: number; until?: (d: Directive) => boolean } = {},
): Moved {
  const after = options.after ?? 0;
  let stopped = false;
  let resumed = false;
  const later: string[] = [];
  const run = runScope(from, {
    flags: options.flags ?? [],
    answers: { stopAt: (s) => !options.running && s === stage },
    pauseAtStop: true,
    until: (d) => {
      if (options.running && !stopped && d.kind === "run-stage" && d.stage === stage) return true;
      if (!resumed) return false;
      if (options.until?.(d)) return true;
      if (d.kind === "run-stage" && d.stage !== stage && !later.includes(String(d.stage))) later.push(String(d.stage));
      return later.length > after;
    },
  });
  const { agent } = run;
  if (options.running) {
    stopped = true;
    agent.person.say("let's stop here for today");
    agent.must("orchestrate", "park", "--person-asked");
  }
  const from0 = auditEvents(run.proj).length;
  const directivesFrom = agent.directives.length;
  agent.host.newSession();
  const said: string[] = [];
  for (const line of lines) {
    const answer = agent.personTypes(line);
    expect(answer.kind, JSON.stringify(answer)).toBe("print");
    // The step the line names, run as the agent runs it; its reply is what the person is shown.
    const step = /`(bun \.claude\/tools\/[^`]+)`/.exec(String(answer.message ?? ""))?.[1];
    expect(step, String(answer.message)).toBeDefined();
    const ran = agent.host.bash(step!);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    said.push(ran.stdout);
  }
  agent.host.stop();
  resumed = true;
  // Then they pick the work back up; work stopped mid-stage was parked by hand.
  if (options.running) {
    agent.host.newSession();
    agent.drive(agent.personTypes("/aidlc --resume"));
  } else {
    agent.resume();
  }
  return { run, rows: auditEvents(run.proj).slice(from0), after: agent.directives.slice(directivesFrom), later, said: said.join("\n") };
}

describe("a bugfix at its open Code Generation gate, switched into a scope that runs Units Generation", () => {
  for (const [scope, policy] of [
    ["feature", "off"],
    ["workshop", "off"],
    ["mvp", "relaxed"],
    ["classic", "off"],
    ["enterprise", "strict"],
  ] as const) {
    test(`to ${scope} (Guard Policy ${policy}): the gate comes back, the Approve goes through, and the run moves on`, () => {
      const line = policy === "relaxed" ? `/aidlc --scope ${scope} --guard-policy relaxed` : `/aidlc --scope ${scope}`;
      const { run, rows, after, later, said } = moveAt("bugfix", CG, [line]);
      expect(said).toContain(`Switched to ${scope}`);
      expect(said).toContain("You can switch back to bugfix any time.");
      expect(state(run)).toMatch(new RegExp(`^- \\*\\*Guard Policy\\*\\*: ${policy} `, "m"));
      expect(run.agent.refusalsMet).toEqual([]);
      expect(run.agent.asked.filter((q) => q.what === "guard recovery")).toEqual([]);
      expect(unitFolders(after)).toEqual([]);
      expect(approvals(rows, CG)).toHaveLength(1);
      expect(later[0]).toBe("build-and-test");
    }, SCOPE_RUN_TIMEOUT_MS);
  }
});

describe("a summary stage's open gate", () => {
  test("refactor at its open Functional Design gate, to enterprise: the gate comes back, the Approve goes through, and NFR Requirements starts", () => {
    const FD = "functional-design";
    const { run, rows, after, later, said } = moveAt("refactor", FD, ["/aidlc --scope enterprise"]);
    expect(said).toContain("Switched to enterprise");
    expect(run.agent.refusalsMet).toEqual([]);
    expect(run.agent.asked.filter((q) => q.what === "guard recovery")).toEqual([]);
    expect(unitFolders(after)).toEqual([]);
    expect(approvals(rows, FD)).toHaveLength(1);
    expect(later[0]).toBe("nfr-requirements");
  }, SCOPE_RUN_TIMEOUT_MS);
});

describe("the same with Code Generation still running at the switch", () => {
  test("bugfix to feature: Code Generation is built once for the whole work, its gate is approved, and the run moves on", () => {
    const { run, rows, after, later } = moveAt("bugfix", CG, ["/aidlc --scope feature"], { running: true });
    expect(run.agent.refusalsMet).toEqual([]);
    expect(unitFolders(after)).toEqual([]);
    const built = after.filter((d) => d.kind === "run-stage" && d.stage === CG);
    expect(built.length).toBeGreaterThan(0);
    expect(built.every((d) => d.unit === undefined)).toBe(true);
    expect(approvals(rows, CG)).toHaveLength(1);
    expect(later[0]).toBe("build-and-test");
  }, SCOPE_RUN_TIMEOUT_MS);
});

describe("a jump past Units Generation that never ran", () => {
  test("bugfix at its Requirements Analysis gate, /aidlc --scope enterprise then /aidlc --stage code-generation", () => {
    const { run, rows, after, later } = moveAt("bugfix", RA, ["/aidlc --scope enterprise", "/aidlc --stage code-generation"], { after: 1 });
    expect(run.agent.refusalsMet).toEqual([]);
    expect(unitFolders(after)).toEqual([]);
    expect(rows.filter((e) => e.event === "SCOPE_CHANGED")).toHaveLength(1);
    expect(rows.filter((e) => e.event === "STAGE_JUMPED")).toHaveLength(1);
    expect(approvals(rows, CG)).toHaveLength(1);
    expect(later).toEqual([CG, "build-and-test"]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("the guide's /aidlc --scope enterprise --stage code-generation, from a bugfix at its Requirements Analysis gate", () => {
    const { run, rows, after, later } = moveAt("bugfix", RA, ["/aidlc --scope enterprise --stage code-generation"], { after: 1 });
    expect(run.agent.refusalsMet).toEqual([]);
    expect(unitFolders(after)).toEqual([]);
    expect(approvals(rows, CG)).toHaveLength(1);
    expect(later).toEqual([CG, "build-and-test"]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("feature, at its Requirements Analysis gate: /aidlc --stage code-generation runs Code Generation once, and its Approve goes through", () => {
    const { run, rows, after, later } = moveAt("feature", RA, ["/aidlc --stage code-generation"], { after: 1 });
    expect(run.agent.refusalsMet).toEqual([]);
    expect(unitFolders(after)).toEqual([]);
    expect(rows.filter((e) => e.event === "STAGE_JUMPED")).toHaveLength(1);
    expect(approvals(rows, CG)).toHaveLength(1);
    expect(later).toEqual([CG, "build-and-test"]);
  }, SCOPE_RUN_TIMEOUT_MS);
});

describe("going back to Units Generation after the switch", () => {
  test("bugfix to feature, then /aidlc --stage units-generation: the work is split into Units, and Functional Design runs per Unit", () => {
    const { run, after } = moveAt("bugfix", CG, ["/aidlc --scope feature", "/aidlc --stage units-generation"], {
      // Past the walking-skeleton round trip, the first step Functional Design hands out.
      until: (d) => d.kind === "run-stage" && d.stage === "functional-design" && d.gate !== "unresolved",
      after: 99,
    });
    expect(run.agent.refusalsMet).toEqual([]);
    const design = [...after].reverse().find((d) => d.kind === "run-stage" && d.stage === "functional-design");
    expect(JSON.stringify(design)).toContain("/construction/core/functional-design/");
    expect(after.some((d) => d.kind === "run-stage" && d.stage === "units-generation")).toBe(true);
  }, SCOPE_RUN_TIMEOUT_MS);
});
