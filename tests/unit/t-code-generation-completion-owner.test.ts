// covers: function:codeGenerationPlanWaits, function:handleReport, function:handleUnit, function:engineCommandAdmitted,
// function:reviewedUnderContract, function:codeGenerationPlanWaitsStep, function:codeGenerationFinishedBuild
//
// A Code Generation completion waits for the plan it builds from. Through the
// real engine, with no hook in front: while the plan is not written, written and
// not asked, asked, sent back with Request Changes, or changed after its approval
// under strict, `report` opening the gate, completing the stage or approving it
// with no gate open, and a Unit's `unit complete`, are answered with the step
// that names `next`; an isolated run's `report --single`, with the step that
// names that run's own `next`; nothing moves. Once the plan is approved (or plan approval
// is off) they go through, the refusal never comes back after its step, and the
// gate shown again after a review (the step its opening retired) goes through.
// A testing practice kept at the gate after the review moves the Testing
// Contract for the next build only: under strict the gate opens, a Unit's
// completion goes through and `next` names it, unless the person asked to see
// the plan again, which holds the completion with a step that says so; a
// contract that moved before the review still holds the build that ran.
// The engine is the hold's one owner: the plan-approval guard in front of the
// same commands, on every harness, admits them, says nothing and records nothing.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTestProject, seedBoltDagBatches, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  answer,
  auditEvents,
  createCodeGenerationProject,
  namedCommands,
  next,
  openCodeGenerationGate,
  reply,
  runNamed,
  SESSION,
  SHAPES,
  stageDir,
  STATES,
  type Step,
  writePlan,
} from "../harness/code-generation-states.ts";
import { invalidateActiveDirectiveContext, stateDigest, writeActiveDirectiveMarker } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

