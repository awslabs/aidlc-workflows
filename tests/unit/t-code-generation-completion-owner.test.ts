// covers: function:codeGenerationPlanWaits, function:handleReport, function:handleUnit
//
// A Code Generation completion waits for the plan it builds from. Through the
// real engine, with no hook in front: while the plan is not written, written and
// not asked, asked, sent back with Request Changes, or changed after its approval
// under strict, `report` opening the gate, completing the stage or approving it
// with no gate open, and a Unit's `unit complete`, are answered with the step
// that names `next`; nothing moves. Once the plan is approved (or plan approval
// is off) they go through, the refusal never comes back after its step, and the
// gate shown again after a review (the step its opening retired) goes through.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTestProject, seedBoltDagBatches, seededStateFile } from "../harness/fixtures.ts";
import {
  answer,
  auditEvents,
  createCodeGenerationProject,
  next,
  reply,
  runNamed,
  SESSION,
  stageDir,
  STATES,
  type Step,
  writePlan,
} from "../harness/code-generation-states.ts";

setDefaultTimeout(600_000);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const WAITS = "The code plan is not approved yet: run `bun .claude/tools/aidlc-orchestrate.ts next` and follow the step it prints.";
const REVIEWER = "aidlc-architecture-reviewer-agent";

function report(proj: string, result: string, extra = "", env: NodeJS.ProcessEnv = {}): { status: number; step: Step } {
  const ran = runNamed(proj, `bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result ${result}${extra}`, env);
  return { status: ran.status, step: JSON.parse(ran.stdout || "{}") as Step };
}

function stageLine(proj: string): string {
  return /- \[.\] code-generation .*/.exec(readFileSync(seededStateFile(proj), "utf-8"))?.[0] ?? "";
}

// A READY review of Code Generation (of one Unit when named), requested and
// recorded through the engine.
function reviewed(proj: string, iteration: number, { personAsked, unit }: { personAsked?: boolean; unit?: string } = {}): void {
  const request = `bun .claude/tools/aidlc.ts engine log review --stage code-generation${unit ? ` --unit ${unit}` : ""}` +
    ` --reviewer ${REVIEWER} --iteration ${iteration}`;
  const requested = runNamed(proj, `${request}${personAsked ? " --person-asked" : ""}`);
  const reviewFile = (JSON.parse(requested.stdout || "{}") as { reviewFile?: string }).reviewFile;
  if (requested.status !== 0 || !reviewFile) throw new Error(`no review file named:\n${requested.stdout}${requested.stderr}`);
  mkdirSync(dirname(join(proj, reviewFile)), { recursive: true });
  writeFileSync(join(proj, reviewFile), `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n` +
    `**Date:** 2026-01-01T00:00:00Z\n**Iteration:** ${iteration}\n\n### Findings\n\n**Prior findings**\n\n` +
    "| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n" +
    "| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  const recorded = runNamed(proj, `${request} --verdict READY`);
  if (recorded.status !== 0) throw new Error(`the review was not recorded:\n${recorded.stdout}${recorded.stderr}`);
}

// What a build leaves for the gate, the way an unseen command would have
// written it: the code, the stage's traceability, and one READY review (none
// before any plan exists, where a review cannot be requested).
function built(proj: string, review: { iteration: number; personAsked?: boolean } | null = { iteration: 1 }): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(join(stageDir(proj), "traceability.json"), "{}\n", "utf-8");
  writeFileSync(join(proj, "src", "slugify.ts"), "export const slugify = (s: string) => s;\n", "utf-8");
  if (review !== null) reviewed(proj, review.iteration, review);
}

// A poc project with Code Generation in progress (the previous stage's
// approval marks it so) and its records stage-level.
function inProgress(policy: "relaxed" | "strict" = "relaxed", planApproval: "on" | "off" = "on"): string {
  const proj = createCodeGenerationProject(policy, planApproval);
  created.push(proj);
  const stateFile = seededStateFile(proj);
  writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
    .replace("- [ ] code-generation", "- [-] code-generation")
    .replace(/^(- \[.\] units-generation) \u2014 EXECUTE$/m, "$1 \u2014 SKIP"), "utf-8");
  next(proj);
  return proj;
}

function approvePlan(proj: string): void {
  reply(proj, "approve");
  const recorded = answer(proj, "Approve Plan");
  if (recorded.status !== 0) throw new Error(`Approve Plan was not recorded:\n${recorded.stdout}${recorded.stderr}`);
}

