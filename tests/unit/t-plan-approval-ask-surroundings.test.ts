// covers: function:routeCodeGenerationPlanApproval, function:publishPlanApprovalAsk,
// function:notePlanApprovalAskReply, function:recordPlanApprovalAnswer, function:requestPlanApprovalReviewNow,
// function:codeGenerationPlanReadiness, function:planSummaryLines, function:PLAN_APPROVAL_ASK_TYPE,
// function:planApprovalRuntimeFile, function:readPlanApprovalRuntimeRecord, function:writePlanApprovalRuntimeRecord,
// function:removePlanApprovalRuntimeRecord, function:runStateContent, function:keepPlanApprovalAskOverStateWrite,
// function:planNote, function:planRecordFolders, function:parkedWhereItStands
//
// The engine asks for Plan Approval itself. These cases drive the real `next`,
// the real human-turn hook, and the real plan-approval guard over one poc
// workflow at Code Generation, and check what the person sees and what is
// recorded:
//
//   - in work with several repositories, one line under the summary names the
//     repositories the plan names files in, and leaves the fingerprint, the
//     approval and a file asked before it (with an answer written there) as
//     they are; nothing in one-repository work;
//   - stopping for now: the park and the unpark the engine names get through
//     the guard, and coming back builds an approved plan or asks about the
//     same plan again; while the work is parked, the person's other work in
//     the project goes on and the files the plan names and its developer wait.
//   - the zero-Unit lockout reported in #1172 (refactor and bugfix, Brownfield,
//     rules in parts): one approval reaches the build, each refusal while a
//     part is the step names that part's `continue`, the stage-level handoff
//     and source edits go through, parking and coming back reach the build
//     with no new question, and a rules part left behind by a state that moved
//     back holds nothing.
//   - the step that writes a plan (stage-level, a Unit's, a parallel batch's)
//     makes each plan's record folder first, so a file tool that makes no
//     folders writes the plan; a route check makes nothing.
//   - the plan's Testing Contract is the engine's to write: `next` writes a
//     block left out, broken or out of date into that section only, before the
//     question and after it, and after an approval, under every Guard Policy,
//     over what an agent wrote in that section instead; never under the
//     person's edit, over a plan sent back, over a heading or plan step, into a
//     plan that is not UTF-8 text, or from the Stop hook's read-only probe.
//   - after a git pull, the files a teammate's commit brought are not named as
//     already changed, nor a checkout's files as its own remote branch holds them;
//     after a submodule update, nor a submodule's files as the commit that branch
//     records for it holds them, while the build's own change inside it still is.
//
// These cases and those in t-plan-approval-ask.test.ts share their helpers
// (tests/harness/plan-approval-ask.ts); they are two files so that each runs well
// within CI's per-file time limit.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { withCopyLaunchOptions } from "../harness/copy-launch.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  cleanupWorktreeFixture,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  intentsDirOf,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  planSummaryLines,
  publishPlanApprovalAsk,
  publishPlanApprovalSkip,
  routeCodeGenerationPlanApproval,
} from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import {
  keepPlanApprovalAskOverStateWrite,
  planApprovalAskIsOpen,
  planApprovalRuntimeFile,
  readActiveDirectiveMarker,
  findStageBySlug,
  artifactFilename,
  auditBlockField,
  readAuditShardEvents,
  reviewArtifactFingerprint,
  unitCompletedReceipts,
  stateDigest,
  workspaceSourceFingerprint,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
  hooksHealthDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  COPY_TOOLS_PATTERN,
  BUN,
  ORCHESTRATE,
  DISPATCHER,
  GUARD,
  STATE,
  SESSION,
  OTHER_SESSION,
  type Emitted,
  created,
  worktreeFixtures,
  project,
  stageDir,
  writePlan,
  next,
  reply,
  turnId,
  answer,
  replyAndRecord,
  lower,
  guardWrite,
  guardBash,
  runInstalled,
  resumeNamesUnpark,
  auditText,
  questions,
  askFor,
  withRulesInParts,
  unitProject,
  engineCall,
  nextThroughParts,
  posture,
  guardDispatch,
  generationStarted,
  interrupt,
  GROUP,
  swarmFixture,
  groupedProject,
  swarmState,
} from "../harness/plan-approval-ask.ts";

setDefaultTimeout(120_000);

afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  while (worktreeFixtures.length > 0) cleanupWorktreeFixture(worktreeFixtures.pop()!);
});