// The stage's checks run once before its review or gate, and again at the gate
// (completionChecksStep, t-checks-before-review); this file's fixture documents
// are not written for them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

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
  // A review the person asked for names the message they asked in.
  const turn = auditEvents(proj).filter((row) => row.event === "HUMAN_TURN" && /\*\*Message Id\*\*: /.test(row.block)).at(-1);
  const id = /\*\*Message Id\*\*: (\S+)/.exec(turn?.block ?? "")?.[1] ?? "";
  const asked = personAsked ? ` --person-asked --message ${id}` : "";
  const requested = runNamed(proj, `${request}${asked}`);
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
function inProgress(policy: "relaxed" | "strict" | "off" = "relaxed", planApproval: "on" | "off" = "on"): string {
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

// A testing practice the person keeps at the gate (the learnings step, after
// the review and before the gate opens) lands under `## Testing Posture` and
// moves the Testing Contract. It is for the next build: the build that ran was
// reviewed under the plan's own contract, so under strict the gate opens with
// the plan untouched and nothing asked again. A contract that moved before the
// review moved while the build ran, and that build still waits for the plan.
function keepTestingPractice(proj: string): void {
  const path = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
  const memory = readFileSync(path, "utf-8");
  expect(memory).toContain("## Testing Posture\n");
  const before = resolveTestingPosture(proj).contract_sha256;
  // The line `learnings persist` writes for a practice kept for this project.
  writeFileSync(path, memory.replace("## Testing Posture\n", "## Testing Posture\n\n" +
    "- Run the unit tests of each changed module before reporting a build (learned 2026-10-26) " +
    "<!-- cid:fixture:code-generation:0000 -->\n"), "utf-8");
  expect(resolveTestingPosture(proj).contract_sha256, "the practice moves the contract").not.toBe(before);
}

describe("a testing practice kept at the gate is for the next build", () => {
  const OPEN_GATE = "bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result awaiting-approval";
  const lastStep = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Step;
  const planFile = (proj: string, unit: string | null = null) => join(stageDir(proj, unit), "code-generation-plan.md");

  test("strict: kept after the review, the gate opens with the plan as approved and nothing asked again", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    approvePlan(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    built(proj);
    keepTestingPractice(proj);
    const plan = readFileSync(planFile(proj), "utf-8");
    // This fixture's review leaves a change line ahead of each step.
    const opened = lastStep(runNamed(proj, OPEN_GATE).stdout);
    expect(opened.kind, JSON.stringify(opened)).toBe("print");
    expect(opened.message, JSON.stringify(opened)).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
    const gate = lastStep(runNamed(proj, "bun .claude/tools/aidlc.ts engine orchestrate next").stdout) as Step & { gate_only?: boolean };
    expect(gate.gate_only, JSON.stringify(gate)).toBe(true);
    expect(gate.plan_approval, JSON.stringify(gate)).toBeUndefined();
    expect(readFileSync(planFile(proj), "utf-8")).toBe(plan);
  });

  // The chat compacts between the learnings step and the gate, so `next` comes
  // first: it hands over the finish of the reviewed build, not the build again,
  // and a write the agent tries meanwhile is refused toward that finish.
  test("strict: a next between the kept practice and the gate hands over the finish, and a write is refused toward it", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    built(proj);
    const NEXT = "bun .claude/tools/aidlc.ts engine orchestrate next";
    expect(lastStep(runNamed(proj, NEXT).stdout).plan_approval?.status).toBe("approved");
    const brief = runNamed(proj, `bun .claude/tools/aidlc.ts engine testing-posture brief --stage-level --project-dir ${proj}`);
    expect(brief.status, brief.stderr).toBe(0);
    keepTestingPractice(proj);
    const after = lastStep(runNamed(proj, NEXT).stdout);
    expect(after.kind, JSON.stringify(after)).toBe("print");
    expect(after.message, JSON.stringify(after)).toContain("report --stage code-generation --result awaiting-approval");
    expect(after.plan_approval, JSON.stringify(after)).toBeUndefined();
    const refused = guardOn(proj, "echo hi > src/y.ts");
    expect(refused).toStartWith("exit 2;");
    expect(refused).toContain("it says what this build does next");
    expect(refused).not.toContain("asks the person to approve");
    expect(refused).not.toContain("approve the plan");
    // A developer handoff is refused as it is on main, naming `next` too.
    const handoff = dispatchOn(proj, brief.stdout);
    expect(handoff).toStartWith("exit 2;");
    expect(handoff).toContain("bun .claude/tools/aidlc-orchestrate.ts next");
    expect(lastStep(runNamed(proj, OPEN_GATE).stdout).message).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });

  // The person asks to see the plan again after keeping the practice: `next`
  // goes back to the plan (brought up to the moved contract, then asked), as it
  // does on a plan whose contract moved, not on to the finish.
  test("strict: a Review the plan after the kept practice goes back to the plan, not to the finish", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    built(proj);
    keepTestingPractice(proj);
    reply(proj, "review the plan first");
    const review = answer(proj, "Review the plan");
    expect(review.status, `${review.stdout}${review.stderr}`).toBe(0);
    expect(lastStep(runNamed(proj, OPEN_GATE).stdout).message, "the gate waits for the plan they asked to see")
      .toBe("The person asked to see the code plan again: run `bun .claude/tools/aidlc-orchestrate.ts next` and follow the step it prints.");
    expect(stageLine(proj)).toContain("[-] code-generation");
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.plan_approval?.status, JSON.stringify(step)).toBe("plan");
    const refused = guardOn(proj, "echo hi > src/y.ts");
    expect(refused).toStartWith("exit 2;");
    expect(refused).toContain("the engine asks the person to approve it before any code is written");
    expect(refused).not.toContain("applies from the next plan");
  });

  // Only a swarm worker's checkout records no contract: a `.aidlc/worktree-meta.json`
  // that names no worker (left over, or copied in) does not turn it off. (What
  // such a file does to the rest of the engine is not this field's.)
  test("strict: a stray worktree-meta.json does not stop the review recording its contract", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    mkdirSync(join(proj, ".aidlc"), { recursive: true });
    writeFileSync(join(proj, ".aidlc", "worktree-meta.json"), `${JSON.stringify({ version: 1 })}\n`, "utf-8");
    built(proj);
    const review = auditEvents(proj).filter((row) => row.event === "REVIEW_COMPLETED").at(-1);
    expect(review?.block, "a review was recorded").toBeDefined();
    expect(review?.block).toContain(`**Testing Contract**: ${resolveTestingPosture(proj).contract_sha256}`);
  });

  // Reviews switched off after the review: the review on record is read with
  // the class it ran under, so the kept practice still lets the gate open.
  test("strict: reviews switched off after the review, a practice kept then still lets the gate open", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    built(proj);
    const stateFile = seededStateFile(proj);
    const state = readFileSync(stateFile, "utf-8");
    expect(state).not.toContain("**Review Override**");
    writeFileSync(stateFile, state.replace(/^(- \*\*Scope\*\*: .*)$/m, "$1\n- **Review Override**: none"), "utf-8");
    keepTestingPractice(proj);
    const step = lastStep(runNamed(proj, "bun .claude/tools/aidlc.ts engine orchestrate next").stdout);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message, JSON.stringify(step)).toContain("report --stage code-generation --result awaiting-approval");
    expect(lastStep(runNamed(proj, OPEN_GATE).stdout).message).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });

  test("strict: moved before the review, while the build ran, the build still waits for the plan", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    keepTestingPractice(proj);
    built(proj);
    expect(lastStep(runNamed(proj, OPEN_GATE).stdout).message).toBe(WAITS);
    expect(stageLine(proj)).toContain("[-] code-generation");
  });

  // The plan comes back after a mid-build move, is approved again, built and
  // reviewed again: the review the gate reads is that last one, so the earlier
  // review under the older contract does not count against a practice kept now.
  test("strict: approved again after a mid-build move and reviewed again, a practice kept then lets the gate open", () => {
    const proj = inProgress("strict");
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    keepTestingPractice(proj);
    built(proj);
    expect(lastStep(runNamed(proj, OPEN_GATE).stdout).message).toBe(WAITS);
    expect(next(proj).plan_approval?.status).toBe("plan");
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    approvePlan(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    built(proj, { iteration: 2, personAsked: true });
    keepTestingPractice(proj);
    expect(lastStep(runNamed(proj, OPEN_GATE).stdout).message).not.toBe(WAITS);
    expect(stageLine(proj)).toContain("[?] code-generation");
  });

  // A Unit approved, started and reviewed, then a practice kept.
  const keptAfterUnitReview = (): string => {
    const proj = perUnit("strict");
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, "approve");
    expect(answer(proj, "Approve Plan", ["--session", SESSION]).status).toBe(0);
    expect(next(proj).plan_approval?.status).toBe("approved");
    expect(runNamed(proj, "bun .claude/tools/aidlc.ts engine state unit start --stage code-generation --unit alpha").status).toBe(0);
    reviewed(proj, 1, { unit: "alpha" });
    keepTestingPractice(proj);
    return proj;
  };

  test("strict, a Unit: kept after its review, next names its completion and the Unit completes", () => {
    const proj = keptAfterUnitReview();
    const complete = "bun .claude/tools/aidlc.ts engine state unit complete --stage code-generation --unit alpha";
    const step = next(proj) as Step & { unit_record_step?: string };
    expect(step.plan_approval?.status, JSON.stringify(step)).toBe("approved");
    expect(step.unit_record_step, JSON.stringify(step)).toContain("unit complete --stage code-generation --unit alpha");
    const completed = runNamed(proj, complete);
    expect(completed.status, completed.stdout + completed.stderr).toBe(0);
    expect(completed.stdout).toContain("UNIT_COMPLETED");
  });

  test("strict, a Unit: a Review the plan after the kept practice holds its completion and says so", () => {
    const proj = keptAfterUnitReview();
    reply(proj, "review the plan first");
    const review = answer(proj, "Review the plan");
    expect(review.status, `${review.stdout}${review.stderr}`).toBe(0);
    const refused = runNamed(proj, "bun .claude/tools/aidlc.ts engine state unit complete --stage code-generation --unit alpha");
    expect(refused.status, refused.stdout + refused.stderr).not.toBe(0);
    expect((JSON.parse(refused.stderr || "{}") as { error?: string }).error).toBe(
      'Refusing to complete unit "alpha" for "code-generation": The person asked to see the code plan again: ' +
        "run `bun .claude/tools/aidlc-orchestrate.ts next` and follow the step it prints.");
    expect(auditEvents(proj).some((row) => row.event === "UNIT_COMPLETED"), "nothing moved").toBe(false);
    const step = next(proj);
    expect(step.plan_approval?.status, JSON.stringify(step)).toBe("plan");
  });
});