const WAITING: Array<[string, (proj: string) => void]> = [
  ["no plan written yet", () => {}],
  ["the plan written, not yet asked", (proj) => writePlan(proj)],
  ["the plan question open", (proj) => {
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
  }],
  ["the plan sent back with Request Changes", (proj) => {
    writePlan(proj);
    next(proj);
    reply(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes").status).toBe(0);
    expect(next(proj).plan_approval?.status).toBe("revise");
  }],
];

describe("a Code Generation completion waits for its plan", () => {
  for (const [name, seed] of WAITING) {
    test(`${name}: the gate does not open, the stage does not complete, and the step names next`, () => {
      const proj = inProgress();
      seed(proj);
      built(proj, name === "no plan written yet" ? null : { iteration: 1 });
      const before = stageLine(proj);
      for (const [result, extra] of [["awaiting-approval", ""], ["completed", ""], ["approved", ' --user-input "Approve"']]) {
        if (result === "approved") reply(proj, "approve");
        const refused = report(proj, result, extra);
        expect(refused.status, JSON.stringify(refused.step)).toBe(0);
        expect(refused.step.kind, `${result}: ${JSON.stringify(refused.step)}`).toBe("print");
        expect(refused.step.message, result).toBe(WAITS);
        expect(stageLine(proj), result).toBe(before);
      }
    });
  }

  test("the step it names leads to the plan question; once approved the gate opens and the refusal does not come back", () => {
    const proj = inProgress();
    writePlan(proj);
    built(proj);
    expect(report(proj, "awaiting-approval").step.message).toBe(WAITS);
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("ask");
    expect(step.ask_type).toBe("plan-approval");
    approvePlan(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    const opened = report(proj, "awaiting-approval");
    expect(opened.step.message, JSON.stringify(opened.step)).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });

  test("Guard Policy strict, the plan changed after its approval: the gate waits until the person approves it again", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    writePlan(proj, "- [ ] Step 2: handle unicode\n");
    built(proj);
    expect(report(proj, "awaiting-approval").step.message).toBe(WAITS);
    expect(next(proj).ask_type).toBe("plan-approval");
    approvePlan(proj);
    next(proj);
    expect(report(proj, "awaiting-approval").step.message).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });

  // With plan approval off the plan waits for nobody, before `next` has
  // recorded that nobody was asked as after.
  test("the machine switch AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1: the gate opens", () => {
    const proj = inProgress();
    writePlan(proj);
    built(proj);
    const opened = report(proj, "awaiting-approval", "", { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" });
    expect(opened.step.message ?? "", JSON.stringify(opened.step)).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });

  test("plan approval turned off while the plan question is open: the gate opens", () => {
    const proj = inProgress();
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    const stateFile = seededStateFile(proj);
    writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
      .replace("- **Plan Approval**: on (set by you)", "- **Plan Approval**: off (set by you)"), "utf-8");
    built(proj);
    const opened = report(proj, "awaiting-approval");
    expect(opened.step.message ?? "", JSON.stringify(opened.step)).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });

  test("plan approval off: the gate opens with no question", () => {
    const proj = inProgress("relaxed", "off");
    writePlan(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    built(proj);
    expect(report(proj, "awaiting-approval").step.message).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });
});

describe("at the open gate the person's plan stands", () => {
  // E15-X (Codex): after a second review the person asked for, the agent shows
  // the gate again; the gate's opening had retired the build step.
  test("the gate shown again after a review the person asked for goes through", () => {
    const state = STATES.find((builder) => builder.id === "S11a")!.build();
    created.push(state.proj);
    expect(reply(state.proj, "review it again").status).toBe(0);
    built(state.proj, { iteration: 2, personAsked: true });
    const again = report(state.proj, "awaiting-approval");
    expect(again.step.message, JSON.stringify(again.step)).not.toBe(WAITS);
    expect(stageLine(state.proj)).toContain("[?] code-generation");
  });

  test("the person's approval at the open gate completes the stage", () => {
    const state = STATES.find((builder) => builder.id === "S11a")!.build();
    created.push(state.proj);
    expect(reply(state.proj, "approve").status).toBe(0);
    const approved = report(state.proj, "approved", ' --user-input "Approve"');
    expect(approved.step.message ?? "", JSON.stringify(approved.step)).not.toBe(WAITS);
    expect(stageLine(state.proj)).toContain("[x] code-generation");
  });

  // Request Changes at the gate starts a new attempt whose plan is revised
  // first: `revised` waits for that plan, and its step leads there.
  test("after a Request Changes at the gate, revised waits for the revised plan, then goes through", () => {
    const state = STATES.find((builder) => builder.id === "S11a")!.build();
    created.push(state.proj);
    expect(reply(state.proj, "name the file slug.ts").status).toBe(0);
    const rejected = report(state.proj, "rejected", ' --user-input "Request Changes" --reason "name the file slug.ts"');
    expect(rejected.status, JSON.stringify(rejected.step)).toBe(0);
    expect(stageLine(state.proj), JSON.stringify(rejected.step)).toContain("[R] code-generation");
    built(state.proj, { iteration: 1 });
    expect(report(state.proj, "revised").step.message).toBe(WAITS);
    expect(next(state.proj).plan_approval?.status).toBe("revise");
    writePlan(state.proj, "- [ ] Step 2: name the file slug.ts\n");
    // Under this work's relaxed Guard Policy the approved plan's change builds
    // on with one line; under strict `next` asks again first.
    let step = next(state.proj);
    if (step.ask_type === "plan-approval") {
      approvePlan(state.proj);
      step = next(state.proj);
    }
    expect(step.plan_approval?.status, JSON.stringify(step)).toBe("approved");
    const revised = report(state.proj, "revised");
    expect(revised.step.message ?? "", JSON.stringify(revised.step)).not.toBe(WAITS);
    expect(stageLine(state.proj)).toContain("[?] code-generation");
  });
});

// A feature project at Code Generation for one Unit, after Units Generation
// ran, built through `next`.
function perUnit(policy: "relaxed" | "strict" = "relaxed"): string {
  const proj = createCodeGenerationProject(policy);
  created.push(proj);
  const stateFile = seededStateFile(proj);
  writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
    .replace("- **Scope**: poc", "- **Scope**: feature")
    .replace("- [ ] units-generation", "- [x] units-generation")
    .replace("- [ ] code-generation", "- [-] code-generation"), "utf-8");
  seedBoltDagBatches(proj, [["alpha"]]);
  const step = next(proj);
  expect(step.unit, JSON.stringify(step)).toBe("alpha");
  writePlan(proj, "", "alpha");
  const dir = stageDir(proj, "alpha");
  writeFileSync(join(dir, "code-summary.md"), "# Code Summary\n\nslugify\n", "utf-8");
  writeFileSync(join(dir, "traceability.json"), "{}\n", "utf-8");
  writeFileSync(join(dir, "source-manifest.json"),
    `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "src/slugify.ts" }] })}\n`, "utf-8");
  writeFileSync(join(proj, "src", "slugify.ts"), "export const slugify = (s: string) => s;\n", "utf-8");
  return proj;
}

describe("a Unit's Code Generation completes once its plan is approved", () => {
  const COMPLETE = "bun .claude/tools/aidlc.ts engine state unit complete --stage code-generation --unit alpha";
  const START = "bun .claude/tools/aidlc.ts engine state unit start --stage code-generation --unit alpha";

  test("before the approval: refused with the step, and nothing is recorded", () => {
    const proj = perUnit();
    expect(runNamed(proj, START).status).toBe(0);
    const refused = runNamed(proj, COMPLETE);
    expect(refused.status, refused.stdout).not.toBe(0);
    expect((JSON.parse(refused.stderr) as { error?: string }).error)
      .toBe(`Refusing to complete unit "alpha" for "code-generation": ${WAITS}`);
    expect(auditEvents(proj).some((row) => row.event === "UNIT_COMPLETED")).toBe(false);
    expect(next(proj).ask_type, "the plan question is still to come").toBe("plan-approval");
  });

  test("after the approval: it completes", () => {
    const proj = perUnit();
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, "approve");
    const recorded = answer(proj, "Approve Plan", ["--session", SESSION]);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    expect(next(proj).plan_approval?.status).toBe("approved");
    expect(runNamed(proj, START).status).toBe(0);
    const completed = runNamed(proj, COMPLETE);
    expect(completed.status, completed.stdout + completed.stderr).toBe(0);
    expect(completed.stdout).toContain("UNIT_COMPLETED");
  });

  // Its completion went through on the plan; the stage's gate does not judge it
  // again, so a Testing Contract that reads stale since (an update, a changed
  // Test Strategy) never holds a gate that `next` routes straight back to.
  test("strict: the stage's gate does not judge a completed Unit's plan again", () => {
    const proj = perUnit("strict");
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, "approve");
    expect(answer(proj, "Approve Plan", ["--session", SESSION]).status).toBe(0);
    expect(next(proj).plan_approval?.status).toBe("approved");
    expect(runNamed(proj, START).status).toBe(0);
    expect(runNamed(proj, COMPLETE).status).toBe(0);
    const stateFile = seededStateFile(proj);
    writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
      .replace("- **Test Strategy**: Standard", "- **Test Strategy**: Comprehensive"), "utf-8");
    reviewed(proj, 1, { unit: "alpha" });
    const gate = report(proj, "awaiting-approval");
    // The plan does not hold it (strict's own source checks still speak here).
    expect(gate.step.message ?? "", JSON.stringify(gate.step)).not.toBe(WAITS);
  });
});