// Plan approval off built the plan without asking (the skip is on record) and
// then plan approval was turned on, by the person or by the agent reading
// "show me the code plan before you build it". Until that plan's build starts,
// nobody approved it: `next` asks the engine's own plan question, the answer
// records as any answer does, and the build waits for it. Once the build has
// started, or with plan approval off again, the skip stands.
describe("plan approval turned on after a plan was built without asking", () => {
  const PLAN_PATH = /construction\/code-generation\/code-generation-plan\.md$/;
  const CHANGE = "print one decimal place, and add a test for that.";
  const count = (proj: string, event: string): number => auditText(proj).split(`**Event**: ${event}\n`).length - 1;
  const setLines = (proj: string, edit: (state: string) => string): void => {
    const path = seededStateFile(proj);
    writeFileSync(path, edit(readFileSync(path, "utf-8")), "utf-8");
  };
  const express = (proj: string): void => setLines(proj, (state) => state
    .replace("- **Scope**: poc", "- **Scope**: express")
    .replace(/^- \*\*Guard Policy\*\*:.*$/m, "- **Guard Policy**: off (from scope express)")
    .replace(/^- \*\*Plan Approval\*\*:.*$/m, "- **Plan Approval**: off (from scope express)"));
  // A plan written, and `next` hands its build over without asking.
  const builtWithoutAsking = (proj: string, unit: string | null = null): void => {
    writePlan(proj, "", unit);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval.skipped, JSON.stringify(build)).toBe(true);
  };
  // The agent's setter, as the run had it: no message of the person's named.
  const turnOn = (proj: string): string => {
    const on = lower(proj, "plan-approval", "on");
    expect(on.code, on.out).toBe(0);
    expect(on.out).toContain("Each code plan is now shown for approval before it is built.");
    return on.out;
  };
  // The person's own words turning it off, the setter naming their message.
  const theyTurnOff = (proj: string, words: string): { code: number; out: string } => {
    reply(proj, words);
    const result = spawnSync(BUN, [
      DISPATCHER, "engine", "config", "set", "plan-approval", "off", "--message", turnId(proj), "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  // What the guard says at a code write, on stdout and stderr together.
  const guardSays = (proj: string, path: string): { code: number; out: string } => {
    const result = spawnSync(BUN, [GUARD], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj,
        tool_name: "Write", tool_input: { file_path: path, content: "x\n" },
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  const reviseThePlan = (proj: string, unit: string | null = null): void => {
    const plan = join(stageDir(proj, unit), "code-generation-plan.md");
    writeFileSync(plan, readFileSync(plan, "utf-8").replace("- [ ] Step 1: write slugify\n",
      "- [ ] Step 1: write slugify\n- [ ] Step 2: print one decimal place\n"), "utf-8");
  };

  const SETUPS: Array<[string, (proj: string) => void]> = [
    ["poc, Guard Policy relaxed", () => {}],
    ["express, Guard Policy off", express],
    ["Guard Policy strict and plan approval off, both set by the person", (proj) => setLines(proj, (state) => state
      .replace(/^- \*\*Guard Policy\*\*:.*$/m, "- **Guard Policy**: strict (set by you)")
      .replace(/^- \*\*Plan Approval\*\*:.*$/m, "- **Plan Approval**: off (set by you)"))],
  ];
  for (const [name, setup] of SETUPS) {
    test(`${name}: next asks the plan question once, and nothing is built while it waits`, () => {
      const proj = project("relaxed", "off");
      setup(proj);
      builtWithoutAsking(proj);
      turnOn(proj);
      const asked = next(proj);
      expect(asked, JSON.stringify(asked)).toMatchObject({ kind: "ask", ask_type: "plan-approval", question: "Approve the code plan?" });
      expect(asked.plan_approval.choices).toEqual(["Approve Plan", "Request Changes", "I'll edit the files"]);
      expect(asked.plan_approval.targets?.[0].summary).toContain("Builds: slugify for titles");
      expect(asked.plan_approval.targets?.[0].plan_path).toMatch(PLAN_PATH);
      expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
      // A file the plan does not name goes in while it waits, as with plan approval on from the start.
      expect(guardWrite(proj, join(proj, "src", "other.ts")).code).toBe(0);
      expect(posture(proj, "brief", null).status).not.toBe(0);
      expect(next(proj).ask_type).toBe("plan-approval");
      expect(count(proj, "QUESTION_ASKED")).toBe(1);
    });
  }

  // The window between the switch and the next `next`: the agent still holds
  // the build step `next` gave before the switch. The guard judges by the
  // setting too, so the build does not start under the skip; `next` asks.
  for (const [name, setup] of [["poc, Guard Policy relaxed", () => {}], ["express, Guard Policy off", express]] as const) {
    test(`${name}: switched on, no next yet: the developer and a code write wait, and next asks once`, () => {
      const proj = project("relaxed", "off");
      setup(proj);
      builtWithoutAsking(proj);
      turnOn(proj);
      const brief = posture(proj, "brief", null);
      expect(brief.status, brief.stderr).toBe(0);
      const dispatched = guardDispatch(proj, brief.stdout);
      expect(dispatched.code, dispatched.stderr).toBe(2);
      expect(dispatched.stderr).toContain("run next");
      expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
      expect(generationStarted(proj)).toBe(false);
      expect(next(proj).ask_type).toBe("plan-approval");
      expect(count(proj, "QUESTION_ASKED")).toBe(1);
    });
  }

  // Left open on purpose: `testing-posture begin` is a tool the agent runs, which
  // usually loads no router and so reads no setting, and no step tells an agent
  // to run it. Run in the window, it starts the build under the skip, and the
  // switch applies from the next plan.
  test("switched on, no next yet, testing-posture begin run anyway: the build starts, and nothing is asked", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    // A process that loads the reader alone (the setting never handed in) reads
    // the plan as main does: approved, built without asking.
    const verified = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), "verify", "--stage-level", "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, skipped: true, execution_allowed: true });
    const begun = posture(proj, "begin", null);
    expect(begun.status, begun.stderr).toBe(0);
    expect(generationStarted(proj)).toBe(true);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // Each answer leads on to its own step, and `next` again never brings the
  // same question back for the same plan.
  test("Approve Plan: their words are on the record, and the build follows", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    replyAndRecord(proj, "looks good, go ahead", "Approve Plan");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(auditText(proj)).toContain("**Person Reply**: looks good, go ahead");
    expect(count(proj, "PLAN_APPROVAL_RECORDED")).toBe(1);
    expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(count(proj, "QUESTION_ASKED")).toBe(1);
  });

  test("Request Changes in their words: the revise step carries them, and the revised plan is asked about once", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, `Request changes: ${CHANGE}`);
    expect(answer(proj, `Request Changes: ${CHANGE}`).message).toContain('Recorded "Request Changes"');
    const recorded = auditText(proj).split("\n---\n").find((block) => block.includes("**Details**: Request Changes"));
    expect(recorded).toContain(`**User Input**: ${CHANGE}`);
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: CHANGE });
    // Nothing is approved while it is revised: the build waits, and a document goes in, as with plan approval on.
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(guardWrite(proj, join(proj, "NOTES.md")).code).toBe(0);
    reviseThePlan(proj);
    const again = next(proj);
    expect(again.ask_type, JSON.stringify(again)).toBe("plan-approval");
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(count(proj, "QUESTION_ASKED")).toBe(2);
    replyAndRecord(proj, "yes", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("I'll edit the files: the editing question, then their done builds the plan as they left it", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    expect(next(proj).plan_approval.editing).toBe(true);
    reviseThePlan(proj);
    replyAndRecord(proj, "done", "Approve Plan");
    const build = next(proj);
    expect(build.plan_approval, JSON.stringify(build)).toEqual({ status: "approved" });
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("turned on before the plan is written: the plan is asked about, and nothing records it as built", () => {
    const proj = project("relaxed", "off");
    turnOn(proj);
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(count(proj, "PLAN_APPROVAL_SKIPPED")).toBe(0);
  });

  test("off throughout: one record that it was built without asking, and next stays the build", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(count(proj, "PLAN_APPROVAL_SKIPPED")).toBe(1);
  });

  test("turned off again before the question is shown: it is shown once with the one line, and their word then builds it", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    const early = theyTurnOff(proj, "never mind, skip plan approval for this work");
    expect(early.code, early.out).not.toBe(0);
    expect(early.out).toContain("Turning plan approval off needs your word after the plan is shown");
    expect(next(proj).ask_type).toBe("plan-approval");
    const off = theyTurnOff(proj, "skip plan approval for this work");
    expect(off.code, off.out).toBe(0);
    const build = next(proj);
    expect(build.plan_approval.skipped, JSON.stringify(build)).toBe(true);
  });

  test("turned off again once the question is shown: the plan builds as plan approval off builds it, said and recorded as such", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    const off = theyTurnOff(proj, "actually, skip plan approval for this work");
    expect(off.code, off.out).toBe(0);
    expect(off.out).toContain("Each code plan is now built without asking you first.");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval.skipped).toBe(true);
    expect(build.plan_approval.notice).toContain("is off for this piece of work (set by you). Starting code generation now.");
    expect(count(proj, "PLAN_APPROVAL_SKIPPED")).toBe(2);
    expect(questions(proj)).toMatch(/^\[Answer\]: Plan approval off$/m);
    const write = guardSays(proj, join(proj, "src", "slugify.ts"));
    expect(write.code, write.out).toBe(0);
    expect(write.out).not.toContain("Continuing past");
  });

  test("Request Changes, then turned off: their change is made first, and the revised plan builds without asking", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    replyAndRecord(proj, `Request changes: ${CHANGE}`, `Request Changes: ${CHANGE}`);
    const off = theyTurnOff(proj, "and skip plan approval from now on");
    expect(off.code, off.out).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: CHANGE });
    reviseThePlan(proj);
    const build = next(proj);
    expect(build.plan_approval.skipped, JSON.stringify(build)).toBe(true);
    expect(count(proj, "PLAN_APPROVAL_SKIPPED")).toBe(2);
  });

  // The rule reads only the engine's own record of a plan built without
  // asking: an approval the person gave is theirs whatever happens after it.
  test("an approval they gave is never asked again: off and on, a second chat, a compacted chat", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    turnOn(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    replyAndRecord(proj, "approve", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(theyTurnOff(proj, "skip plan approval for this work").code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    turnOn(proj);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    const second = runOrchestrateNext(ORCHESTRATE, proj, [], {
      env: { ...process.env, AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: OTHER_SESSION },
    });
    expect(second.status, second.out).toBe(0);
    expect((second.directive as unknown as Emitted).plan_approval).toEqual({ status: "approved" });
    interrupt(proj, "the chat compacts");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(count(proj, "QUESTION_ASKED")).toBe(1);
    expect(count(proj, "PLAN_APPROVAL_RECORDED")).toBe(1);
  });

  test("turned on once the build has started: the build goes on, nothing is asked, and its pick-up stays the build", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
    expect(generationStarted(proj)).toBe(true);
    expect(turnOn(proj).trim().split("\n")).toEqual([
      "Plan Approval changed: off (from scope poc) to on (set by a command)",
      "Each code plan is now shown for approval before it is built.",
    ]);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(guardWrite(proj, join(proj, "src", "slugify-more.ts")).code).toBe(0);
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(plan, readFileSync(plan, "utf-8").replace("- [ ] Step 1", "- [x] Step 1"), "utf-8");
    interrupt(proj, "the chat compacts");
    const resumed = next(proj);
    expect(resumed.kind, JSON.stringify(resumed)).toBe("run-stage");
    expect(resumed.plan_approval.status).toBe("approved");
    expect(count(proj, "QUESTION_ASKED")).toBe(0);
  });

  test("a team's strict Guard Policy arriving in memory after the skip: the plan is asked about", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    const memory = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
    const content = readFileSync(memory, "utf-8");
    writeFileSync(memory, content.includes("## Guard Policy\n")
      ? content.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${content.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
    const asked = next(proj);
    expect(asked, JSON.stringify(asked)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  // "Review the plan" with plan approval still off: the question is the open
  // step, so nothing starts that build until the person answers it.
  test("'review the plan' for a plan built without asking: its build waits for the answer", () => {
    const proj = project("relaxed", "off");
    builtWithoutAsking(proj);
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(posture(proj, "begin", null).status).not.toBe(0);
    replyAndRecord(proj, "ok, build it", "Approve Plan");
    const begun = posture(proj, "begin", null);
    expect(begun.status, begun.stderr).toBe(0);
  });

  test("several Units: the one whose build started goes on, and the next one is asked about", () => {
    const proj = unitProject("unit-b", "unit-a");
    setLines(proj, (state) => state.replace("- **Guard Policy**: relaxed (set by you)",
      "- **Guard Policy**: relaxed (set by you)\n- **Plan Approval**: off (set by you)"));
    writePlan(proj, "", "unit-a");
    builtWithoutAsking(proj, "unit-b");
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
    // unit-a's turn: its build is handed over without asking too.
    writeActiveDirectiveMarker(proj, {
      kind: "run-stage", stage: "code-generation", unit: "unit-a",
      state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")),
    });
    const route = (unit: string): Emitted => routeCodeGenerationPlanApproval(proj, {
      kind: "run-stage", stage: "code-generation", unit,
    } as Parameters<typeof routeCodeGenerationPlanApproval>[1]) as unknown as Emitted;
    const handed = route("unit-a");
    expect(handed.plan_approval.skipped, JSON.stringify(handed)).toBe(true);
    expect(publishPlanApprovalSkip(proj, handed as unknown as Parameters<typeof publishPlanApprovalSkip>[1])).toBe(true);
    turnOn(proj);
    expect(route("unit-a")).toMatchObject({ kind: "ask", ask_type: "plan-approval", unit: "unit-a" });
    expect(route("unit-b").plan_approval).toEqual({ status: "approved" });
  });

  test("a parallel batch not started yet: one question for both Units, and approving all lets each build", () => {
    const pd = swarmFixture(true, GROUP, "off");
    const directive = { kind: "invoke-swarm", stage: "code-generation", units: GROUP } as const;
    const handed = swarmState(pd);
    expect(handed.plan_approval.skipped, JSON.stringify(handed)).toBe(true);
    expect(publishPlanApprovalSkip(pd, directive as unknown as Parameters<typeof publishPlanApprovalSkip>[1])).toBe(true);
    setLines(pd, (state) => state.replace("- **Plan Approval**: off (set by you)", "- **Plan Approval**: on (set by you)"));
    const routed = swarmState(pd);
    expect(routed, JSON.stringify(routed)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(routed.plan_approval.choices).toEqual(["Approve all", "Request Changes", "I'll edit the files"]);
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(false);
    writeActiveDirectiveMarker(pd, {
      kind: "ask", stage: "code-generation", ask_type: "plan-approval", units: GROUP,
      state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
    });
    publishPlanApprovalAsk(pd, routed as unknown as Parameters<typeof publishPlanApprovalAsk>[1]);
    replyAndRecord(pd, "approve all", "Approve all");
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(true);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
  });

  test("an isolated Code Generation run: its own next asks, and names itself", () => {
    const NEXT = withCopyLaunchOptions("bun .claude/tools/aidlc-orchestrate.ts next");
    const OWN = `${NEXT} --stage code-generation --single --scope poc`;
    const proj = project("relaxed", "off");
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    setLines(proj, (state) => state.replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: requirements-analysis"));
    reply(proj, "/aidlc --stage code-generation --single");
    next(proj, ["--stage", "code-generation", "--single"]);
    writePlan(proj);
    const own = (): Emitted => next(proj, OWN.split(" ").slice(NEXT.split(" ").length));
    const build = own();
    expect(build.plan_approval.skipped, JSON.stringify(build)).toBe(true);
    turnOn(proj);
    const asked = own();
    expect(asked, JSON.stringify(asked)).toMatchObject({ kind: "ask", ask_type: "plan-approval", plan_approval: { next: OWN } });
  });
});

describe("the question's summary", () => {
  test("uses the plan's Summary section, or counts plan steps without one", () => {
    expect(planSummaryLines("# P\n\n## Summary\n\n- Builds: x\n- Tests: 2\n\n## Steps\n- [ ] a\n", "t"))
      .toEqual(["Builds: x", "Tests: 2"]);
    // Only what renders reaches the question.
    expect(planSummaryLines("# P\n\n## Summary\n\n<!-- run this first -->\n- Builds: x\n```\n- Touches: hidden\n```\n", "t"))
      .toEqual(["Builds: x"]);
    expect(planSummaryLines("# P\n\n- [ ] a\n- [x] b\n", "run it"))
      .toEqual(["2 plan steps", "Tests: see unit-test-instructions.md"]);
  });
});

// In work with several repositories the question says which of them the plan
// names files in, in one line the tool writes from the plan's own paths: a
// summary line is cut at 200 characters, and a repository named after the cut
// would not be on screen. In work with one repository nothing is added.
describe("in work with several repositories the question names the plan's repositories", () => {
  const CUT_TOUCHES = "api/src/routes/orders.ts, api/src/routes/payments.ts, api/src/services/orders-service.ts, " +
    "api/src/services/payments-service.ts, api/src/models/order.ts, api/src/models/payment.ts, " +
    "api/src/db/migrations.ts, web/src/pages/Checkout.tsx";

  function reposProject(repos: string[]): string {
    const proj = project();
    const registry = join(intentsDirOf(proj), "intents.json");
    const rows = JSON.parse(readFileSync(registry, "utf-8"));
    rows[0].repos = repos;
    writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
    for (const repo of repos) {
      mkdirSync(join(proj, repo, "src"), { recursive: true });
      writeFileSync(join(proj, repo, "src", "base.ts"), "export const base = true;\n");
    }
    return proj;
  }

  function askedWith(proj: string, touches: string): Emitted {
    writePlan(proj, "", null, touches);
    const directive = next(proj);
    expect(directive.ask_type, JSON.stringify(directive)).toBe("plan-approval");
    return directive;
  }

  function fingerprint(proj: string): string | null {
    return /^\[Approval Fingerprint\]: (\S+)$/m.exec(questions(proj))?.[1] ?? null;
  }

  test("two repositories: the line is under the cut summary, whole, in the question, its prose and its record", () => {
    const proj = reposProject(["api", "web"]);
    const asked = askedWith(proj, CUT_TOUCHES);
    const cut = `Touches: ${CUT_TOUCHES}`.slice(0, 197) + "...";
    expect(cut).not.toContain("web/");
    expect(asked.plan_approval.targets?.[0].summary).toEqual([
      "Builds: slugify for titles", cut, "Tests: 3 unit tests", "Names files in api and web.",
    ]);
    const prose = (asked as unknown as Record<string, unknown>).numbered_prose_question as string;
    expect(prose).toContain(`- ${cut}\n- Tests: 3 unit tests\n- Names files in api and web.\n`);
    expect(questions(proj)).toContain(`- ${cut}\n- Tests: 3 unit tests\n- Names files in api and web.\n\nFull plan: `);
  });

  test("each form of the line, and nothing where the plan names no file in a repository", () => {
    const line = (repos: string[], touches: string) =>
      askedWith(reposProject(repos), touches).plan_approval.targets?.[0].summary.slice(3);
    expect(line(["api", "web", "worker"], "api/src/a.ts, web/src/b.tsx, worker/src/c.ts"))
      .toEqual(["Names files in api, web and worker."]);
    expect(line(["api", "web"], "api/src/a.ts, api/src/b.ts")).toEqual(["Names files in api."]);
    expect(line(["api", "web"], "api\\src\\a.ts, web\\src\\b.tsx")).toEqual(["Names files in api and web."]);
    expect(line(["api", "web"], "api/src/a.ts, deploy/compose.yaml, package.json")).toEqual(["Names files in api."]);
    expect(line(["api", "web"], "deploy/compose.yaml, package.json")).toEqual([]);
  });

  test("one repository: the question and its record are as they always were", () => {
    for (const repos of [["api"], []]) {
      const proj = repos.length > 0 ? reposProject(repos) : project();
      const asked = askedWith(proj, "api/src/a.ts, api/src/b.ts");
      expect(asked.plan_approval.targets?.[0].summary).toEqual([
        "Builds: slugify for titles", "Touches: api/src/a.ts, api/src/b.ts", "Tests: 3 unit tests",
      ]);
      expect(questions(proj)).toContain("- Tests: 3 unit tests\n\nFull plan: ");
    }
  });

  // The approval is of the plan, by its fingerprint, never of the question's
  // lines: the same plan asked with and without the line has one fingerprint,
  // and approving it records that fingerprint and builds.
  test("the plan's fingerprint and its approval do not depend on the line", () => {
    const one = reposProject(["api"]);
    askedWith(one, CUT_TOUCHES);
    const two = reposProject(["api", "web"]);
    askedWith(two, CUT_TOUCHES);
    expect(questions(two)).toContain("- Names files in api and web.");
    expect(fingerprint(two)).not.toBeNull();
    expect(fingerprint(two)).toBe(fingerprint(one));
    replyAndRecord(two, "approve", "Approve Plan");
    const recorded = readAuditShardEvents(two).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");
    expect(recorded).toHaveLength(1);
    expect(auditBlockField(recorded[0].block, "Approval Fingerprint")).toBe(fingerprint(one));
    expect(next(two).kind).toBe("run-stage");
  });

  // A questions file written without the line (by an earlier AI-DLC, for the
  // same question) is not rewritten for the line alone: an answer the person
  // wrote there stays whole, nothing asks them again, and it is read as theirs.
  test("a question asked before the line keeps its file and the answer written in it", () => {
    const proj = reposProject(["api", "web"]);
    askedWith(proj, CUT_TOUCHES);
    const path = join(stageDir(proj), "code-generation-questions.md");
    const earlier = questions(proj).replace("- Names files in api and web.\n", "");
    expect(earlier).not.toContain("Names files in");
    writeFileSync(path, earlier);
    expect(next(proj).plan_approval.targets?.[0].summary.at(-1)).toBe("Names files in api and web.");
    expect(questions(proj)).toBe(earlier);
    const written = earlier.replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan, the payments part looks right");
    writeFileSync(path, written);
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(questions(proj)).toBe(written);
    const events = (name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);
    expect(events("QUESTION_ASKED")).toHaveLength(1);
    expect(events("QUESTION_SHOWN")).toHaveLength(0);
    replyAndRecord(proj, "done, my answer is in the questions file", "Approve Plan");
    expect(events("PLAN_APPROVAL_RECORDED")).toHaveLength(1);
    expect(auditBlockField(events("PLAN_APPROVAL_RECORDED")[0].block, "Answer Line In File"))
      .toBe("Approve Plan, the payments part looks right");
    expect(next(proj).kind).toBe("run-stage");
  });

  // A teammate's clone keeps no record of the question: the file the earlier
  // AI-DLC wrote and committed stays as it was there too.
  test("in a clone with no record of the question, the file asked before the line stays as it was", () => {
    const proj = reposProject(["api", "web"]);
    askedWith(proj, CUT_TOUCHES);
    const path = join(stageDir(proj), "code-generation-questions.md");
    const earlier = questions(proj).replace("- Names files in api and web.\n", "");
    writeFileSync(path, earlier);
    const records = dirname(planApprovalRuntimeFile(proj, "probe"));
    for (const name of readdirSync(records).filter((entry) => entry.startsWith("ask-"))) rmSync(join(records, name));
    expect(next(proj).plan_approval.targets?.[0].summary.at(-1)).toBe("Names files in api and web.");
    expect(questions(proj)).toBe(earlier);
  });
});

// While a plan waits, what the person asks for runs the first time: every
// command the engine itself names for their request gets through the guard,
// and code still waits for the approved plan.
describe("what the engine names while a plan waits", () => {
  function namedCommands(directive: unknown): string[] {
    const out = new Set<string>();
    const visit = (value: unknown, key = ""): void => {
      if (typeof value === "string") {
        if (/(^|_)command$/.test(key) && /^(bun|aidlc)\b/.test(value)) out.add(value);
        for (const m of value.matchAll(/`((?:bun|aidlc) [^`]*)`/g)) out.add(m[1]);
      } else if (Array.isArray(value)) {
        for (const entry of value) visit(entry, key);
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) visit(v, k);
      }
    };
    visit(directive);
    return [...out];
  }
  // The protocol's own placeholders, filled the way the agent fills them here.
  function filled(command: string): string {
    return command
      .replaceAll("<slug>", "code-generation")
      .replaceAll('"<directive.stage>"', "code-generation")
      .replaceAll("<first|revision|stale>", "first")
      .replace(/"<[^"]*>"/g, '"x"');
  }
  // The review brief and the stage's question rows, as the shipped protocol names them.
  function protocolCommands(): string[] {
    const dir = join(AIDLC_SRC, "aidlc-common", "protocols");
    const text = ["stage-protocol.md", "stage-protocol-reviewer.md"]
      .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
    // A checkpoint row keeps its own rule, so only the plain question rows.
    const named = new RegExp(`\`(${COPY_TOOLS_PATTERN}[^\`\\n]*(?:aidlc-review-brief\\.ts|engine log (?:decision|answer) --stage <slug>)[^\`\\n]*)\``, "g");
    const commands = [...text.matchAll(named)]
      .map((m) => filled(m[1]))
      .filter((command) => !command.includes("--checkpoint"));
    expect(commands.length, "the protocol names no review brief or log row").toBeGreaterThan(3);
    return [...new Set(commands)];
  }
  function waitingPlan(): string {
    const proj = project("strict");
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    return proj;
  }
  function resumeReport(proj: string, choice: string): unknown {
    const result = spawnSync(BUN, [ORCHESTRATE, "report", "--result", "resumed", "--choice", choice, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const line = (result.stdout ?? "").split("\n").filter((entry) => entry.startsWith("{")).pop();
    expect(line, `${result.stdout}${result.stderr}`).toBeDefined();
    return JSON.parse(line as string);
  }

  test.each([
    ["status", "/aidlc --status", ["--status"]],
    ["help", "/aidlc --help", ["--help"]],
    ["doctor", "/aidlc --doctor", ["--doctor"]],
    ["version", "/aidlc --version", ["--version"]],
    ["a jump back", "/aidlc --stage nfr-requirements", ["--stage", "nfr-requirements"]],
    ["a jump to Reverse Engineering", "/aidlc --stage reverse-engineering", ["--stage", "reverse-engineering"]],
    ["a redo of this stage", "/aidlc --stage code-generation", ["--stage", "code-generation"]],
    ["a skip", "/aidlc --skip build-and-test", ["--skip", "build-and-test"]],
    ["a scope change", "/aidlc --scope feature", ["--scope", "feature"]],
    ["a setting change", "/aidlc --depth minimal --review advisory", ["--depth", "minimal", "--review", "advisory"]],
    ["new work beside it", "/aidlc --new-intent add a csv export", ["--new-intent", "--scope", "poc", "add a csv export"]],
    ["a redo asked for on re-entry", "redo this stage from the start", null],
  ] as const)("%s: every command the engine names gets through", (_label, typed, args) => {
    const proj = waitingPlan();
    reply(proj, typed);
    const directive = args === null ? resumeReport(proj, "redo") : next(proj, [...args]);
    const commands = namedCommands(directive).map(filled);
    expect(commands.length, `no command named: ${JSON.stringify(directive)}`).toBeGreaterThan(0);
    for (const command of commands) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
    }
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  test("the review brief and the stage's question rows get through, and an added write does not", () => {
    const proj = waitingPlan();
    for (const command of protocolCommands()) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
      expect(guardBash(proj, `${command}; printf x > src/slugify.ts`).code, `${command} with a write`).toBe(2);
    }
  });

  test("a review the person asks for runs while the plan waits: its request is the engine's command, its files are records, the code waits", () => {
    const proj = waitingPlan();
    const request = withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine log review --stage code-generation --reviewer aidlc-architecture-reviewer-agent --iteration 2");
    // AI-DLC's own command: the log tool judges it, this guard does not.
    expect(guardBash(proj, request).code).toBe(0);
    reply(proj, "before I approve the plan, have the reviewer look at it again");
    expect(guardBash(proj, request).code, guardBash(proj, request).stderr).toBe(0);
    expect(guardBash(proj, `${request} --verdict READY`).code).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
    const reviewFile = ".aidlc-engine/reviews/code-generation/stage/a1/2.0123456789abcdef0123456789abcdef.review.md";
    const dispatch = join(record, ".aidlc-engine", "reviewer-dispatch.json");
    // The path as an agent types it in bash: from the project, with forward
    // slashes (bash reads a Windows backslash as an escape).
    const dispatchInShell = dispatch.slice(proj.length + 1).replace(/\\/g, "/");
    // The reviewer's own records pass, request or no request.
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(0);
    expect(guardWrite(proj, dispatch).code).toBe(0);
    appendAuditEntry("REVIEW_REQUESTED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "2",
      "Request Id": "review:0123456789abcdef0123456789abcdef", "Review File": reviewFile,
    }, proj);
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(0);
    expect(guardWrite(proj, dispatch).code).toBe(0);
    expect(guardBash(proj, `rm ${dispatchInShell}`).code).toBe(0);
    // Other records pass too; the code the plan names still waits.
    expect(guardWrite(proj, join(record, ".aidlc-engine", "reviews", "code-generation", "stage", "a1", "3.other.review.md")).code).toBe(0);
    expect(guardWrite(proj, join(record, "construction", "code-generation", "code-summary.md")).code).toBe(0);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(guardBash(proj, `printf x > ${dispatchInShell}; printf x > src/slugify.ts`).code).toBe(2);
    // Once the review completes, its files are still the reviewer's records.
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "2", Verdict: "READY",
      "Request Id": "review:0123456789abcdef0123456789abcdef",
    }, proj);
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(0);
    expect(guardWrite(proj, dispatch).code).toBe(0);
    // Audit rows are project text: a Review File outside the reviews folder
    // never opens a write while the plan waits.
    appendAuditEntry("REVIEW_REQUESTED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "3",
      "Request Id": "review:fedcba9876543210fedcba9876543210", "Review File": "../../../../../src/slugify.ts",
    }, proj);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  test("a jump waits for the person to ask (the jump tool checks no one); a skip is the engine's own command; the code waits", () => {
    const proj = waitingPlan();
    const jump = withCopyLaunchOptions("bun .claude/tools/aidlc-jump.ts execute --target nfr-requirements --direction backward --scope poc");
    expect(guardBash(proj, jump).code).toBe(2);
    expect(guardBash(proj, withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine recompose --skip build-and-test")).code).toBe(0);
    reply(proj, "/aidlc --stage nfr-requirements");
    expect(namedCommands(next(proj, ["--stage", "nfr-requirements"]))).toContain(jump);
    const verdict = guardBash(proj, jump);
    expect(verdict.code, verdict.stderr).toBe(0);
    expect(guardBash(proj, withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine recompose --skip build-and-test --scope feature")).code).toBe(0);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  // From a live run: a skip typed while the plan waited left the plan
  // question behind, so the approval that followed was not kept against it
  // and the record carried the person's earlier question as their words.
  test("after a skip typed while the plan waits, the person's answer is kept with their words", () => {
    const proj = waitingPlan();
    // The skip reads the plan's scope from the installed tree.
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    reply(proj, "/aidlc --skip feedback-optimization");
    const named = next(proj, ["--skip", "feedback-optimization"]);
    const recompose = namedCommands(named).find((command) => command.includes("engine recompose"));
    expect(recompose, JSON.stringify(named)).toBeDefined();
    const verdict = guardBash(proj, recompose as string);
    expect(verdict.code, `${recompose}\n${verdict.stderr}`).toBe(0);
    runInstalled(proj, recompose as string);
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    reply(proj, "approve the plan, but let's stop there for today");
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.code, said.message).toBe(0);
    expect(auditText(proj)).toContain("**Person Reply**: approve the plan, but let's stop there for today");
  });

  // From a live Codex run: "approve the plan. and skip build and test" at the
  // plan question. The skip's step ended the turn, so the approval in the same
  // message was dropped and nothing was built until the person asked.
  test("approve and skip in one reply while the plan waits: the skip is made, then the approval, and the build starts", () => {
    const proj = waitingPlan();
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    const words = "approve the plan. and skip build and test, I will run npm test myself";
    reply(proj, words);
    const named = next(proj, ["--skip", "build-and-test"]);
    expect(named.message, JSON.stringify(named)).toContain("answer --stage code-generation --checkpoint plan-approval");
    expect(named.message).not.toContain("Then stop.");
    const recompose = namedCommands(named).find((command) => command.includes("engine recompose"));
    expect(recompose, JSON.stringify(named)).toBeDefined();
    expect(guardBash(proj, recompose as string).code).toBe(0);
    runInstalled(proj, recompose as string);
    const said = answer(proj, "Approve Plan");
    expect(said.code, said.message).toBe(0);
    expect(auditText(proj)).toContain(`**Person Reply**: ${words}`);
    expect(next(proj)).toMatchObject({ kind: "run-stage", stage: "code-generation", plan_approval: { status: "approved" } });
  });

  // Skipping Code Generation itself while its plan waits: the skip the engine
  // names gets through and runs, the plan question goes with the stage, and the
  // work goes on to Build and Test without asking about the plan again.
  test("a skip of Code Generation while its plan waits is carried out, and the plan is not asked about again", () => {
    const proj = project("strict");
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace("- [ ] code-generation", "- [-] code-generation"), "utf-8");
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    askFor(proj);
    reply(proj, "/aidlc --skip code-generation");
    const named = next(proj, ["--skip", "code-generation"]);
    const commands = namedCommands(named);
    expect(commands.some((command) => command.includes("engine recompose")), JSON.stringify(named)).toBe(false);
    const skip = commands.find((command) => command.includes("report --stage code-generation --result skipped"));
    expect(skip, JSON.stringify(named)).toBeDefined();
    const verdict = guardBash(proj, skip as string);
    expect(verdict.code, `${skip}\n${verdict.stderr}`).toBe(0);
    const reason = /--reason '([^']*)'/.exec(skip as string)?.[1];
    const skipped = spawnSync(BUN, [
      join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), "report", "--stage", "code-generation",
      "--result", "skipped", "--reason", String(reason), "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(skipped.status, `${skipped.stdout}${skipped.stderr}`).toBe(0);
    expect(readFileSync(file, "utf-8")).toContain("- [S] code-generation");
    expect(planApprovalAskIsOpen(proj)).toBe(false);
    for (let turn = 0; turn < 2; turn++) {
      const after = next(proj);
      expect(after.kind, JSON.stringify(after)).toBe("run-stage");
      expect(after.stage).toBe("build-and-test");
    }
  });

  // A scope or setting change asked for while the plan waits, alone or with a
  // skip: each step the engine names runs, and the plan question is still the
  // open step, answered with the person's words. A new scope tests the plan
  // its own way, so its answer names the plan's Testing Contract to render
  // again first.
  test.each([
    ["a scope change", "/aidlc --scope feature", ["--scope", "feature"], false],
    ["a depth change", "/aidlc --depth minimal", ["--depth", "minimal"], true],
    ["a review change", "/aidlc --review advisory", ["--review", "advisory"], true],
    [
      "a setting change with a skip",
      "/aidlc --depth minimal --skip feedback-optimization",
      ["--depth", "minimal", "--skip", "feedback-optimization"],
      true,
    ],
  ] as const)("%s while the plan waits runs, and the plan question stays open", (_label, typed, args, planCurrent) => {
    const proj = waitingPlan();
    // The setters read the plan's scope from the installed tree.
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    reply(proj, typed);
    const named = next(proj, [...args]);
    // A skip's step also names the plan question's answer, for a reply that
    // gave one; this reply gave none, so the agent does not run it.
    const answerStep = namedCommands(named).filter((command) => command.includes("--checkpoint plan-approval"));
    expect(answerStep.length, JSON.stringify(named)).toBe((args as readonly string[]).includes("--skip") ? 1 : 0);
    const commands = namedCommands(named).filter((command) => !answerStep.includes(command));
    expect(commands.length, JSON.stringify(named)).toBeGreaterThan(0);
    for (const command of commands) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
      runInstalled(proj, command);
    }
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    reply(proj, "approve the plan, but let's stop there for today");
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.code, said.message).toBe(0);
    expect(said.recorded).toBe("approve");
    if (planCurrent) {
      expect(auditText(proj)).toContain("**Person Reply**: approve the plan, but let's stop there for today");
    } else {
      expect(said.message).toContain("Testing Contract");
    }
  });

  // "From here on, stop after each Unit" while the plan waits: the agent runs
  // the Construction setter, says its line and keeps the plan question open, so
  // the person's next "approve" is kept as their answer to that question.
  test.each([
    ["checkpoints on", "from here on, stop after each Unit so I can look", ["set-construction-checkpoints enabled"]],
    ["checkpoints off", "no need to stop after each Unit", ["set-construction-checkpoints disabled"]],
    ["one Unit at a time", "build them one at a time", ["set-construction-iteration unit-major"]],
    ["stage by stage", "do it stage by stage across the Units", ["set-construction-iteration stage-major"]],
    [
      "checkpoints on and serial execution",
      "stop after each Unit, and run them one after another",
      ["set-construction-checkpoints enabled", "set-construction-execution serial"],
    ],
  ] as const)("a Construction setting (%s) while the plan waits keeps the plan question open", (_label, typed, setters) => {
    const proj = waitingPlan();
    reply(proj, typed);
    for (const setter of setters) {
      const command = withCopyLaunchOptions(`bun .claude/tools/aidlc.ts engine state ${setter}`);
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
      runInstalled(proj, command);
    }
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    reply(proj, "approve");
    const said = answer(proj, "Approve Plan");
    expect(said.code, said.message).toBe(0);
    expect(said.recorded).toBe("approve");
  });

  // "Use bun test to check each Unit" while the plans wait: the person approves
  // the command in the agent's question box, the agent records and applies it,
  // and the plan question is still the open step, so their next "approve both
  // plans" is kept as their answer to it.
  test("a verification command approved while the plans wait keeps the plan question open", () => {
    const { pd } = groupedProject();
    const tool = (name: string, args: string[]): void => {
      const run = spawnSync(BUN, [join(AIDLC_SRC, "tools", name), ...args, "--project-dir", pd], {
        cwd: pd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: pd, AIDLC_PROJECT_DIR: pd, AIDLC_UNATTENDED: "0" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(run.status, `${name} ${args.join(" ")}\n${run.stdout}${run.stderr}`).toBe(0);
    };
    reply(pd, "before you build anything, use bun test as the verification command");
    const question = "Use this command to verify each completed Unit?";
    const route = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "bun test", "--session", SESSION];
    tool("aidlc-log.ts", ["decision", ...route, "--decision", question, "--options", "Approve,Request Changes"]);
    const asked = [{
      question, header: "Command", multiSelect: false,
      options: [{ label: "Approve", description: "" }, { label: "Request Changes", description: "" }],
    }];
    const picked = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
      cwd: pd,
      input: JSON.stringify({
        hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
        tool_input: { questions: asked },
        tool_response: { questions: asked, answers: { [question]: "Approve" } },
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: pd, AIDLC_PROJECT_DIR: pd, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(picked.status, picked.stderr).toBe(0);
    tool("aidlc-log.ts", ["answer", ...route, "--details", "Approve"]);
    tool("aidlc-state.ts", ["set-construction-verification-command", "bun test"]);
    expect(planApprovalAskIsOpen(pd)).toBe(true);
    reply(pd, "approve both plans");
    const said = answer(pd, "Approve all");
    expect(said.code, said.message).toBe(0);
    expect(said.recorded).toBe("approve");
  });

  test("a state change from anything but the skip still leaves the plan question out of date", () => {
    const proj = waitingPlan();
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    const file = seededStateFile(proj);
    const before = readFileSync(file, "utf-8");
    const after = before.replace("- **Depth**: Standard", "- **Depth**: Minimal");
    expect(after).not.toBe(before);
    writeFileSync(file, after, "utf-8");
    expect(keepPlanApprovalAskOverStateWrite(proj, "# another state\n", after)).toBe(false);
    expect(planApprovalAskIsOpen(proj)).toBe(false);
  });

  // "This is existing code" at Code Generation: Reverse Engineering runs on
  // its own, and its own steps and writes are its work, not the build's.
  test("a Reverse Engineering run on its own at Code Generation is not held for the plan", () => {
    const proj = waitingPlan();
    reply(proj, "/aidlc --stage reverse-engineering --single");
    const run = next(proj, ["--stage", "reverse-engineering", "--single"]);
    expect(run.kind, JSON.stringify(run)).toBe("run-stage");
    expect(run.stage).toBe("reverse-engineering");
    const record = guardWrite(proj, join(seededRecordDir(proj), "inception", "reverse-engineering", "notes.md"));
    expect(record.code, record.stderr).toBe(0);
    const scan = guardBash(proj, withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine workspace codekb-scope-diff"));
    expect(scan.code, scan.stderr).toBe(0);
    // The workspace source still waits for the approved plan, and so do the
    // work's state and a record hard-linked to source.
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(guardBash(proj, "printf x > src/slugify.ts").code).toBe(2);
    expect(guardWrite(proj, seededStateFile(proj)).code).toBe(2);
    const linked = join(seededRecordDir(proj), "inception", "reverse-engineering", "linked.md");
    mkdirSync(dirname(linked), { recursive: true });
    linkSync(join(proj, "src", "base.ts"), linked);
    expect(guardWrite(proj, linked).code).toBe(2);
  });
});

// A project whose files cannot all be read (a very large repository, a link
// that loops) is no stop when Guard Policy is relaxed or off, or plan approval
// is off: the plan is asked about, or built as written, and the build starts
// with one line. Strict with plan approval on still names the repair.
describe("a project whose files cannot all be read", () => {
  function unreadable<T>(run: () => T): T {
    const before = process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES;
    process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES = "1";
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES;
      else process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES = before;
    }
  }

  test.each(["relaxed", "off"] as const)("under %s the plan is asked, approved and built, with one line", (policy) => {
    const proj = project(policy);
    unreadable(() => {
      writePlan(proj);
      const asked = next(proj);
      expect(asked.kind, JSON.stringify(asked)).toBe("ask");
      expect(asked.ask_type).toBe("plan-approval");
      replyAndRecord(proj, "1", "Approve Plan");
      expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      const begun = posture(proj, "begin", null);
      expect(begun.status, begun.stderr).toBe(0);
      expect(begun.stdout).toContain("Building without a check of the project's files");
    });
  });

  test("plan approval off under strict builds the plan as written", () => {
    const proj = project("strict", "off");
    unreadable(() => {
      writePlan(proj);
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval?.status).toBe("approved");
      const begun = posture(proj, "begin", null);
      expect(begun.status, begun.stderr).toBe(0);
    });
  });

  test("strict with plan approval on still says what to repair before asking", () => {
    const proj = project("strict");
    unreadable(() => {
      writePlan(proj);
      const stopped = next(proj);
      expect(stopped.kind, JSON.stringify(stopped)).toBe("error");
      expect(stopped.message).toContain("cannot be presented");
    });
  });

  // Under strict the person can still have the plan built, on their own word:
  // they say so however they like, after they were told why it cannot be
  // checked, and the agent records it with their words on the record. There is
  // no sentence to type.
  function writeBuildAnyway(proj: string, reason: string): void {
    const tags = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), "fingerprint", "--stage-level", "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(tags.status, tags.stderr).toBe(0);
    writeFileSync(
      join(stageDir(proj), "code-generation-questions.md"),
      `## Plan Approval\n${tags.stdout.trim()}\nA. Approve Plan\nB. Request Changes\n[Answer]: Approve Plan\n`,
      "utf-8",
    );
    writeFileSync(join(stageDir(proj), "override-reason.txt"), `${reason}\n`, "utf-8");
  }

  function buildAnyway(proj: string, env: Record<string, string> = {}): { status: number | null; out: string } {
    const result = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
      "--stage-level", "--session", SESSION, "--questions-file", join(stageDir(proj), "code-generation-questions.md"),
      "--details", "Approve Plan", "--override-file", join(stageDir(proj), "override-reason.txt"), "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...env },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  function auditBlock(proj: string, event: string): string | undefined {
    return auditText(proj).split("\n---\n").find((block) => block.includes(`**Event**: ${event}`));
  }

  test("strict: the refusal says they can have it built anyway, and their own words do it", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      const stopped = next(proj);
      expect(stopped.kind, JSON.stringify(stopped)).toBe("error");
      expect(stopped.message).toContain("built anyway");
      expect(stopped.message).not.toContain("type exactly");
      expect(stopped.message).not.toContain("Override Plan Approval:");
      reply(proj, "build it anyway, that folder is a dev mount");
      writeBuildAnyway(proj, "that folder is a dev mount");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      // The receipt prints no line for the person; the record keeps the override.
      expect(built.out).not.toContain("Recorded that you approved building this plan with no check of the project's files.");
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: build it anyway, that folder is a dev mount");
      const recorded = auditBlock(proj, "PLAN_APPROVAL_RECORDED");
      expect(recorded).toContain("**Override**: yes");
      expect(recorded).toContain("**Person Reply**: build it anyway, that folder is a dev mount");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
    });
  });

  test("strict: without a reply of theirs since the refusal nothing is recorded, and the line says to ask them", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      // Words from before they were told are no answer to it.
      reply(proj, "build it anyway");
      expect(next(proj).kind).toBe("error");
      writeBuildAnyway(proj, "the folder is a dev mount");
      const refused = buildAnyway(proj);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("end the turn");
      expect(refused.out).not.toContain("type exactly");
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toBeUndefined();
      expect(auditBlock(proj, "PLAN_APPROVAL_RECORDED")).toBeUndefined();
      // The refusal shown again does not move past their next reply.
      expect(next(proj).kind).toBe("error");
      reply(proj, "fine, build it anyway");
      expect(next(proj).kind).toBe("error");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: fine, build it anyway");
    });
  });

  test("strict: one reply has the plan built once", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      reply(proj, "go ahead and build it anyway");
      writeBuildAnyway(proj, "go ahead");
      expect(buildAnyway(proj).status).toBe(0);
      const again = buildAnyway(proj);
      expect(again.status).not.toBe(0);
      expect(auditText(proj).split("**Event**: PLAN_APPROVAL_OVERRIDDEN").length).toBe(2);
    });
  });

  test("strict: a pick in a question box after the refusal has it built, with the pick on the record", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      const asked = [{
        question: "How do you want to go on?", header: "Plan", multiSelect: false,
        options: [{ label: "Build it anyway", description: "" }, { label: "Fix the files first", description: "" }],
      }];
      const picked = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
        cwd: proj,
        input: JSON.stringify({
          hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
          tool_input: { questions: asked },
          tool_response: { questions: asked, answers: { "How do you want to go on?": "Build it anyway" } },
        }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(picked.status, picked.stderr).toBe(0);
      writeBuildAnyway(proj, "Build it anyway");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: Build it anyway");
    });
  });

  test("strict: a message that starts with the old override sentence is a reply like any other", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      reply(proj, "Override Plan Approval: the walk is broken here");
      const turn = auditBlock(proj, "HUMAN_TURN");
      expect(turn).not.toContain("**Reply**: command");
      writeBuildAnyway(proj, "the walk is broken here");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: Override Plan Approval: the walk is broken here");
    });
  });

  test("an unattended run has no person to ask, and the line says so", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      const prompt = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
        cwd: proj,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "build it anyway" }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "1" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(prompt.status, prompt.stderr).toBe(0);
      writeBuildAnyway(proj, "unattended");
      const refused = buildAnyway(proj, { AIDLC_UNATTENDED: "1" });
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("AIDLC_UNATTENDED=1 is set");
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toBeUndefined();
    });
  });

  // Starting the build of a plan approved before its files stopped being
  // readable names the repair and the next step. It offers no override:
  // `next` says how to go on, and is where the person hears it.
  test("strict: generation start on files that cannot be read says to repair them and run next", () => {
    const proj = project("strict");
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    unreadable(() => {
      const begun = posture(proj, "begin", null);
      expect(begun.status).not.toBe(0);
      expect(begun.stderr).toContain("then run next");
      expect(begun.stderr).not.toContain("retry generation");
      expect(begun.stderr).not.toContain("Override Plan Approval");
    });
  });
});