// The hold has one owner. In each plan state a run can be in, built the way the
// run leaves it, the plan-approval guard admits every Code Generation completion
// with nothing said and nothing recorded, and the engine's own command is where
// the hold is said: while the plan waits it answers with the plan step and the
// state file is not touched; once the plan lets the build go, the same command
// moves the state. Under every Guard Policy, with plan approval on and off.
type HoldState = { name: string; waits: boolean; command: "open" | "approve" | "unit"; build: () => string };

function compacted(proj: string): void {
  const marker = JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8")) as
    { owner_session?: string };
  if (!invalidateActiveDirectiveContext(proj, readFileSync(seededStateFile(proj), "utf-8"), marker.owner_session ?? SESSION)) {
    throw new Error("the build step could not be set aside as a compaction sets it aside");
  }
}

const POLICIES = ["strict", "relaxed", "off"] as const;
const UNIT_START = "bun .claude/tools/aidlc.ts engine state unit start --stage code-generation --unit alpha";
const UNIT_COMPLETE = "bun .claude/tools/aidlc.ts engine state unit complete --stage code-generation --unit alpha";
const CHANGED = "- [ ] Step 2: handle unicode\n";

const HOLD_STATES: HoldState[] = [
  { name: "no plan yet", waits: true, command: "open", build: () => {
    const proj = inProgress();
    built(proj, null);
    return proj;
  } },
  { name: "the plan written, not yet asked", waits: true, command: "open", build: () => {
    const proj = inProgress();
    writePlan(proj);
    built(proj);
    return proj;
  } },
  ...POLICIES.map((policy): HoldState => ({ name: `the plan question open (${policy})`, waits: true, command: "open", build: () => {
    const proj = inProgress(policy);
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    built(proj);
    return proj;
  } })),
  { name: "the plan sent back with Request Changes", waits: true, command: "open", build: () => {
    const proj = inProgress();
    writePlan(proj);
    next(proj);
    reply(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes").status).toBe(0);
    built(proj);
    return proj;
  } },
  ...POLICIES.map((policy): HoldState => ({ name: `the plan approved (${policy})`, waits: false, command: "open", build: () => {
    const proj = inProgress(policy);
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    built(proj);
    return proj;
  } })),
  // The engine's recovery question over the open plan question, written as the
  // engine writes it: a completion the person did not pick there waits too.
  { name: "a recovery question left open while the plan waits", waits: true, command: "open", build: () => {
    const proj = inProgress();
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    writeActiveDirectiveMarker(proj, {
      kind: "ask", ask_type: "guard-recovery", stage: "code-generation",
      remedies: [{ op: "request-changes", action: 'Ask "What should change?"', interaction: "human-input" }],
      state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")),
    });
    built(proj);
    return proj;
  } },
  { name: "the plan approved, then the chat compacted", waits: false, command: "open", build: () => {
    const proj = inProgress();
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    next(proj);
    compacted(proj);
    built(proj);
    return proj;
  } },
  { name: "the plan approved, the gate reported before next", waits: false, command: "open", build: () => {
    const proj = inProgress();
    writePlan(proj);
    next(proj);
    approvePlan(proj);
    built(proj);
    return proj;
  } },
  ...POLICIES.map((policy): HoldState => ({
    name: `the plan changed after its approval (${policy})`, waits: policy === "strict", command: "open", build: () => {
      const proj = inProgress(policy);
      writePlan(proj);
      next(proj);
      approvePlan(proj);
      next(proj);
      writePlan(proj, CHANGED);
      built(proj);
      return proj;
    },
  })),
  { name: "plan approval off for this work", waits: false, command: "open", build: () => {
    const proj = inProgress("relaxed", "off");
    writePlan(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    built(proj);
    return proj;
  } },
  { name: "plan approval turned off at the open plan question", waits: false, command: "open", build: () => {
    const proj = inProgress();
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    const stateFile = seededStateFile(proj);
    writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
      .replace("- **Plan Approval**: on (set by you)", "- **Plan Approval**: off (set by you)"), "utf-8");
    built(proj);
    return proj;
  } },
  ...POLICIES.map((policy): HoldState => ({ name: `the open gate, the person approves (${policy})`, waits: false, command: "approve",
    build: () => openCodeGenerationGate(policy) })),
  { name: "the open gate, the plan changed after its approval (strict)", waits: true, command: "open", build: () => {
    const proj = openCodeGenerationGate("strict");
    writePlan(proj, CHANGED);
    return proj;
  } },
  ...(["strict", "relaxed"] as const).map((policy): HoldState => ({ name: `a Unit before its plan is approved (${policy})`, waits: true,
    command: "unit", build: () => {
      const proj = perUnit(policy);
      expect(runNamed(proj, UNIT_START).status).toBe(0);
      return proj;
    } })),
  ...(["strict", "relaxed"] as const).map((policy): HoldState => ({ name: `a Unit with its plan approved (${policy})`, waits: false,
    command: "unit", build: () => {
      const proj = perUnit(policy);
      expect(next(proj).ask_type).toBe("plan-approval");
      reply(proj, "approve");
      expect(answer(proj, "Approve Plan", ["--session", SESSION]).status).toBe(0);
      expect(next(proj).plan_approval?.status).toBe("approved");
      expect(runNamed(proj, UNIT_START).status).toBe(0);
      return proj;
    } })),
  ...(["strict", "relaxed"] as const).map((policy): HoldState => ({
    name: `a Unit whose plan changed after its approval (${policy})`, waits: policy === "strict", command: "unit", build: () => {
      const proj = perUnit(policy);
      expect(next(proj).ask_type).toBe("plan-approval");
      reply(proj, "approve");
      expect(answer(proj, "Approve Plan", ["--session", SESSION]).status).toBe(0);
      next(proj);
      expect(runNamed(proj, UNIT_START).status).toBe(0);
      writePlan(proj, CHANGED, "alpha");
      return proj;
    },
  })),
];


const REPORT = "bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result";
const STAGE_COMPLETIONS = [
  `${REPORT} awaiting-approval`,
  `${REPORT} completed`,
  `${REPORT} approved --user-input "Approve"`,
  `${REPORT} revised`,
];
const GUARD_ROWS = new Set(["PLAN_APPROVAL_BLOCKED", "GUARD_STOOD_ASIDE"]);

// What the plan-approval guard does with a completion command, as Claude Code
// delivers it: its exit, what it printed, and the refusal or stand-aside rows it wrote.
function guardOn(proj: string, command: string): string {
  const rows = () => auditEvents(proj).filter((row) => GUARD_ROWS.has(row.event)).length;
  const before = rows();
  const ran = spawnSync(process.execPath, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: proj,
    encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, AIDLC_UNATTENDED: undefined, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj } as NodeJS.ProcessEnv,
  });
  return `exit ${ran.status}; stdout ${JSON.stringify(ran.stdout.trim())}; stderr ${JSON.stringify(ran.stderr.trim())}; rows ${rows() - before}`;
}
const ADMITTED = 'exit 0; stdout ""; stderr ""; rows 0';