describe("stopping for now at Code Generation", () => {
  // Coming back the next day: the unpark the engine names gets through the
  // guard, and the approved plan is built with no new question.
  test.each(["strict", "off"] as const)("after approve-and-stop, the resume the engine names builds the plan (%s)", (policy) => {
    const proj = project(policy);
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    reply(proj, "Approve the plan, but let's stop there for today");
    expect(answer(proj, "Approve Plan", ["--park"]).message).toContain("parked");
    const source = workspaceSourceFingerprint(proj);
    const unpark = resumeNamesUnpark(proj);
    const admitted = guardBash(proj, unpark);
    expect(admitted.code, admitted.stderr).toBe(0);
    runInstalled(proj, unpark);
    const build = next(proj, ["--resume"]);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(workspaceSourceFingerprint(proj)).toBe(source);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
  });

  // Stopping before the plan is approved: the park gets through the guard
  // however it was asked for, and coming back asks about the same plan again.
  test.each([
    ["typed /aidlc park", "typed"],
    ["asked in words", "words"],
  ] as const)("a stop before approval parks and comes back to the plan question (%s)", (_label, how) => {
    const proj = project("strict");
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    const source = workspaceSourceFingerprint(proj);
    let park = withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine orchestrate park --person-asked");
    if (how === "typed") {
      const named = next(proj, ["park"]);
      expect(named.kind, JSON.stringify(named)).toBe("print");
      park = /Run `([^`]+ park --person-asked)`/.exec(named.message ?? "")?.[1] ?? "";
    }
    const parkAdmitted = guardBash(proj, park);
    expect(parkAdmitted.code, `${park}\n${parkAdmitted.stderr}`).toBe(0);
    expect(JSON.parse(runInstalled(proj, park)).kind).toBe("parked");
    expect(next(proj).kind).toBe("parked");
    const unpark = resumeNamesUnpark(proj);
    const unparkAdmitted = guardBash(proj, unpark);
    expect(unparkAdmitted.code, unparkAdmitted.stderr).toBe(0);
    runInstalled(proj, unpark);
    const back = next(proj, ["--resume"]);
    expect(back.kind, JSON.stringify(back)).toBe("ask");
    expect(back.ask_type).toBe("plan-approval");
    expect(workspaceSourceFingerprint(proj)).toBe(source);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });

  // #3227: work parked at Code Generation is not being built, so the person's
  // other work in the project goes on under every Guard Policy, before and
  // after `next` says it is parked; the files the plan names and its developer
  // wait for the resume.
  test.each([
    ["at the plan question", "strict"],
    ["at the plan question", "relaxed"],
    ["after approval", "strict"],
    ["after approval", "off"],
  ] as const)("parked %s, other work in the project goes on and the plan's own files wait (%s)", (when, policy) => {
    const proj = project(policy);
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    if (when === "after approval") {
      reply(proj, "Approve the plan, but let's stop there for today");
      expect(answer(proj, "Approve Plan", ["--park"]).message).toContain("parked");
    } else {
      reply(proj, "let's stop here for today");
      const park = withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine orchestrate park --person-asked");
      expect(JSON.parse(runInstalled(proj, park)).kind).toBe("parked");
    }
    const otherWorkGoesOn = (point: string): void => {
      for (const command of [
        `python3 -c "open('notes.txt','w').write('x')"`,
        // The commit the way the agent writes one, its message in a here-document.
        "git commit -m \"$(cat <<'EOF'\nanother feature\nEOF\n)\"",
        "printf x > src/other.ts",
      ]) {
        const result = guardBash(proj, command);
        expect(result.code, `${point}: ${command}\n${result.stderr}`).toBe(0);
      }
      const edit = guardWrite(proj, join(proj, "src", "inline.ts"));
      expect(edit.code, `${point}\n${edit.stderr}`).toBe(0);
      const planned = guardWrite(proj, join(proj, "src", "slugify.ts"));
      expect(planned.code, point).toBe(2);
      expect(planned.stderr, point).toContain(" next`");
      expect(guardDispatch(proj, "AIDLC-STAGE: code-generation\n").code, point).toBe(2);
    };
    otherWorkGoesOn("parked");
    expect(next(proj).kind).toBe("parked");
    otherWorkGoesOn("after next says parked");
  });

  // A built Unit's files are not the parked build: with unit-a built and the
  // work parked at unit-b's Code Generation, a file only unit-a's plan names is
  // the person's other work, as it is at unit-b's plan question; unit-b's own
  // file and the developer wait for the resume.
  test.each(["at the plan question", "after approval"] as const)(
    "parked %s of a later Unit, a file only a built Unit's plan names goes on and the parked Unit's waits",
    (when) => {
      const proj = unitProject("unit-a", "unit-b");
      cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
      const state = seededStateFile(proj);
      writeFileSync(state, readFileSync(state, "utf-8")
        .replace("## Scope Configuration", "## Runtime State\n- **Revision Count**: 0\n\n## Scope Configuration")
        .replace("### CONSTRUCTION PHASE", "### INCEPTION PHASE\n- [x] units-generation \u2014 EXECUTE\n\n### CONSTRUCTION PHASE"));
      writePlan(proj, "", "unit-a", "src/a.ts");
      expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
      replyAndRecord(proj, "1", "Approve Plan");
      expect(next(proj)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
      runInstalled(proj, withCopyLaunchOptions("bun .claude/tools/aidlc-state.ts unit start --stage code-generation --unit unit-a"));
      expect(next(proj)).toMatchObject({ kind: "run-stage", unit: "unit-a" });
      writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");
      for (const name of ["code-summary", "traceability"]) {
        writeFileSync(join(stageDir(proj, "unit-a"), artifactFilename(name)), `# ${name}\nBuilt unit-a.\n`);
      }
      const stage = findStageBySlug("code-generation")!;
      const fields = {
        Stage: stage.slug, Unit: "unit-a", Reviewer: stage.reviewer!, Iteration: "1",
        "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, "unit-a")!,
      };
      appendAuditEntry("REVIEW_REQUESTED", fields, proj);
      appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, proj);
      next(proj);
      runInstalled(proj, withCopyLaunchOptions("bun .claude/tools/aidlc-state.ts unit complete --stage code-generation --unit unit-a"));
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(true);
      expect(next(proj)).toMatchObject({ kind: "run-stage", unit: "unit-b", plan_approval: { status: "plan" } });
      writePlan(proj, "", "unit-b", "src/b.ts");
      expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
      if (when === "after approval") {
        reply(proj, "Approve the plan, but let's stop there for today");
        expect(answer(proj, "Approve Plan", ["--park"]).message).toContain("parked");
      } else {
        reply(proj, "let's stop here for today");
        expect(JSON.parse(runInstalled(proj, withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine orchestrate park --person-asked"))).kind)
          .toBe("parked");
      }
      const builtUnitsFilesGoOn = (point: string): void => {
        const built = guardWrite(proj, join(proj, "src", "a.ts"));
        expect(built.code, `${point}\n${built.stderr}`).toBe(0);
        const parked = guardWrite(proj, join(proj, "src", "b.ts"));
        expect(parked.code, point).toBe(2);
        expect(parked.stderr, point).toContain(" next`");
        expect(guardDispatch(proj, "AIDLC-UNIT: unit-b\n").code, point).toBe(2);
      };
      builtUnitsFilesGoOn("parked");
      expect(next(proj).kind).toBe("parked");
      builtUnitsFilesGoOn("after next says parked");
    },
  );
});

// From a live run under production guards: at the plan question the person
// asked "skip plan approval?" and the agent recorded "Approve Plan" from it and
// built the code. No tool reads the question: the hook keeps it whole, marks
// nothing, applies nothing and answers nothing, so the plan question stays open
// for the agent to answer it and offer; the choice, when they make it, is
// recorded from their words.
describe("a question about the switch is no answer to the plan question", () => {
  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval?\" records nothing, and the plan question stays open", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval?");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(auditText(proj)).not.toContain("**Event**: CEREMONY_SET");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    reply(proj, "ok, approve it");
    const approved = answer(proj, "Approve Plan");
    expect(approved.code, approved.message).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });
});

// The conductor's call on #1677's asked form, from the same live run: a
// question about the check turns nothing off, the agent answers it and offers,
// and a yes is the ask. A request, plain or phrased as a question, is done at
// once by the setter the agent runs, naming their message. No tool reads the words.
describe("a question about plan approval turns nothing off; a request does", () => {
  // The setter as the agent runs it under production guards: no presence bypass,
  // naming the message that asked for it (the agent read it).
  function setter(proj: string, message: string): { code: number; out: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", "guard.plan-approval", "off", "--message", message], {
      cwd: proj,
      env,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
  const offRows = (proj: string) => (auditText(proj).match(/\*\*Event\*\*: (GUARD_DISABLED|CEREMONY_SET)/g) ?? []).length;

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval?\" lowers nothing by itself; a yes to the offer does, with their words", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval?");
    expect(offRows(proj)).toBe(0);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "yes");
    const lowered = setter(proj, turnId(proj));
    expect(lowered.code, lowered.out).toBe(0);
    expect(offRows(proj)).toBeGreaterThan(0);
    expect(auditText(proj)).toContain("**Person Reply**: yes");
  });

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, a polite request phrased as a question lowers it at once", (policy) => {
    for (const words of ["can you turn plan approval off for this work?", "could we skip plan approval?"]) {
      const proj = project(policy);
      askFor(proj);
      reply(proj, words);
      const lowered = setter(proj, turnId(proj));
      expect(lowered.code, `${words}: ${lowered.out}`).toBe(0);
      expect(auditText(proj)).toContain(`**Person Reply**: ${words}`);
    }
  });

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval for this work\" is done at once by the setter, with their words", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval for this work");
    expect(offRows(proj)).toBe(0);
    const lowered = setter(proj, turnId(proj));
    expect(lowered.code, lowered.out).toBe(0);
    expect(offRows(proj)).toBeGreaterThan(0);
    expect(auditText(proj)).toContain("**Person Reply**: skip plan approval for this work");
    const after = next(proj);
    expect(after.kind === "ask" && after.ask_type === "plan-approval", JSON.stringify(after)).toBe(false);
  });

  // From a live run: the chat opened with `/aidlc`, the plan question came,
  // and "skip plan approval?" turned the check off, because the opening
  // command still read as a request. The person's latest word was a question.
  test("after the chat's opening /aidlc, \"skip plan approval?\" is the person's words and nothing is applied or recorded", () => {
    const proj = project("off");
    reply(proj, "/aidlc");
    askFor(proj);
    reply(proj, "skip plan approval?");
    // A question is the agent's to answer and offer on: the hook marks nothing,
    // nothing is recorded, and the plan question is still open.
    expect(offRows(proj)).toBe(0);
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("after the chat's opening /aidlc, a request to skip plan approval is still done at once by the setter", () => {
    const proj = project("off");
    reply(proj, "/aidlc");
    askFor(proj);
    reply(proj, "skip plan approval for this work");
    const lowered = setter(proj, turnId(proj));
    expect(lowered.code, lowered.out).toBe(0);
    expect(offRows(proj)).toBeGreaterThan(0);
  });
});