// The same guard on a developer handoff carrying this brief.
function dispatchOn(proj: string, prompt: string): string {
  const ran = spawnSync(process.execPath, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: proj,
    encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "Task",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt },
    }),
    env: { ...process.env, AIDLC_UNATTENDED: undefined, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj } as NodeJS.ProcessEnv,
  });
  return `exit ${ran.status}; stderr ${JSON.stringify(ran.stderr.trim())}`;
}

// The engine's own answer to the state's completion: whether it said the plan
// step, and the state file after it.
function engineCompletion(proj: string, command: HoldState["command"]): { waited: boolean; said: string } {
  if (command === "unit") {
    const ran = runNamed(proj, UNIT_COMPLETE);
    const error = ran.status === 0 ? "" : (JSON.parse(ran.stderr || "{}") as { error?: string }).error ?? ran.stderr;
    return { waited: error === `Refusing to complete unit "alpha" for "code-generation": ${WAITS}`, said: error || ran.stdout };
  }
  if (command === "approve") reply(proj, "approve");
  const ran = command === "approve" ? report(proj, "approved", ' --user-input "Approve"') : report(proj, "awaiting-approval");
  return { waited: ran.step.message === WAITS, said: JSON.stringify(ran.step) };
}

describe("one owner: the engine's own completion holds while the plan waits, and only then", () => {
  for (const state of HOLD_STATES) {
    test(`${state.name}: ${state.waits ? "the plan step, nothing written" : "the completion goes through"}`, () => {
      const proj = state.build();
      created.push(proj);
      for (const command of state.command === "unit" ? [UNIT_COMPLETE] : STAGE_COMPLETIONS) {
        expect(guardOn(proj, command), command).toBe(ADMITTED);
      }
      const before = readFileSync(seededStateFile(proj), "utf-8");
      const engine = engineCompletion(proj, state.command);
      expect(engine.waited, engine.said).toBe(state.waits);
      if (state.waits) expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
      else expect(readFileSync(seededStateFile(proj), "utf-8"), engine.said).not.toBe(before);
      if (state.command === "unit") {
        expect(auditEvents(proj).some((row) => row.event === "UNIT_COMPLETED")).toBe(!state.waits);
      }
    });
  }

  test("every harness's guard admits a completion while the plan waits: the engine says the plan step", async () => {
    const proj = HOLD_STATES.find((state) => state.name === "the plan question open (relaxed)")!.build();
    created.push(proj);
    const refused: string[] = [];
    for (const shape of SHAPES) {
      shape.install(proj);
      for (const command of STAGE_COMPLETIONS) {
        const verdict = await shape.call(proj, SESSION, { tool: "Bash", command });
        if (verdict.code !== 0 || verdict.said !== "") refused.push(`[${shape.name}] ${command} -> ${verdict.code} ${verdict.said}`);
      }
    }
    expect(refused).toEqual([]);
    SHAPES[0].install(proj);
    expect(engineCompletion(proj, "open").waited).toBe(true);
    // A report that names no stage is the current stage's: the same step.
    const unnamed = runNamed(proj, "bun .claude/tools/aidlc.ts engine orchestrate report --result awaiting-approval");
    expect((JSON.parse(unnamed.stdout || "{}") as Step).message, unnamed.stdout).toBe(WAITS);
  });
});