// The lockout reported in #1172: a Brownfield refactor (or bugfix) workflow
// skips units-generation, so Code Generation is one zero-Unit, stage-level
// target. The person approved the plan; the rules then arrived in parts, and
// the build never started: the next part was refused, a fresh `next` started
// the parts over, and every worker handoff and source edit was refused while
// the step was a rules part. Parking to stop for the day was a trap of its
// own: the refusal named `next`, `next` named the unpark, and the unpark was
// refused. These cases drive that sequence end to end with the real engine,
// the real human-turn hook, and the real plan-approval guard.
function zeroUnitProject(scope: "refactor" | "bugfix"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  let state = readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope bugfix)",
      `- **Guard Policy**: off (from scope ${scope})\n- **Plan Approval**: on (from scope ${scope})`)
    .replace("- [-] requirements-analysis \u2014 EXECUTE", "- [x] requirements-analysis \u2014 EXECUTE")
    .replace("- [ ] code-generation \u2014 EXECUTE", "- [-] code-generation \u2014 EXECUTE")
    .replace("- **Lifecycle Phase**: INCEPTION", "- **Lifecycle Phase**: CONSTRUCTION")
    .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: code-generation")
    .replace("- **Next Stage**: code-generation", "- **Next Stage**: build-and-test");
  if (scope === "refactor") {
    state = state
      .replace("- **Scope**: bugfix", "- **Scope**: refactor")
      .replace("- [ ] functional-design \u2014 SKIP (bugfix scope)", "- [x] functional-design \u2014 EXECUTE")
      .replaceAll("SKIP (bugfix scope)", "SKIP (refactor scope)");
  }
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
  return withRulesInParts(proj);
}

function activeMarker(proj: string): { kind?: string; stage?: string; unit?: string } {
  return JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8"));
}

/** Each rules part's own `continue`, run once, to the directive after the last part. */
function continueEachPart(proj: string, first: Emitted & { part?: number; receipt?: string }): Emitted {
  let directive = first;
  let parts = 0;
  while (directive.kind === "load-steering") {
    expect(directive.stage).toBe("code-generation");
    expect(directive.part).toBe(++parts);
    directive = engineCall(proj, ["continue", String(directive.receipt)]);
  }
  expect(parts).toBeGreaterThan(1);
  return directive;
}

function approveThroughParts(proj: string, scope: string): Emitted {
  writePlan(proj);
  const ask = next(proj);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
  expect(ask.plan_approval.targets?.map((target) => target.unit)).toEqual([null]);
  // The person picks Approve Plan, the first choice.
  replyAndRecord(proj, "1", "Approve Plan");
  expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
  // The conductor re-enters naming the work's own scope, as reported. (New words
  // here would be new work, which the engine asks the person about.)
  const first = engineCall(proj, ["next", "--scope", scope]);
  expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
  // While a part is the step, the refusal names that part's own `continue`.
  const early = guardWrite(proj, join(proj, "src", "slugify.ts"));
  expect(early.code).toBe(2);
  expect(early.stderr).toContain(`continue ${first.receipt}\``);
  expect(early.stderr).not.toContain("AI-DLC is not on the build step");
  const build = continueEachPart(proj, first);
  expect(build.kind, JSON.stringify(build)).toBe("run-stage");
  expect(build.stage).toBe("code-generation");
  expect(build.plan_approval).toEqual({ status: "approved" });
  expect(activeMarker(proj)).toMatchObject({ kind: "run-stage", stage: "code-generation" });
  expect(activeMarker(proj).unit).toBeUndefined();
  return build;
}

/** The developer handoff with the markers the reporter used, and nothing else. */
function stageLevelHandoff(proj: string): { code: number; stderr: string } {
  const approval = evaluateCodeGenerationApproval(proj, { unit: null });
  expect(approval.ok, approval.reason).toBe(true);
  return guardDispatch(proj, `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${approval.contractHash}\n`);
}

describe("the zero-Unit Code Generation lockout reported in #1172", () => {
  for (const scope of ["refactor", "bugfix"] as const) {
    test(`one approval builds the stage-level plan: the parts, the handoff, and the source edits go through (${scope})`, () => {
      const proj = zeroUnitProject(scope);
      approveThroughParts(proj, scope);
      const handoff = stageLevelHandoff(proj);
      expect(handoff.code, handoff.stderr).toBe(0);
      expect(generationStarted(proj)).toBe(true);
      const edit = guardWrite(proj, join(proj, "src", "slugify.ts"));
      expect(edit.code, edit.stderr).toBe(0);
      expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
      expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
      expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
    });
  }

  // Before approval the planning rules can come in parts too: each part's
  // refusal names its own `continue`, the planning step lets the plan be
  // written, and the engine opens the question.
  test("before approval, the planning rules arrive in parts, the plan is written, and the question opens", () => {
    const proj = zeroUnitProject("refactor");
    const first = engineCall(proj, ["next"]);
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
    // The plan file is a record and passes while the rules arrive; a source
    // write waits, and the refusal names the part's `continue`.
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(0);
    const early = guardWrite(proj, join(proj, "src", "slugify.ts"));
    expect(early.code).toBe(2);
    expect(early.stderr).toContain(`continue ${first.receipt}\``);
    const planning = continueEachPart(proj, first);
    expect(planning.kind, JSON.stringify(planning)).toBe("run-stage");
    expect(planning.plan_approval).toEqual({ status: "plan" });
    for (const file of ["code-generation-plan.md", "unit-test-instructions.md"]) {
      const write = guardWrite(proj, join(stageDir(proj), file));
      expect(write.code, write.stderr).toBe(0);
    }
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  for (const when of ["while the rules arrive", "during the build"] as const) {
    test(`stopping for the day ${when}: the way back the refusal names gets through, and the plan is built with no new question`, () => {
      const proj = zeroUnitProject("refactor");
      if (when === "during the build") {
        approveThroughParts(proj, "refactor");
        expect(stageLevelHandoff(proj).code).toBe(0);
      } else {
        writePlan(proj);
        expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
        replyAndRecord(proj, "1", "Approve Plan");
        expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
      }
      const park = withCopyLaunchOptions("bun .claude/tools/aidlc.ts engine orchestrate park");
      const parkAdmitted = guardBash(proj, park);
      expect(parkAdmitted.code, parkAdmitted.stderr).toBe(0);
      expect(JSON.parse(runInstalled(proj, park)).kind).toBe("parked");
      // Parked, a write to a file the plan names waits; the refusal names
      // `next`, and `next --resume` names the unpark, which the guard lets through.
      const parked = guardBash(proj, "printf changed > src/slugify.ts");
      expect(parked.code).toBe(2);
      expect(parked.stderr).toContain(" next`");
      const unpark = resumeNamesUnpark(proj);
      const unparkAdmitted = guardBash(proj, unpark);
      expect(unparkAdmitted.code, unparkAdmitted.stderr).toBe(0);
      runInstalled(proj, unpark);
      const first = engineCall(proj, ["next", "--resume"]);
      expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
      const build = continueEachPart(proj, first);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      const handoff = stageLevelHandoff(proj);
      expect(handoff.code, handoff.stderr).toBe(0);
      expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
      expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
    });
  }

  // A merge that rewrote the state file left a Code Generation rules part as
  // the last thing published while the state went back to Functional Design.
  test("a rules part left over from before the state moved back holds nothing: the current stage runs", () => {
    const proj = zeroUnitProject("refactor");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    replyAndRecord(proj, "1", "Approve Plan");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8")
      .replace("- [x] functional-design \u2014 EXECUTE", "- [-] functional-design \u2014 EXECUTE")
      .replace("- [-] code-generation \u2014 EXECUTE", "- [ ] code-generation \u2014 EXECUTE")
      .replace("- **Current Stage**: code-generation", "- **Current Stage**: functional-design"), "utf-8");
    expect(activeMarker(proj)).toMatchObject({ kind: "load-steering", stage: "code-generation" });
    const edit = guardWrite(proj, join(proj, "src", "slugify.ts"));
    expect(edit.code, edit.stderr).toBe(0);
    const current = nextThroughParts(proj).directive;
    expect(current.kind, JSON.stringify(current)).toBe("run-stage");
    expect(current.stage).toBe("functional-design");
  });
});

// The Copilot CLI's file tool makes no folders ("Parent directory does not
// exist"), and while the plan waits the guard refuses every PowerShell way of
// making one (New-Item, a variable, python), so on Windows the agent looped and
// then turned plan approval off before the plan question was ever asked. The
// engine makes the plan's folder when it issues the step that writes the plan.
describe("the plan's record folder is there before the plan is written", () => {
  const emptyFolder = (dir: string): void => {
    expect(existsSync(dir), dir).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  };

  test("a bugfix's stage-level plan step, with its rules in parts: the folder is there from the first part", () => {
    const proj = zeroUnitProject("bugfix");
    expect(existsSync(stageDir(proj))).toBe(false);
    const first = engineCall(proj, ["next"]);
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
    emptyFolder(stageDir(proj));
    const planning = continueEachPart(proj, first);
    expect(planning.plan_approval).toEqual({ status: "plan" });
    emptyFolder(stageDir(proj));
    // The plan is one plain file write into it.
    const write = guardWrite(proj, join(stageDir(proj), "code-generation-plan.md"));
    expect(write.code, write.stderr).toBe(0);
  });

  test("a Unit's plan step makes that Unit's folder only", () => {
    const proj = unitProject("unit-a");
    const step = next(proj) as Emitted & { unit?: string };
    expect(step).toMatchObject({ kind: "run-stage", unit: "unit-a", plan_approval: { status: "plan" } });
    emptyFolder(stageDir(proj, "unit-a"));
    expect(existsSync(stageDir(proj))).toBe(false);
  });

  test("a parallel batch's plan step makes each listed Unit's folder", () => {
    const pd = swarmFixture(false);
    // Installed as config installs it, and the person's message reached the
    // hooks, so `next` hands out the batch.
    mkdirSync(join(pd, ".claude"), { recursive: true });
    cpSync(join(AIDLC_SRC, "settings.json"), join(pd, ".claude", "settings.json"));
    reply(pd, "continue");
    const batch = next(pd);
    expect(batch.kind, JSON.stringify(batch)).toBe("invoke-swarm");
    expect(batch.plan_approval.status).toBe("plan");
    for (const unit of GROUP) emptyFolder(codeGenerationRecordDir(pd, unit));
    expect(existsSync(codeGenerationRecordDir(pd, "later"))).toBe(false);
  });

  test("a file where the folder goes, or a link out of the project, leaves the step as it was", () => {
    const blocked = project();
    mkdirSync(dirname(stageDir(blocked)), { recursive: true });
    writeFileSync(stageDir(blocked), "", "utf-8");
    expect(next(blocked).plan_approval).toEqual({ status: "plan" });
    expect(readFileSync(join(hooksHealthDir(blocked), "record-folders.drops"), "utf-8")).toContain("EEXIST");
    if (process.platform === "win32") return; // A link needs a privilege Windows does not give by default.
    const linked = project();
    const outside = mkdtempSync(join(tmpdir(), "t-plan-folder-outside-"));
    try {
      symlinkSync(outside, join(seededRecordDir(linked), "construction"));
      expect(next(linked).plan_approval).toEqual({ status: "plan" });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a route check makes nothing, and a written plan's folder keeps what it holds", () => {
    const proj = project();
    const probe = runOrchestrateNext(ORCHESTRATE, proj, [], { env: { ...process.env, AIDLC_ROUTE_CHECK: "1" } });
    expect(probe.directive).toMatchObject({ kind: "run-stage", stage: "code-generation" });
    expect(existsSync(stageDir(proj))).toBe(false);
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    emptyFolder(stageDir(proj));
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(readdirSync(stageDir(proj))).toEqual(expect.arrayContaining(["code-generation-plan.md", "unit-test-instructions.md"]));
  });
});

// A setting typed over the step in hand. A live run (Claude Code, 2026-10-11)
// typed "turn the specialist reviewers off for the rest of this work" while
// Code Generation was planning; the setting's state write retired the issued
// step (its state digest no longer matched), so the guard refused the plan
// write twice with "no matching v2 code-generation active directive" until a
// fresh `next`. The step stays current over the write, as it does over
// set-autonomy: a setting changes how the step runs, not which step it is.
describe("a setting typed over the step in hand keeps that step current", () => {
  // The setter `config set <key> <value>` runs (the dispatcher routes it here).
  const configSet = (proj: string, key: string, value: string): string => {
    const result = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "config-change", `--${key}`, value, "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout ?? "";
  };
  const stateOf = (proj: string): string => readFileSync(seededStateFile(proj), "utf-8");
  const planFile = (proj: string): string => {
    mkdirSync(stageDir(proj), { recursive: true });
    return join(stageDir(proj), "code-generation-plan.md");
  };

  test("while the plan is written: the plan write still goes through after the setting", () => {
    const proj = project();
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    expect(readActiveDirectiveMarker(proj, stateOf(proj))?.kind).toBe("run-stage");
    expect(guardWrite(proj, planFile(proj)).code).toBe(0);
    configSet(proj, "review", "none");
    expect(stateOf(proj)).toContain("- **Review Override**: none");
    const kept = readActiveDirectiveMarker(proj, stateOf(proj));
    expect(kept?.kind).toBe("run-stage");
    expect(kept?.stage).toBe("code-generation");
    const write = guardWrite(proj, planFile(proj));
    expect(write.code, write.stderr).toBe(0);
    expect(write.stderr).not.toContain("AI-DLC is not on the build step");
  });

  test("after approval, with the build issued: a source write goes through, and the review the setting turned off is refused", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "yes");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    const source = join(proj, "src", "slugify.ts");
    expect(guardWrite(proj, source).code).toBe(0);
    configSet(proj, "review", "none");
    const write = guardWrite(proj, source);
    expect(write.code, write.stderr).toBe(0);
    // The step in hand was issued with a reviewer; the tool, not the directive,
    // decides a review: under none its budget is 0.
    const review = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "review", "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent", "--iteration", "1", "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(review.status).not.toBe(0);
    expect(`${review.stdout}${review.stderr}`).toContain("REVIEW_BUDGET_EXHAUSTED");
  });

  test("the Guard Policy the person typed keeps the step too, with no plan question open", () => {
    const proj = project("strict");
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    expect(planApprovalAskIsOpen(proj)).toBe(false);
    // Their line changes nothing by itself; the setter the agent runs for it
    // does, and the step in hand is still the step after it.
    reply(proj, "/aidlc --guard-policy relaxed");
    expect(stateOf(proj)).toContain("- **Guard Policy**: strict");
    configSet(proj, "guard-policy", "relaxed");
    expect(stateOf(proj)).toContain("- **Guard Policy**: relaxed (set by you)");
    const kept = readActiveDirectiveMarker(proj, stateOf(proj));
    expect(kept?.kind).toBe("run-stage");
    expect(guardWrite(proj, planFile(proj)).code).toBe(0);
  });
});

// The governance protocol writes a phase-boundary verification report
// (<record>/verification/<boundary>-verification.md) as the next phase begins.
// A Codex run wrote the Inception->Construction one while Code Generation was
// planning and the guard refused it as a workspace path ("Blocked by hook" on
// the person's screen). It is AI-DLC's own record of a check, not source and
// not a plan-bound file: admitted while the Code Generation step is current,
// under the stage diary's fences. Source still waits for the approval.
describe("the phase-boundary verification report is written while the plan is", () => {
  const report = (proj: string, drive: "same" | "flipped" = "same"): string => {
    const target = join(seededRecordDir(proj), "verification", "inception-construction-verification.md");
    if (drive === "same") return target;
    return target.replace(/^([A-Za-z]):/, (_m, letter: string) =>
      `${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}:`);
  };

  test("a Write under <record>/verification/ goes through at the planning step; a source write still waits", () => {
    const proj = project();
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    const write = guardWrite(proj, report(proj));
    expect(write.code, write.stderr).toBe(0);
    const source = guardWrite(proj, join(proj, "src", "other.ts"));
    expect(source.code).toBe(2);
    expect(source.stderr).toContain("Code generation cannot modify workspace paths for the zero-Unit stage-level implementation");
    expect(source.stderr).toContain("Writes inside the selected code-generation record directory remain available for planning.");
    // The state and the engine's control files are not a report.
    expect(guardWrite(proj, join(seededRecordDir(proj), "verification", "..", "aidlc-state.md")).code).toBe(2);
  });

  // VS Code hosts report c:\ where the project dir carries C:; the drive letter
  // is folded, as the stage diary's is, so the same folder is the same folder.
  test.skipIf(process.platform !== "win32")("on Windows the report spelled with the other drive-letter case is the same folder", () => {
    const proj = project();
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    const write = guardWrite(proj, report(proj, "flipped"));
    expect(write.code, write.stderr).toBe(0);
  });
});

// #2551: the router's receipt recovery must survive the actual PreToolUse
// boundary, including a state write that legitimately retires its old marker.
describe("Code Generation receipt recovery through the Plan Approval hook", () => {
  function readyUnit(unitMajor = false): string {
    const proj = unitProject("unit-a", "unit-b");
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace(
      "- **Guard Policy**: relaxed (set by you)", "- **Guard Policy**: strict (set by you)",
    ).replace(
      "## Scope Configuration", "## Runtime State\n- **Revision Count**: 0\n\n## Scope Configuration",
    ).replace(
      "### CONSTRUCTION PHASE", "### INCEPTION PHASE\n- [x] units-generation — EXECUTE\n\n### CONSTRUCTION PHASE",
    ));
    if (unitMajor) {
      writeFileSync(state, readFileSync(state, "utf-8")
        .replace("## Runtime State", "## Runtime State\n- **Construction Iteration**: unit-major")
        .replace(/^- \[x\] (functional-design|nfr-requirements|nfr-design|infrastructure-design)/gm, "- [S] $1"));
    }
    writePlan(proj, "", "unit-a");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
    const start = withCopyLaunchOptions(`bun .claude/tools/aidlc-state.ts unit start --stage code-generation --unit unit-a`);
    expect(guardBash(proj, start).code).toBe(0);
    runInstalled(proj, start);
    expect(next(proj)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
    const source = join(proj, "src", "slugify.ts");
    const write = guardWrite(proj, source);
    expect(write.code, write.stderr).toBe(0);
    writeFileSync(source, "export const slugify = (title: string) => title.toLowerCase();\n");

    for (const name of ["code-summary", "traceability"]) {
      writeFileSync(join(stageDir(proj, "unit-a"), artifactFilename(name)), `# ${name}\nBuilt unit-a.\n`);
    }
    const stage = findStageBySlug("code-generation")!;
    const fields = {
      Stage: stage.slug, Unit: "unit-a", Reviewer: stage.reviewer!, Iteration: "1",
      "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, "unit-a")!,
    };
    appendAuditEntry("REVIEW_REQUESTED", fields, proj);
    appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, proj);
    return proj;
  }

  function codexGuard(proj: string, command: string, toolUseId: string): ReturnType<typeof spawnSync> {
    return spawnSync(BUN, [join(REPO_ROOT, "dist", "codex", ".codex", "hooks", "aidlc-codex-adapter.ts"), "plan-approval-guard"], {
      cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_use_id: toolUseId,
        tool_name: "Bash", tool_input: { command } }),
      env: { ...process.env, AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0" },
    });
  }

  for (const unitMajor of [false, true]) {
    test(`${unitMajor ? "unit-major" : "stage-major"}: next refreshes retired authority before its exact receipt command is guarded`, () => {
      const proj = readyUnit(unitMajor);
      reply(proj, "Use scope-dependent skeleton stance");
      runInstalled(proj, withCopyLaunchOptions("bun .claude/tools/aidlc-state.ts set-skeleton-stance scope-dependent"));
      expect(readActiveDirectiveMarker(proj, readFileSync(seededStateFile(proj), "utf-8"))).toBeNull();
      const complete = withCopyLaunchOptions("bun .claude/tools/aidlc-state.ts unit complete --stage code-generation --unit unit-a");
      // A Unit's completion is the engine's own command, before `next` as
      // after: `unit complete` judges the Unit's approved plan itself.
      const early = guardBash(proj, complete);
      expect(early.code, early.stderr).toBe(0);
      expect(early.stderr).toBe("");
      // To the Codex tree's guard the `.claude` spelling is no installed command
      // of its own, so the build's check holds it until `next` refreshes the step.
      const staleCodex = codexGuard(proj, complete, "before-next");
      expect(staleCodex.status, String(staleCodex.stderr)).toBe(2);
      const probe = runOrchestrateNext(ORCHESTRATE, proj, [], {
        env: { ...process.env, AIDLC_ROUTE_CHECK: "1" },
      });
      expect(probe.directive).toMatchObject({ kind: "run-stage", unit: "unit-a" });
      expect(readActiveDirectiveMarker(proj, readFileSync(seededStateFile(proj), "utf-8"))).toBeNull();
      const recovered = next(proj) as Emitted & { unit_record_step?: string; gate_note?: string };
      const admitted = guardBash(proj, complete);
      expect(admitted.code, admitted.stderr).toBe(0);
      expect(recovered).toMatchObject({ kind: "run-stage", stage: "code-generation", plan_approval: { status: "approved" } });
      expect(recovered.unit_record_step).toContain(complete);
      expect(recovered.gate_note).toBe(recovered.unit_record_step);
      expect(recovered).toMatchObject({ mode: "inline" });
      expect(recovered).not.toHaveProperty("plan_note");
      expect(recovered.narration ?? "").not.toContain("Building");
      const codex = codexGuard(proj, complete, "after-next");
      expect(codex.status, String(codex.stderr)).toBe(0);
      // The state command still owns Unit/artifact admission; another Unit has
      // neither the outputs nor its review and cannot borrow this recovery.
      const other = spawnSync(BUN, [STATE, "unit", "complete", "--stage", "code-generation", "--unit", "unit-b", "--project-dir", proj], {
        cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        env: { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "0" },
      });
      expect(other.status, other.stderr).not.toBe(0);
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-b")).toBe(false);
      next(proj);
      runInstalled(proj, complete);
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(true);
      expect(JSON.stringify(next(proj))).not.toContain("completion is not recorded");
    });

  }

  for (const missing of [true, false]) {
    test(`${missing ? "a missing artifact" : "a stale review"} keeps the normal work step`, () => {
      const proj = readyUnit();
      const summary = join(stageDir(proj, "unit-a"), "code-summary.md");
      if (missing) rmSync(summary);
      else writeFileSync(summary, "# Code summary\nChanged after review.\n");
      const routed = next(proj);
      expect(routed).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
      expect(routed).not.toHaveProperty("unit_record_step");
      if (missing) {
        const result = spawnSync(BUN, [STATE, "unit", "complete", "--stage", "code-generation", "--unit", "unit-a", "--project-dir", proj], {
          cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          env: { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "0", AIDLC_SKIP_REVIEWER_GATE_GUARD: "0" },
        });
        expect(result.status, result.stderr).not.toBe(0);
      }
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(false);
    });
  }

  test("a changed approved plan routes to approval instead of another refused receipt", () => {
    const proj = readyUnit();
    writeFileSync(join(stageDir(proj, "unit-a"), "code-generation-plan.md"),
      `${readFileSync(join(stageDir(proj, "unit-a"), "code-generation-plan.md"), "utf-8")}\nNew work to approve.\n`);
    // Review the changed files so the receipt-only candidate still exists.
    const stage = findStageBySlug("code-generation")!;
    const fields = { Stage: stage.slug, Unit: "unit-a", Reviewer: stage.reviewer!, Iteration: "2",
      "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, "unit-a")! };
    appendAuditEntry("REVIEW_REQUESTED", fields, proj);
    appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, proj);
    const recovered = next(proj);
    expect(recovered).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(JSON.stringify(recovered)).not.toContain("unit_record_step");
    // The guard admits the Unit's completion; `unit complete` holds it itself
    // while the changed plan waits for the person.
    const complete = withCopyLaunchOptions("bun .claude/tools/aidlc-state.ts unit complete --stage code-generation --unit unit-a");
    const admitted = guardBash(proj, complete);
    expect(admitted.code, admitted.stderr).toBe(0);
    expect(admitted.stderr).toBe("");
    const held = spawnSync(BUN, [STATE, "unit", "complete", "--stage", "code-generation", "--unit", "unit-a", "--project-dir", proj], {
      cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    });
    expect(held.status, held.stderr).not.toBe(0);
    expect(held.stderr).toContain("The code plan is not approved yet");
    expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(false);
  });
});

// A typed "2" picks Request Changes and says nothing about what to change (on
// Codex the plan was once revised from "2"): the record keeps their "2" as
// their words, names no change, and the revision step has none to hand, so the
// agent asks what should change, once. A change they did say is the agent's
// reading, passed after the choice, and reaches the revision with no question.
describe("what to change is what the person said, as the agent read it", () => {
  const requestChangesRow = (proj: string): string =>
    auditText(proj).split("\n---\n").find((block) =>
      block.includes("**Details**: Request Changes") && block.includes("**Checkpoint**: plan-approval")) ?? "";

  test('a typed "2" records Request Changes with no change named, and the revision asks what should change', () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    const recorded = answer(proj, "Request Changes");
    expect(recorded.code, recorded.message).toBe(0);
    expect(requestChangesRow(proj)).toContain("**Person Reply**: 2");
    expect(requestChangesRow(proj)).not.toContain("**User Input**");
    expect(next(proj).plan_approval).toEqual({ status: "revise" });
  });

  test("a change they asked for, passed after the choice, reaches the revision with their words beside it", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "please add a test for the empty cart");
    const recorded = answer(proj, "Request Changes: add a test for the empty cart");
    expect(recorded.code, recorded.message).toBe(0);
    expect(requestChangesRow(proj)).toContain("**User Input**: add a test for the empty cart");
    expect(requestChangesRow(proj)).toContain("**Person Reply**: please add a test for the empty cart");
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "add a test for the empty cart" });
  });

  test("the stage tells the agent to pass what to change, and to ask when the reply only picked the choice", () => {
    const text = readFileSync(join(AIDLC_SRC, "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8")
      .replace(/\s+/g, " ");
    expect(text).toContain("pass what to change after the choice (`--details 'Request Changes: <what they asked>'`");
    expect(text).toContain("when their reply only picked Request Changes, ask what should change before you record it");
    expect(text).not.toContain("a change request uses them as what to change");
    // Several plans asked about at once: the change that names a Unit goes with it.
    const grouped = readFileSync(join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol-construction.md"), "utf-8")
      .replace(/\s+/g, " ");
    expect(grouped).toContain("record `Request Changes: use Stripe` for that Unit");
  });
});