// An isolated run (`next --stage code-generation --single`) asks the same plan
// question; its `report --single` waits for the same plan, and the guard leaves
// that to it as well. Its step names the run's own `next` with the scope it
// started with, since a bare `next` routes the main workflow and, with no
// workflow, `next` takes the default scope, which the open attempt refuses. The
// run closes outside the main workflow, so its record is its STAGE_COMPLETED row.
describe("one owner: an isolated Code Generation run completes only once its plan lets it build", () => {
  const SINGLE = ["--stage", "code-generation", "--single"];
  const SINGLE_REPORT = "bun .claude/tools/aidlc.ts engine orchestrate report --single --stage code-generation --result completed";
  const singleWaits = (scope: string) => "The code plan is not approved yet: run " +
    `\`bun .claude/tools/aidlc-orchestrate.ts next --stage code-generation --single --scope ${scope}\` and follow the step it prints.`;
  const SINGLE_WAITS = singleWaits("poc");
  const completions = (proj: string) => auditEvents(proj).filter((row) => row.event === "STAGE_COMPLETED").length;
  const ISOLATED: Array<{ name: string; waits: boolean; build: () => string }> = [
    { name: "no plan yet", waits: true, build: () => {
      const proj = createCodeGenerationProject();
      expect(next(proj, SINGLE).plan_approval?.status).toBe("plan");
      return proj;
    } },
    { name: "the plan question open", waits: true, build: () => {
      const proj = createCodeGenerationProject();
      next(proj, SINGLE);
      writePlan(proj);
      expect(next(proj, SINGLE).ask_type).toBe("plan-approval");
      return proj;
    } },
    { name: "the plan approved", waits: false, build: () => {
      const proj = createCodeGenerationProject();
      next(proj, SINGLE);
      writePlan(proj);
      expect(next(proj, SINGLE).ask_type).toBe("plan-approval");
      approvePlan(proj);
      expect(next(proj, SINGLE).plan_approval?.status).toBe("approved");
      return proj;
    } },
    { name: "plan approval off", waits: false, build: () => {
      const proj = createCodeGenerationProject("relaxed", "off");
      next(proj, SINGLE);
      writePlan(proj);
      expect(next(proj, SINGLE).plan_approval?.status).toBe("approved");
      return proj;
    } },
  ];
  for (const state of ISOLATED) {
    test(`${state.name}: ${state.waits ? "the plan step, nothing recorded" : "the run closes"}`, () => {
      const proj = state.build();
      created.push(proj);
      expect(guardOn(proj, SINGLE_REPORT)).toBe(ADMITTED);
      const before = completions(proj);
      const ran = runNamed(proj, SINGLE_REPORT);
      const step = JSON.parse(ran.stdout || "{}") as Step;
      if (state.waits) {
        expect(step.message, ran.stdout).toBe(SINGLE_WAITS);
        expect(completions(proj)).toBe(before);
      } else {
        expect(step.kind, ran.stdout).toBe("done");
        expect(completions(proj)).toBe(before + 1);
      }
    });
  }

  test("the workflow at another stage: the early report's step brings back the isolated run's plan question", () => {
    const proj = createCodeGenerationProject();
    created.push(proj);
    const stateFile = seededStateFile(proj);
    writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: requirements-analysis"), "utf-8");
    next(proj, SINGLE);
    writePlan(proj);
    expect(next(proj, SINGLE).ask_type).toBe("plan-approval");
    const state = readFileSync(stateFile, "utf-8");
    const before = completions(proj);
    const ran = runNamed(proj, SINGLE_REPORT);
    const step = JSON.parse(ran.stdout || "{}") as Step;
    expect(step.message, ran.stdout).toBe(SINGLE_WAITS);
    const named = namedCommands(step.message ?? "");
    expect(named).toHaveLength(1);
    const followed = runNamed(proj, named[0]);
    expect(JSON.parse(followed.stdout || "{}") as Step, followed.stdout).toMatchObject({
      kind: "ask", ask_type: "plan-approval", stage: "code-generation",
    });
    expect(completions(proj)).toBe(before);
    expect(readFileSync(stateFile, "utf-8")).toBe(state);
  });

  test("no workflow and a scope typed for the run: the early report's step keeps that scope", () => {
    const proj = createCodeGenerationProject();
    created.push(proj);
    unlinkSync(seededStateFile(proj));
    const scoped = [...SINGLE, "--scope", "bugfix"];
    next(proj, scoped);
    writePlan(proj);
    next(proj, scoped);
    const rows = auditEvents(proj).length;
    const ran = runNamed(proj, SINGLE_REPORT);
    const step = JSON.parse(ran.stdout || "{}") as Step;
    expect(step.message, ran.stdout).toBe(singleWaits("bugfix"));
    const followed = runNamed(proj, namedCommands(step.message ?? "")[0]);
    const after = JSON.parse(followed.stdout || "{}") as Step;
    expect(after.kind, followed.stdout).not.toBe("error");
    expect(after.stage, followed.stdout).toBe("code-generation");
    expect(auditEvents(proj)).toHaveLength(rows);
  });
});