// The plan's Testing Contract is engine output, so the engine writes it into
// the plan itself before it asks: an agent never copies it by hand, and one
// that left it out or copied it wrong is not sent to fix it. Only that section
// changes, and the person is asked about the plan as it is then on disk.
describe("the engine writes the plan's Testing Contract itself", () => {
  const planPath = (proj: string): string => join(stageDir(proj), "code-generation-plan.md");
  const planText = (proj: string): string => readFileSync(planPath(proj), "utf-8");
  const contract = (proj: string): string => renderTestingContract(resolveTestingPosture(proj));
  // writePlan's plan up to its Testing Contract.
  const STEPS = "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
    "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n";
  // The agent's plan: writePlan's, with its Testing Contract made into `block(rendered)`.
  function agentPlan(proj: string, block: (rendered: string) => string, unit: string | null = null): string {
    writePlan(proj, "", unit);
    const path = join(stageDir(proj, unit), "code-generation-plan.md");
    const plan = readFileSync(path, "utf-8").replace(contract(proj), block(contract(proj)));
    writeFileSync(path, plan, "utf-8");
    return plan;
  }
  const BROKEN: Array<[string, (rendered: string) => string]> = [
    ["left out", () => ""],
    // A hand copy that wrapped a long string: a line break inside it.
    ["copied with a string broken across lines", (rendered) => rendered.replace(/(": "[^"\n]{2})/, "$1\n")],
    ["changed after it was rendered, so its contract_sha256 no longer matches",
      (rendered) => rendered.replace('"version": 1', '"version": 1, "note": "edited"')],
  ];

  const POLICIES = ["strict", "relaxed", "off", "locked strict"] as const;
  // A project under one Guard Policy; "locked strict" is the team's strict line in memory.
  function policyProject(policy: (typeof POLICIES)[number]): string {
    const proj = project(policy === "locked strict" ? "strict" : policy);
    if (policy === "locked strict") {
      const memory = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
      const content = readFileSync(memory, "utf-8");
      writeFileSync(memory, content.includes("## Guard Policy\n")
        ? content.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
        : `${content.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
    }
    return proj;
  }
  const breakBlock = (proj: string): void =>
    writeFileSync(planPath(proj), planText(proj).replace('"version": 1', '"version": 1,,'), "utf-8");
  const moveContract = (proj: string): void => {
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace("- **Test Strategy**: Standard", "- **Test Strategy**: Comprehensive"));
  };

  test.each(BROKEN)("a contract %s: the engine writes it and asks once, and the approval covers the plan it wrote", (_label, block) => {
    const proj = project();
    agentPlan(proj, block);
    const asked = next(proj);
    expect(asked.kind, JSON.stringify(asked)).toBe("ask");
    expect(asked.ask_type).toBe("plan-approval");
    expect(planText(proj)).toBe(STEPS + contract(proj));
    // Nothing is written twice and no step comes back: the same question.
    const again = next(proj);
    expect(again.kind, JSON.stringify(again)).toBe("ask");
    expect(again.question).toBe(asked.question);
    expect(planText(proj)).toBe(STEPS + contract(proj));
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // A plan approved before the update carries its contract read the earlier
  // way (over the raw section text). While that text is the same the engine
  // leaves the block as it is, the answer records it as it is, and the
  // fingerprint command prints the approval's own fingerprint.
  test("a contract rendered before the update is left as it is while its text is the same", () => {
    const proj = project("strict");
    writePlan(proj);
    const earlier = renderTestingContract(resolveTestingPosture(proj, "raw"));
    expect(earlier).not.toBe(contract(proj));
    writeFileSync(planPath(proj), STEPS + earlier, "utf-8");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(planText(proj)).toBe(STEPS + earlier);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(planText(proj)).toBe(STEPS + earlier);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    const recorded = /^\[Approval Fingerprint\]: (\S+)$/m
      .exec(readFileSync(join(stageDir(proj), "code-generation-questions.md"), "utf-8"))?.[1];
    expect(recorded).toBeDefined();
    const printed = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), "fingerprint", "--stage-level", "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stdout.split("\n")[0]).toBe(`[Approval Fingerprint]: ${recorded}`);
  });

  test("a plan that already carries the current contract is asked about as written", () => {
    const proj = project();
    writePlan(proj);
    const written = planText(proj);
    expect(next(proj).kind).toBe("ask");
    expect(planText(proj)).toBe(written);
  });

  // A setting the person chose moves the contract: it is rendered from the
  // record, as `render` prints it, and the plan's steps stay theirs.
  test("a contract left out of date by a setting the person changed is rendered again from the record", () => {
    const proj = project();
    writePlan(proj);
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace("- **Test Strategy**: Standard", "- **Test Strategy**: Comprehensive"));
    const fresh = contract(proj);
    expect(fresh).toContain('"test_strategy": "comprehensive"');
    expect(planText(proj)).not.toContain(fresh);
    expect(next(proj).kind).toBe("ask");
    expect(planText(proj)).toBe(STEPS + fresh);
  });

  // Every other byte is the agent's: the section is found as the plan's
  // contract is read (fences tracked, the first heading), and a plan with none
  // gets it at the end. replaceTestingContractSection keeps one blank line
  // before the section and ends the file with one newline.
  test.each([
    [
      "a second Testing Contract heading after another section stays",
      (rendered: string) => `${STEPS}${rendered.replace(/("version": )1/, "$1 1,,")}\n## Notes\n\nkeep me\n\n## Testing Contract\n\nan older copy\n`,
      (rendered: string) => `${STEPS}${rendered}\n## Notes\n\nkeep me\n\n## Testing Contract\n\nan older copy\n`,
    ],
    [
      "a heading quoted inside a code fence stays, and the section goes at the end",
      () => `${STEPS}\`\`\`md\n## Testing Contract\n\`\`\`\n`,
      (rendered: string) => `${STEPS}\`\`\`md\n## Testing Contract\n\`\`\`\n\n${rendered}`,
    ],
    [
      "CRLF line ends stay CRLF",
      () => STEPS.replace(/\n/g, "\r\n"),
      (rendered: string) => `${STEPS}${rendered}`.replace(/\n/g, "\r\n"),
    ],
    [
      "a plan with no trailing newline gets one",
      () => STEPS.trimEnd(),
      (rendered: string) => `${STEPS}${rendered}`,
    ],
  ] as const)("only the Testing Contract section is written: %s", (_label, plan, expected) => {
    const proj = project();
    writePlan(proj);
    writeFileSync(planPath(proj), plan(contract(proj)), "utf-8");
    const asked = next(proj);
    expect(asked.kind, JSON.stringify(asked)).toBe("ask");
    expect(planText(proj)).toBe(expected(contract(proj)));
  });

  test.each([...POLICIES])("under Guard Policy %s the same", (policy) => {
    const proj = policyProject(policy);
    agentPlan(proj, () => "");
    const asked = next(proj);
    expect(asked.kind, JSON.stringify(asked)).toBe("ask");
    expect(planText(proj)).toBe(STEPS + contract(proj));
  });

  test("with plan approval off the plan is built with the contract the engine wrote", () => {
    const proj = project("relaxed", "off");
    agentPlan(proj, () => "");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    expect(planText(proj)).toBe(STEPS + contract(proj));
  });

  // While the person edits the files the engine writes nothing under them; once
  // they say done it writes the contract their edit broke and asks once.
  test("while the person edits the files the plan is theirs", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    const theirs = planText(proj).replace('"version": 1', '"version": 1,,');
    writeFileSync(planPath(proj), theirs, "utf-8");
    const editing = next(proj);
    expect(editing.kind, JSON.stringify(editing)).toBe("ask");
    expect(editing.plan_approval.editing).toBe(true);
    expect(planText(proj)).toBe(theirs);
  });

  // After the question is put, a `next` that finds the block broken or out of
  // date writes it and shows the question again over the plan as written: the
  // question's record takes the new file, so an answer covers what was shown,
  // and nothing outside the section changes.
  test.each(POLICIES.flatMap((policy) => [[policy, "broken"], [policy, "out of date"]] as const))(
    "under %s, a question already put whose contract is then %s is shown again over the plan the engine wrote",
    (policy, how) => {
      const proj = policyProject(policy);
      askFor(proj);
      const shown = questions(proj);
      if (how === "broken") breakBlock(proj);
      else moveContract(proj);
      const again = next(proj);
      expect(again.kind, JSON.stringify(again)).toBe("ask");
      expect(again.ask_type).toBe("plan-approval");
      expect(planText(proj)).toBe(STEPS + contract(proj));
      // Broken with nothing moved, the block written back is the one shown: the
      // same question over the same file. Moved, the question takes the new file.
      if (how === "broken") expect(questions(proj)).toBe(shown);
      else expect(questions(proj)).not.toBe(shown);
      replyAndRecord(proj, "1", "Approve Plan");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval?.status).toBe("approved");
      expect(planText(proj)).toBe(STEPS + contract(proj));
    },
  );

  // The person's own note under the heading, written while they edit the
  // files: with the block intact nothing is written and the note stays.
  test("their own note beside the intact block stays, and their approval records the plan with it", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    const theirs = `${planText(proj)}\nMy note: keep the slugify tests short.\n`;
    writeFileSync(planPath(proj), theirs, "utf-8");
    reply(proj, "done");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.recorded).toBe("approve");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(planText(proj)).toBe(theirs);
  });

  // Their note in the block's place, or beside a block their edit broke: the
  // engine writes the block back and keeps their words after it, in the same
  // section, and the question says it repaired the contract of their edited plan.
  test.each([
    ["in the block's place", () => `${STEPS}## Testing Contract\n\nMy note: use TDD for this one.\n`, "My note: use TDD for this one."],
    ["beside a block their edit broke", (plan: string) =>
      `${plan.replace('"version": 1', '"version": 1,,')}\nMy note: keep the slugify tests short.\n`, "My note: keep the slugify tests short."],
  ] as const)("their own note %s is kept after the block the engine writes back", (_label, edit, note) => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    writeFileSync(planPath(proj), edit(planText(proj)), "utf-8");
    reply(proj, "done");
    expect(answer(proj, "Approve Plan").message).toContain("broke the Testing Contract block");
    const asked = next(proj);
    expect(asked.kind, JSON.stringify(asked)).toBe("ask");
    expect(asked.question).toBe("I repaired the plan's Testing Contract (the test rules your build follows). Build your edited plan?");
    const written = `${STEPS}${contract(proj)}\n${note}\n`;
    expect(planText(proj)).toBe(written);
    // Read as current: no second write.
    expect(next(proj).kind).toBe("ask");
    expect(planText(proj)).toBe(written);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(planText(proj)).toBe(written);
  });

  // Their note beside an intact block that a setting left out of date while
  // they edited: their approval renders the section again and keeps the note.
  test("their own note beside a block a setting left out of date is kept when their approval renders it again", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    writeFileSync(planPath(proj), `${planText(proj)}\nMy note: keep the slugify tests short.\n`, "utf-8");
    // A setting changed while they edit; the question stays open over the state write.
    const state = seededStateFile(proj);
    const before = readFileSync(state, "utf-8");
    moveContract(proj);
    expect(keepPlanApprovalAskOverStateWrite(proj, before, readFileSync(state, "utf-8"))).toBe(true);
    reply(proj, "done");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain("was rendered again");
    expect(planText(proj)).toBe(`${STEPS}${contract(proj)}\nMy note: keep the slugify tests short.\n`);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // A plan sent back waits for its change: the engine never makes it read as
  // revised. A stale contract on it is left alone; a broken one is written
  // back, and the plan is still the one they sent back.
  test.each([
    ["left out of date by a setting", (proj: string) => {
      const state = seededStateFile(proj);
      writeFileSync(state, readFileSync(state, "utf-8").replace("- **Test Strategy**: Standard", "- **Test Strategy**: Comprehensive"));
    }, false],
    ["broken by a save", (proj: string) => {
      writeFileSync(planPath(proj), planText(proj).replace('"version": 1', '"version": 1,,'), "utf-8");
    }, true],
  ] as const)("a plan sent back with Request Changes and its contract %s still waits for its change", (_label, change, written) => {
    const proj = project();
    askFor(proj);
    const sentBack = planText(proj);
    reply(proj, "use a lookup table");
    expect(answer(proj, "Request Changes: use a lookup table").code).toBe(0);
    change(proj);
    const before = planText(proj);
    for (let round = 0; round < 2; round++) {
      expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "use a lookup table" });
      expect(planText(proj)).toBe(written ? sentBack : before);
    }
  });

  // After an approval a broken contract stops the build under every Guard
  // Policy, and the block is the engine's to put back: it writes back the block
  // that was approved, so the approval holds and the build goes on.
  test.each([...POLICIES])("under %s an approved plan whose contract later broke is written back and still builds", (policy) => {
    const proj = policyProject(policy);
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    const approved = planText(proj);
    writeFileSync(planPath(proj), approved.replace('"version": 1', '"version": 1,,'), "utf-8");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(planText(proj)).toBe(approved);
  });

  // A contract a setting moved after the approval, its block intact: under
  // relaxed and off the approved plan builds and is not written; under strict
  // the engine writes the moved block once and asks once.
  test.each(["relaxed", "off"] as const)("under %s an approved plan whose contract a setting moved builds and is not written", (policy) => {
    const proj = policyProject(policy);
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    const approved = planText(proj);
    moveContract(proj);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    expect(planText(proj)).toBe(approved);
  });

  test.each(["strict", "locked strict"] as const)("under %s an approved plan whose contract a setting moved is written once and asked about once", (policy) => {
    const proj = policyProject(policy);
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    moveContract(proj);
    const asked = next(proj);
    expect(asked.kind, JSON.stringify(asked)).toBe("ask");
    expect(planText(proj)).toBe(STEPS + contract(proj));
    // The line that says what changed since they approved, said with the question.
    expect(asked.plan_approval.note, JSON.stringify(asked)).toContain("Your approved plan changed before the build");
    const again = next(proj);
    expect(again.kind, JSON.stringify(again)).toBe("ask");
    expect(again.question).toBe(asked.question);
    expect(again.plan_approval.note).toBe(asked.plan_approval.note);
    expect(planText(proj)).toBe(STEPS + contract(proj));
  });

  // A plan sent back at the gate waits for its change too: a contract moved
  // since its approval is not written over it, so it still reads as the plan
  // they sent back and their words reach the revision.
  test.each([["strict", "moved"], ["relaxed", "moved"], ["strict", "broken"], ["relaxed", "broken"]] as const)(
    "under %s a plan sent back at the gate with its contract %s is revised with their words first",
    (policy, how) => {
      const proj = project(policy);
      askFor(proj);
      replyAndRecord(proj, "1", "Approve Plan");
      expect(next(proj).plan_approval).toEqual({ status: "approved" });
      appendAuditEntry("GATE_REJECTED", {
        Stage: "code-generation", "User Input": "Request Changes", Feedback: "log every slug",
      }, proj);
      const sentBack = planText(proj);
      if (how === "moved") moveContract(proj);
      else breakBlock(proj);
      expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "log every slug" });
      // Moved: not written. Broken: written back to the block it was sent back with.
      expect(planText(proj)).toBe(sentBack);
    },
  );

  // The section is the block's: what an agent wrote there instead (a summary
  // of the contract, as an agent wrote in a live run, or a note after a bad
  // copy) is written over.
  test.each([
    ["a summary of the contract in the agent's words", () =>
      `${STEPS}## Testing Contract\n\n- **Methodology:** test-after\n- **Test strategy:** Minimal\n` +
        "- **Contract hash:** `sha256:8b88443a8c617567a1344d4ec2a14fc8e4e0abe702a4048e68bc207a690b0910`\n"],
    ["a note after a broken copy", (rendered: string) =>
      `${STEPS}${rendered.replace('"version": 1', '"version": 1,,')}\nThe contract above sets the test order.\n`],
  ] as const)("a Testing Contract section holding %s is written over", (_label, plan) => {
    const proj = project();
    writePlan(proj);
    writeFileSync(planPath(proj), plan(contract(proj)), "utf-8");
    expect(next(proj).kind).toBe("ask");
    expect(planText(proj)).toBe(STEPS + contract(proj));
  });

  // A heading or a plan step in the section belongs to the plan (a block whose
  // closing fence is gone runs the section on over them), and a plan that did
  // not read as UTF-8 text would be garbled by a write: the plan step names the
  // repair, as before, and the file is left as it is.
  test.each([
    ["a plan step under the heading", () => `${STEPS}## Testing Contract\n\n- [ ] Step 2: run the tests\n`],
    ["a block whose closing fence is gone, with the plan's steps after it", (rendered: string) =>
      `${STEPS}${rendered.replace(/```\n$/, "").replace('"version": 1', '"version": 1,,')}\n### Step 2\n\n- [ ] Step 2: handle unicode\n`],
  ] as const)("a Testing Contract section holding %s is not written", (_label, plan) => {
    const proj = project();
    writePlan(proj);
    const theirs = plan(contract(proj));
    writeFileSync(planPath(proj), theirs, "utf-8");
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.plan_approval?.status).toBe("plan");
    expect(step.plan_approval?.note).toContain("Testing Contract");
    expect(planText(proj)).toBe(theirs);
  });

  test("a plan saved as UTF-16 (Windows PowerShell 5.1's own redirect) is not written back", () => {
    const proj = project();
    writePlan(proj);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(STEPS, "utf16le")]);
    writeFileSync(planPath(proj), utf16);
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.plan_approval?.status).toBe("plan");
    expect(readFileSync(planPath(proj)).equals(utf16)).toBe(true);
  });

  // The Stop hook's own `next` is a read-only probe: it reads the plan as it
  // stands and writes nothing; the agent's `next` writes the block and asks.
  test("the Stop hook's read-only probe writes nothing, and the next `next` writes the contract", () => {
    const proj = project();
    agentPlan(proj, () => "");
    const probe = runOrchestrateNext(ORCHESTRATE, proj, [], {
      env: { ...process.env, AIDLC_UNATTENDED: "0", AIDLC_STOP_HOOK_PROBE: "1" },
    });
    expect(probe.status, probe.out).toBe(0);
    expect((probe.directive as unknown as Emitted | null)?.kind, probe.out).toBe("run-stage");
    expect(planText(proj)).toBe(STEPS);
    expect(next(proj).kind).toBe("ask");
    expect(planText(proj)).toBe(STEPS + contract(proj));
  });

  test("a group of Units: each plan gets its own contract and one question asks about all", () => {
    const pd = swarmFixture(false);
    for (const unit of GROUP) {
      const dir = codeGenerationRecordDir(pd, unit);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "code-generation-plan.md"), `# Plan for ${unit}\n\n## Summary\n\n- Builds: ${unit}\n\n## Steps\n- [ ] Implement ${unit}\n`, "utf-8");
      writeFileSync(join(dir, "unit-test-instructions.md"), `# Tests\n\nRun ${unit} tests.\n`, "utf-8");
    }
    const ask = swarmState(pd);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    for (const unit of GROUP) {
      expect(readFileSync(join(codeGenerationRecordDir(pd, unit), "code-generation-plan.md"), "utf-8"))
        .toBe(`# Plan for ${unit}\n\n## Summary\n\n- Builds: ${unit}\n\n## Steps\n- [ ] Implement ${unit}\n\n${contract(pd)}`);
    }
  });
});

// After a git pull, the files a teammate's commit brought are not something
// that ran ahead of the plan: the project is a clone whose branch tracks a
// branch of a team remote (a bare repository here), and a teammate pushes to it.
describe("the plan question after a git pull", () => {
  function gitIn(dir: string, args: string[]): string {
    const run = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], {
      cwd: dir, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@test" },
    });
    expect(run.status, `git ${args.join(" ")}: ${run.stdout}${run.stderr}`).toBe(0);
    return run.stdout;
  }

  function writeFiles(dir: string, files: Record<string, string>): void {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body, "utf-8");
    }
  }

  // A repository with `files`, pushed to a new bare remote its branch tracks; the remote's path.
  function published(dir: string, files: Record<string, string>): string {
    writeFiles(dir, files);
    gitIn(dir, ["init", "-q"]);
    gitIn(dir, ["add", "--", ...Object.keys(files)]);
    gitIn(dir, ["commit", "-qm", "the shop"]);
    const remote = `${dir}-origin.git`;
    created.push(remote);
    gitIn(dir, ["init", "-q", "--bare", remote]);
    gitIn(dir, ["remote", "add", "origin", remote]);
    gitIn(dir, ["push", "-q", "-u", "origin", "HEAD"]);
    return remote;
  }

  // A teammate's clone of `remote`.
  function teammate(dir: string, remote: string): string {
    const mate = `${dir}-mate`;
    created.push(mate);
    gitIn(dir, ["clone", "-q", "-b", gitIn(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), remote, mate]);
    return mate;
  }

  const SHOP = {
    "README.md": "# shop\n",
    "run.sh": "echo run\n",
    "web/app.js": "render();\n",
    "web/index.html": "<html></html>\n",
    "web/styles.css": "body {}\n",
  };

  // The project at Code Generation's start as a clone of the team's repository, and a teammate's clone.
  function teamProject(): { proj: string; mate: string } {
    const proj = project();
    const remote = published(proj, SHOP);
    const mate = teammate(proj, remote);
    const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
    return { proj, mate };
  }

  const alreadyChanged = (asked: Emitted): string[] =>
    (asked.plan_approval.targets?.[0].summary ?? []).filter((line) => line.startsWith("Already changed"));

  test("a teammate's move of web/ and README change, pulled before the question, are not named", () => {
    const { proj, mate } = teamProject();
    gitIn(mate, ["rm", "-q", "-r", "--", "web"]);
    writeFiles(mate, { "README.md": "# shop\n\nThe web page now lives in its own repository.\n" });
    gitIn(mate, ["commit", "-qam", "move web out"]);
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  test("where git keeps no executable bit, a teammate's change of a file's mode alone, pulled, is not named", () => {
    const { proj, mate } = teamProject();
    gitIn(proj, ["config", "core.fileMode", "false"]);
    gitIn(mate, ["update-index", "--chmod=+x", "run.sh"]);
    gitIn(mate, ["commit", "-qm", "run.sh is executable"]);
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  test("a teammate's change of a file's mode alone, pulled, is not named", () => {
    const { proj, mate } = teamProject();
    gitIn(mate, ["update-index", "--chmod=+x", "run.sh"]);
    gitIn(mate, ["commit", "-qm", "run.sh is executable"]);
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  test("where git keeps no executable bit, a teammate's change to a script git holds as executable, pulled, is not named", () => {
    const { proj, mate } = teamProject();
    // Git for Windows sets this at every clone; a Windows drive under WSL too.
    gitIn(proj, ["config", "core.fileMode", "false"]);
    writeFiles(mate, { "run.sh": "echo run\necho done\n" });
    chmodSync(join(mate, "run.sh"), 0o755);
    gitIn(mate, ["add", "--", "run.sh"]);
    gitIn(mate, ["update-index", "--chmod=+x", "run.sh"]);
    gitIn(mate, ["commit", "-qm", "run.sh is executable and says done"]);
    expect(gitIn(mate, ["ls-tree", "HEAD", "--", "run.sh"])).toStartWith("100755 ");
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    // As such a folder reads it: no executable bit.
    chmodSync(join(proj, "run.sh"), 0o644);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  test("a teammate's change to a script git held as executable from the start, pulled, is not named", () => {
    const proj = project();
    writeFiles(proj, SHOP);
    gitIn(proj, ["init", "-q"]);
    chmodSync(join(proj, "run.sh"), 0o755);
    gitIn(proj, ["add", "--", ...Object.keys(SHOP)]);
    gitIn(proj, ["update-index", "--chmod=+x", "run.sh"]);
    gitIn(proj, ["commit", "-qm", "the shop"]);
    const remote = `${proj}-origin.git`;
    created.push(remote);
    gitIn(proj, ["init", "-q", "--bare", remote]);
    gitIn(proj, ["remote", "add", "origin", remote]);
    gitIn(proj, ["push", "-q", "-u", "origin", "HEAD"]);
    const mate = teammate(proj, remote);
    const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
    writeFiles(mate, { "run.sh": "echo run\necho done\n" });
    gitIn(mate, ["add", "--", "run.sh"]);
    gitIn(mate, ["update-index", "--chmod=+x", "run.sh"]);
    gitIn(mate, ["commit", "-qm", "run.sh says done"]);
    expect(gitIn(mate, ["ls-tree", "HEAD", "--", "run.sh"])).toStartWith("100755 ");
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  test("a checkout recorded after the start, as its own remote holds it, is not named; a file the build then changes in it is", () => {
    const { proj } = teamProject();
    const parent = mkdtempSync(join(tmpdir(), "plan-gate-checkout-"));
    created.push(parent);
    const web = join(parent, "shop-web");
    mkdirSync(web, { recursive: true });
    published(web, { "app.js": "render();\n", "index.html": "<html></html>\n" });
    const added = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "intent", "add-checkout", web, "--project-dir", proj], {
      cwd: proj, encoding: "utf-8", env: { ...process.env, AIDLC_PROJECT_DIR: proj },
    });
    expect(added.status, `${added.stdout}${added.stderr}`).toBe(0);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
    writeFileSync(join(web, "app.js"), "render(wishlist);\n", "utf-8");
    expect(alreadyChanged(next(proj))).toEqual(["Already changed before you approved: shop-web@checkout/app.js."]);
  });

  test("asking about a checkout recorded outside the project writes nothing in that checkout's git", () => {
    const { proj } = teamProject();
    const parent = mkdtempSync(join(tmpdir(), "plan-gate-checkout-"));
    created.push(parent);
    const web = join(parent, "shop-web");
    mkdirSync(web, { recursive: true });
    published(web, { "app.js": "render();\n", "index.html": "<html></html>\n" });
    const added = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "intent", "add-checkout", web, "--project-dir", proj], {
      cwd: proj, encoding: "utf-8", env: { ...process.env, AIDLC_PROJECT_DIR: proj },
    });
    expect(added.status, `${added.stdout}${added.stderr}`).toBe(0);
    // A file saved again unchanged: git's record of it is out of date, and reading it must not rewrite that record.
    utimesSync(join(web, "index.html"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    const index = (): string => createHash("sha256").update(readFileSync(join(web, ".git", "index"))).digest("hex");
    const before = index();
    askFor(proj);
    expect(index()).toBe(before);
  });

  test("a teammate's submodule in place of web/, pulled, is not named before or after it is checked out", () => {
    const { proj, mate } = teamProject();
    const parent = mkdtempSync(join(tmpdir(), "plan-gate-submodule-"));
    created.push(parent);
    const web = join(parent, "shop-web");
    mkdirSync(web, { recursive: true });
    const webRemote = published(web, { "app.js": "render();\n", "index.html": "<html></html>\n", "styles.css": "body {}\n" });
    gitIn(mate, ["rm", "-q", "-r", "--", "web"]);
    gitIn(mate, ["submodule", "add", "-q", webRemote, "web"]);
    gitIn(mate, ["commit", "-qm", "web as a submodule"]);
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
    gitIn(proj, ["submodule", "update", "-q", "--init"]);
    expect(alreadyChanged(next(proj))).toEqual([]);
  });

  test("a file the build deletes inside a submodule that took the place of web/, pulled and updated, is named", () => {
    const { proj, mate } = teamProject();
    const parent = mkdtempSync(join(tmpdir(), "plan-gate-submodule-"));
    created.push(parent);
    const web = join(parent, "shop-web");
    mkdirSync(web, { recursive: true });
    const webRemote = published(web, { "app.js": "render();\n", "index.html": "<html></html>\n", "styles.css": "body {}\n" });
    gitIn(mate, ["rm", "-q", "-r", "--", "web"]);
    gitIn(mate, ["submodule", "add", "-q", webRemote, "web"]);
    gitIn(mate, ["commit", "-qm", "web as a submodule"]);
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    gitIn(proj, ["submodule", "update", "-q", "--init"]);
    rmSync(join(proj, "web", "app.js"));
    expect(alreadyChanged(askFor(proj))).toEqual(["Already changed before you approved: web/app.js."]);
  });

  test("a teammate's submodule in place of web/ without one of its files, pulled and updated, is not named", () => {
    const { proj, mate } = teamProject();
    const parent = mkdtempSync(join(tmpdir(), "plan-gate-submodule-"));
    created.push(parent);
    const web = join(parent, "shop-web");
    mkdirSync(web, { recursive: true });
    const webRemote = published(web, { "app.js": "render();\n", "index.html": "<html></html>\n" });
    gitIn(mate, ["rm", "-q", "-r", "--", "web"]);
    gitIn(mate, ["submodule", "add", "-q", webRemote, "web"]);
    gitIn(mate, ["commit", "-qm", "web as a submodule"]);
    gitIn(mate, ["push", "-q"]);
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    gitIn(proj, ["submodule", "update", "-q", "--init"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  // The shop keeps web as a submodule with its own team remote; a teammate's clone has it checked out.
  function submoduleProject(checkedOut = true): { proj: string; mate: string } {
    const proj = project();
    const parent = mkdtempSync(join(tmpdir(), "plan-gate-submodule-"));
    created.push(parent);
    const web = join(parent, "shop-web");
    mkdirSync(web, { recursive: true });
    const webRemote = published(web, { "app.js": "render();\n", "index.html": "<html></html>\n", "README.md": "# web\n" });
    writeFiles(proj, { "README.md": "# shop\n" });
    gitIn(proj, ["init", "-q"]);
    gitIn(proj, ["submodule", "add", "-q", webRemote, "web"]);
    gitIn(proj, ["add", "--", "README.md"]);
    gitIn(proj, ["commit", "-qm", "the shop"]);
    const remote = `${proj}-origin.git`;
    created.push(remote);
    gitIn(proj, ["init", "-q", "--bare", remote]);
    gitIn(proj, ["remote", "add", "origin", remote]);
    gitIn(proj, ["push", "-q", "-u", "origin", "HEAD"]);
    const mate = teammate(proj, remote);
    gitIn(mate, ["submodule", "update", "-q", "--init"]);
    if (!checkedOut) gitIn(proj, ["submodule", "deinit", "-q", "-f", "--", "web"]);
    const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
    return { proj, mate };
  }

  // A teammate's commit in web, pushed to web's own remote, and the shop's pointer moved to it and pushed.
  function teammateMovesWeb(mate: string, files: Record<string, string>): void {
    const web = join(mate, "web");
    writeFiles(web, files);
    gitIn(web, ["commit", "-qam", "the wishlist"]);
    const branch = gitIn(web, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim().replace(/^origin\//, "");
    gitIn(web, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    gitIn(mate, ["add", "--", "web"]);
    gitIn(mate, ["commit", "-qm", "web moved on"]);
    gitIn(mate, ["push", "-q"]);
  }

  test("a teammate's move of the web submodule, pulled and updated, is not named, and asking writes nothing in its git", () => {
    const { proj, mate } = submoduleProject();
    teammateMovesWeb(mate, { "app.js": "render(wishlist);\n", "README.md": "# web\n\nA wishlist.\n" });
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
    gitIn(proj, ["submodule", "update", "-q"]);
    // A file saved again unchanged: git's record of it is out of date, and reading it must not rewrite that record.
    utimesSync(join(proj, "web", "index.html"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    const indexFile = gitIn(join(proj, "web"), ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
    const index = (): string => createHash("sha256").update(readFileSync(indexFile)).digest("hex");
    const before = index();
    expect(alreadyChanged(next(proj))).toEqual([]);
    expect(index()).toBe(before);
  });

  test("where git is set to leave the web submodule out of its diffs, a teammate's move, pulled and updated, is not named", () => {
    const { proj, mate } = submoduleProject();
    teammateMovesWeb(mate, { "app.js": "render(wishlist);\n" });
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    gitIn(proj, ["submodule", "update", "-q"]);
    gitIn(proj, ["config", "submodule.web.ignore", "all"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  test("a web submodule not checked out when the work started, checked out during it, is not named", () => {
    const { proj } = submoduleProject(false);
    gitIn(proj, ["submodule", "update", "-q", "--init"]);
    expect(alreadyChanged(askFor(proj))).toEqual([]);
  });

  test("beside a teammate's move of the web submodule, the build's own change inside it is named", () => {
    const { proj, mate } = submoduleProject();
    teammateMovesWeb(mate, { "app.js": "render(wishlist);\n" });
    gitIn(proj, ["pull", "-q", "--no-rebase"]);
    gitIn(proj, ["submodule", "update", "-q"]);
    writeFiles(proj, { "web/index.html": "<html><body></body></html>\n" });
    expect(alreadyChanged(askFor(proj))).toEqual(["Already changed before you approved: web/index.html."]);
  });

  test("a web submodule checked out at another commit than the shop's remote branch records is named as before", () => {
    const { proj, mate } = submoduleProject();
    teammateMovesWeb(mate, { "app.js": "render(wishlist);\n" });
    // The person moves web on themselves, with no pull of the shop.
    gitIn(join(proj, "web"), ["fetch", "-q"]);
    gitIn(join(proj, "web"), ["checkout", "-q", "origin/HEAD"]);
    expect(alreadyChanged(askFor(proj))).toEqual(["Already changed before you approved (2 files): web, web/app.js."]);
  });
});
